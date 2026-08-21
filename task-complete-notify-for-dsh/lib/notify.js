/**
 * task-complete-notify-for-dsh — notification + chime primitives.
 *
 * Cross-platform desktop notification with a chime, fire-and-forget (never
 * blocks the harness event loop). Ported from the Pi extension's notify logic,
 * with a platform command table added for macOS / Windows in addition to Linux.
 *
 * Linux chime uses a bundled prompt-tone via an auto-detected player
 * (mpv → ffplay → pw-play → cvlc → paplay), exactly like the Pi extension.
 * macOS / Windows embed the sound in the notification command itself.
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

// Chime bundled with the plugin (distributed in lib/assets).
export const CHIME = path.join(here, 'assets', 'prompt-tone.mp3')

// Player priority list per platform, most preferred first. Each platform tries
// its own list so the custom chime (a bundled / user-replaced mp3) works
// everywhere — falling back to the system sound only when NO player exists.
//
//   Linux:   mpv → ffplay → pw-play → cvlc → paplay
//   macOS:   afplay (built-in, plays mp3 natively) → mpv → ffplay → cvlc → mpg123
//   Windows: mpv → ffplay → mplayer → mpg123 → cvlc
const PLAYERS = {
  linux: [
    { cmd: 'mpv', args: ['--no-video', '--no-terminal', '--volume=80'] },
    { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', '80'] },
    { cmd: 'pw-play', args: ['--volume=0.8'] },
    { cmd: 'cvlc', args: ['--play-and-exit', '--no-osd', '--volume', '204'] },
    { cmd: 'paplay', args: [] },
  ],
  darwin: [
    { cmd: 'afplay', args: [] },
    { cmd: 'mpv', args: ['--no-video', '--no-terminal', '--volume=80'] },
    { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', '80'] },
    { cmd: 'cvlc', args: ['--play-and-exit', '--no-osd', '--volume', '204'] },
    { cmd: 'mpg123', args: [] },
  ],
  win32: [
    { cmd: 'mpv', args: ['--no-video', '--no-terminal', '--volume=80'] },
    { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', '80'] },
    { cmd: 'mplayer', args: ['-really-quiet', '-volume', '80'] },
    { cmd: 'mpg123', args: [] },
    { cmd: 'cvlc', args: ['--play-and-exit', '--no-osd', '--volume', '204'] },
  ],
}

// Cache per-platform detection results (keyed by the resolved player cmd).
const cachedPlayer = {}

/**
 * The candidate player list for a platform (most preferred first). Exported
 * for testing; also used by {@link detectPlayer}.
 */
export function playersFor(platform) {
  return PLAYERS[platform] || []
}

/** Find the first available player for the current platform, if any. */
function detectPlayer() {
  const platform = process.platform
  const list = playersFor(platform)
  for (const player of list) {
    // macOS/Linux use `which`; Windows uses `where`.
    const finder = platform === 'win32' ? 'where' : 'which'
    const result = spawnSync(finder, [player.cmd], { stdio: 'ignore' })
    if (result.status === 0) {
      cachedPlayer[platform] = player
      return player
    }
  }
  return null
}

/** Escape a string for a double-quoted AppleScript literal. */
function escapeAppleScript(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
}

/** Escape a string for a single-quoted PowerShell literal. */
function escapePowerShell(value) {
  return value.replace(/'/g, "''")
}

/**
 * Play the custom chime in the background, non-blocking. Used on ALL
 * platforms: the plugin's essence is a replaceable audio file, so we prefer a
 * detected player everywhere and only fall back to the platform system sound
 * (in notify) when no player is available.
 * @param env - the environment for the spawned player.
 * @param file - absolute path to the audio file to play (defaults to the
 *   bundled prompt-tone.mp3).
 * @returns true if a player was found and spawned; false otherwise.
 */
function playChime(env, file = CHIME) {
  const player = detectPlayer()
  if (!player) return false
  const child = spawn(player.cmd, [...player.args, file], { env, stdio: 'ignore', detached: true })
  child.unref()
  return true
}

/**
 * Send a desktop notification + chime. Fire-and-forget: failures never throw.
 * @param title - notification title.
 * @param message - notification body.
 * @param severity - 'normal' | 'critical' (critical = urgent/attention).
 * @param withSound - whether to play a chime.
 * @param chimeFile - optional absolute path to a custom audio file; overrides
 *   the bundled prompt-tone.mp3 when provided (and exists).
 */
export function notify(title, message, severity = 'normal', withSound = true, chimeFile) {
  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':0',
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0',
  }

  const platform = process.platform
  // Resolve the chime file: the user override when given and present, else the
  // bundled default.
  const chimeFileFor = withSound ? (chimeFile && existsSync(chimeFile) ? chimeFile : CHIME) : null
  try {
    if (platform === 'linux') {
      execFile('notify-send', ['-u', severity, title, message, '-t', '5000'], { env }, () => {})
      if (chimeFileFor && !playChime(env, chimeFileFor)) {
        // No player available — Linux has no embedded system sound, so just
        // show the notification.
      }
    } else if (platform === 'darwin') {
      // Prefer the custom chime; fall back to the system Glass sound only if
      // no player exists (afplay is built into macOS, so this rarely happens).
      const played = chimeFileFor ? playChime(env, chimeFileFor) : false
      const sound = withSound && !played ? ' sound name "Glass"' : ''
      execFile('osascript', ['-e', `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"${sound}`], { env }, () => {})
    } else if (platform === 'win32') {
      // Prefer the custom chime; fall back to SystemSounds only if no player
      // exists. (Windows has no built-in mp3 player — PowerShell's
      // SoundPlayer only plays .wav — so detection here is what enables the
      // custom chime on Windows.)
      const played = chimeFileFor ? playChime(env, chimeFileFor) : false
      const sound = withSound && !played ? '[System.Media.SystemSounds]::Asterisk.Play(); ' : ''
      execFile('powershell', ['-NoProfile', '-Command', `${sound}$ws = New-Object -ComObject WScript.Shell; $ws.Popup('${escapePowerShell(message)}', 5, '${escapePowerShell(title)}', 64)`], { env }, () => {})
    }
  } catch {
    // Notification failures must never break the run that reported on.
  }
}
