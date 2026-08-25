/**
 * task-complete-notify-for-dsh — notification + chime primitives.
 *
 * Cross-platform desktop notification with a chime, fire-and-forget (never
 * blocks the harness event loop). Ported from the Pi extension's notify logic,
 * with a platform command table added for macOS / Windows in addition to Linux.
 *
 * Robustness notes:
 *  - All failures are reported through an optional `logger` (warn level);
 *    nothing ever throws into the caller.
 *  - Linux display environment (DISPLAY / WAYLAND_DISPLAY) is probed from the
 *    actual session sockets (/tmp/.X11-unix, XDG_RUNTIME_DIR wayland-*) instead
 *    of hardcoding ':0'/'wayland-0' — important under systemd user services.
 *  - Windows sends a real WinRT Toast (non-focus-stealing); WScript.Popup is
 *    only a fallback if the Toast fails. macOS keeps osascript.
 *
 * Testability: all child-process / fs effects go through the module-level `io`
 * seam (see _setIo), and sendNotification() takes an explicit platform, so the
 * per-platform command construction is unit-testable without mocking globals.
 */
import * as cp from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

// Chime bundled with the plugin (distributed in lib/assets).
export const CHIME = path.join(here, 'assets', 'prompt-tone.mp3')

// Dependency injection seam — swapped by tests (_setIo). Never call cp.* or
// fs.* directly below; always through `io`.
const io = {
  execFile: (...args) => cp.execFile(...args),
  spawn: (...args) => cp.spawn(...args),
  spawnSync: (...args) => cp.spawnSync(...args),
  existsSync: (p) => existsSync(p),
}

/** Swap the io seam (tests only). Returns a restore function. */
export function _setIo(mock) {
  const prev = { ...io }
  Object.assign(io, mock)
  return () => Object.assign(io, prev)
}

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

// Cache per-platform detection results (keyed by platform).
const cachedPlayer = {}

/**
 * The candidate player list for a platform (most preferred first). Exported
 * for testing; also used by {@link detectPlayer}.
 */
export function playersFor(platform) {
  return PLAYERS[platform] || []
}

/** Find the first available player for the given platform, if any. */
function detectPlayer(platform) {
  if (cachedPlayer[platform]) return cachedPlayer[platform]
  const finder = platform === 'win32' ? 'where' : 'which'
  for (const player of playersFor(platform)) {
    const result = io.spawnSync(finder, [player.cmd], { stdio: 'ignore' })
    if (result.status === 0) {
      cachedPlayer[platform] = player
      return player
    }
  }
  return null
}

/**
 * Probe the local graphical session for display env vars, without hardcoding.
 * Wayland: first `wayland-N` socket in XDG_RUNTIME_DIR (default
 * /run/user/<uid>). X11: first `/tmp/.X11-unix/X<N>` socket → `:N`.
 * Only fills keys that are not already set in process.env.
 * @returns partial env object ({ WAYLAND_DISPLAY?, DISPLAY? }), possibly empty.
 */
export function probeDisplayEnv({ runtimeDir, x11Dir } = {}) {
  const out = {}
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const rd = runtimeDir ?? process.env.XDG_RUNTIME_DIR ?? (uid != null ? `/run/user/${uid}` : null)
  if (!process.env.WAYLAND_DISPLAY && rd) {
    try {
      const wl = readdirSync(rd)
        .filter((n) => /^wayland-\d+$/.test(n))
        .sort()
      if (wl.length > 0) out.WAYLAND_DISPLAY = wl[0]
    } catch {
      // unreadable / absent — leave unset
    }
  }
  if (!process.env.DISPLAY) {
    try {
      const names = readdirSync(x11Dir ?? '/tmp/.X11-unix')
      const nums = names
        .map((n) => /^X(\d+)$/.exec(n)?.[1])
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => a - b)
      if (nums.length > 0) out.DISPLAY = `:${nums[0]}`
    } catch {
      // unreadable / absent — leave unset
    }
  }
  return out
}

/** Build the child-process env for notifiers, filling gaps from session probes. */
function notifierEnv() {
  return {
    ...process.env,
    ...probeDisplayEnv(),
  }
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

/** Escape a string for inclusion in the Toast notification XML template. */
function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Play the custom chime in the background, non-blocking. Used on ALL
 * platforms: the plugin's essence is a replaceable audio file, so we prefer a
 * detected player everywhere and only fall back to the platform system sound
 * (in the notification command) when no player exists.
 * @returns true if a player was found and spawned; false otherwise.
 */
function playChime(env, platform, file = CHIME, warn = () => {}) {
  const player = detectPlayer(platform)
  if (!player) return false
  try {
    const child = io.spawn(player.cmd, [...player.args, file], { env, stdio: 'ignore', detached: true })
    child.unref()
    return true
  } catch (err) {
    warn('chime player "%s" failed to spawn: %s', player.cmd, err?.message ?? err)
    return false
  }
}

/**
 * Send a desktop notification + chime (options object form).
 * Fire-and-forget: never throws. Failures are logged via `logger` when given.
 * @param opts - { title, message, severity='normal', sound=true, chimeFile?,
 *                 logger? } where logger needs only a warn() method.
 */
export function notify(opts) {
  const {
    title,
    message,
    severity = 'normal',
    sound = true,
    chimeFile,
    logger,
  } = typeof opts === 'object' && opts !== null ? opts : {}
  // Failures flow through the injected logger so misconfiguration and delivery
  // problems are diagnosable; nothing ever throws into the caller.
  try {
    sendNotification(process.platform, { title, message, severity, sound, chimeFile, logger })
  } catch (err) {
    logger?.warn?.('notification failed unexpectedly: %s', err?.message ?? err)
  }
}

/**
 * Construct and dispatch the platform notification command. Takes the platform
 * explicitly so each branch is testable. Errors inside are caught at the
 * notify() boundary; async delivery failures are logged, never thrown.
 */
export function sendNotification(platform, opts) {
  const { title, message, severity = 'normal', sound = true, chimeFile, logger } = opts
  const warn = (fmt, ...args) => logger?.warn?.(fmt, ...args)
  const env = notifierEnv()

  // Resolve the chime file: the user override when given and present, else the
  // bundled default.
  const chimeFileFor = sound ? (chimeFile && io.existsSync(chimeFile) ? chimeFile : CHIME) : null
  if (sound && chimeFile && !io.existsSync(chimeFile)) {
    warn('configured chimeFile not found, falling back to bundled default: %s', chimeFile)
  }

  try {
    if (platform === 'linux') {
      io.execFile(
        'notify-send',
        ['-u', severity, String(title), String(message), '-t', '5000'],
        { env },
        (err) => {
          if (err) warn('notify-send failed (%s) — is libnotify installed?', err.code ?? err.message)
        },
      )
      if (chimeFileFor && !playChime(env, platform, chimeFileFor, warn)) {
        warn('no audio player found (mpv/ffplay/pw-play/cvlc/paplay) — playing notification without sound')
      }
    } else if (platform === 'darwin') {
      // Prefer the custom chime; fall back to the system Glass sound only if
      // no player exists (afplay is built into macOS, so this rarely happens).
      const played = chimeFileFor ? playChime(env, platform, chimeFileFor, warn) : false
      if (sound && !played) warn('no audio player found — falling back to system Glass sound')
      const fallbackSound = sound && !played ? ' sound name "Glass"' : ''
      io.execFile(
        'osascript',
        ['-e', `display notification "${escapeAppleScript(String(message))}" with title "${escapeAppleScript(String(title))}"${fallbackSound}`],
        { env },
        (err) => {
          if (err) warn('osascript notification failed: %s', err.message)
        },
      )
    } else if (platform === 'win32') {
      // Prefer the custom chime; fall back to SystemSounds only if no player
      // exists. (Windows has no built-in mp3 player — PowerShell's
      // SoundPlayer only plays .wav.)
      const played = chimeFileFor ? playChime(env, platform, chimeFileFor, warn) : false
      if (sound && !played) warn('no audio player found — falling back to system sounds')

      // Primary path: a real WinRT Toast — appears in Action Center and does
      // NOT steal focus, unlike WScript.Shell.Popup.
      const toastScript =
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; ' +
        '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); ' +
        `$x=$t.GetElementsByTagName('text'); ` +
        `$null=$x.Item(0).AppendChild($t.CreateTextNode('${escapeXml(String(title))}')); ` +
        `$null=$x.Item(1).AppendChild($t.CreateTextNode('${escapeXml(String(message))}')); ` +
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DeepSeek Harness').Show([Windows.UI.Notifications.ToastNotification]::new($t))"
      io.execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', toastScript], { env }, (err) => {
        if (!err) return
        // Fallback only when the Toast genuinely failed (e.g. pre-Win10).
        warn('WinRT toast failed (%s) — falling back to Popup dialog', err.code ?? err.message)
        const sysSound = sound && !played ? '[System.Media.SystemSounds]::Asterisk.Play(); ' : ''
        const popupScript =
          `${sysSound}$ws = New-Object -ComObject WScript.Shell; ` +
          `$ws.Popup('${escapePowerShell(String(message))}', 5, '${escapePowerShell(String(title))}', 64)`
        io.execFile('powershell', ['-NoProfile', '-Command', popupScript], { env }, (err2) => {
          if (err2) warn('PowerShell notification failed: %s', err2.message)
        })
      })
    } else {
      warn('unsupported platform "%s" — no notification sent', platform)
    }
  } catch (err) {
    // Synchronous failures must never break the run that reported on.
    warn('notification dispatch failed: %s', err?.message ?? err)
  }
}
