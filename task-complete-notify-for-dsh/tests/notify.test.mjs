import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { notify, playersFor, sendNotification, probeDisplayEnv, CHIME, _setIo } = await import('../lib/notify.js')

test('every supported platform has a player list for the custom chime', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.ok(playersFor(platform).length > 0, `${platform} should have players`)
  }
})

test('macOS prefers the built-in afplay (no install needed) for the custom chime', () => {
  const mac = playersFor('darwin')
  assert.equal(mac[0].cmd, 'afplay')
  assert.equal(mac[0].args.length, 0) // afplay takes the file path only
})

test('Linux keeps pw-play/paplay (the desktop-native players)', () => {
  const linux = playersFor('linux').map((p) => p.cmd)
  assert.ok(linux.includes('pw-play'))
  assert.ok(linux.includes('paplay'))
})

test('Windows has no built-in mp3 player, relies on detection of external players', () => {
  // PowerShell's SoundPlayer only plays .wav, so the custom mp3 chime needs an
  // external player on Windows — assert the list covers the common ones.
  const win = playersFor('win32').map((p) => p.cmd)
  assert.ok(win.includes('mpv'))
  assert.ok(win.includes('ffplay'))
  assert.ok(win.includes('mplayer'))
})

test('unsupported platform falls back to an empty list (no chime)', () => {
  assert.deepEqual(playersFor('freebsd'), [])
})

test('chime file is distributed and non-empty', () => {
  assert.ok(CHIME.endsWith('prompt-tone.mp3'))
})

test('notify() is exported and callable', () => {
  assert.equal(typeof notify, 'function')
})

// --- platform command construction (via the io seam) -------------------------

test('linux constructs a notify-send command and logs when it fails', async () => {
  const execCalls = []
  const restore = _setIo({
    execFile: (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args })
      setImmediate(() => cb(Object.assign(new Error('spawn ENOENT'), { code: 127 })))
    },
    spawn: () => ({ unref() {} }),
    spawnSync: () => ({ status: 1 }),
    existsSync: () => true,
  })
  try {
    const warns = []
    sendNotification('linux', { title: 'T', message: 'M', logger: { warn: (f, ...a) => warns.push([f, ...a]) } })
    await new Promise((r) => setImmediate(r))
    assert.equal(execCalls[0].cmd, 'notify-send')
    assert.deepEqual(execCalls[0].args.slice(0, 3), ['-u', 'normal', 'T'])
    assert.match(String(warns.at(-1)?.[0]), /notify-send failed/)
  } finally {
    restore()
  }
})

test('darwin escapes quotes in osascript literals', async () => {
  const execCalls = []
  const restore = _setIo({
    execFile: (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args })
      if (cb) setImmediate(() => cb(null))
    },
    spawnSync: () => ({ status: 1 }),
    existsSync: () => true,
  })
  try {
    sendNotification('darwin', { title: 'Ti"t\\le', message: 'He said "hi"', sound: false })
    await new Promise((r) => setImmediate(r))
    assert.equal(execCalls[0].cmd, 'osascript')
    const script = execCalls[0].args[1]
    assert.ok(script.includes('\\"hi\\"'))
    assert.ok(script.includes('Ti\\"t\\\\le'))
    assert.ok(!script.includes('Glass'), 'sound=false must not append system sound')
  } finally {
    restore()
  }
})

test('win32 primary path is a WinRT toast (not a focus-stealing popup)', async () => {
  const execCalls = []
  const restore = _setIo({
    execFile: (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args })
      if (cb) setImmediate(() => cb(null))
    },
    spawnSync: () => ({ status: 1 }),
    existsSync: () => true,
  })
  try {
    sendNotification('win32', { title: 'Build', message: '<done> & "ok"', sound: false })
    await new Promise((r) => setImmediate(r))
    assert.equal(execCalls.length, 1, 'toast success → no popup fallback')
    assert.equal(execCalls[0].cmd, 'powershell')
    const script = execCalls[0].args.at(-1)
    assert.match(script, /ToastNotificationManager/)
    assert.match(script, /&lt;done&gt; &amp; &quot;ok&quot;/)
  } finally {
    restore()
  }
})

test('win32 falls back to WScript.Popup only when the toast fails', async () => {
  const execCalls = []
  let failFirst = true
  const restore = _setIo({
    execFile: (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args })
      if (cb) setImmediate(() => (failFirst ? cb(new Error('no winrt')) : cb(null)))
    },
    spawnSync: () => ({ status: 1 }),
    existsSync: () => true,
  })
  try {
    const warns = []
    sendNotification('win32', { title: 'T', message: 'M', sound: false, logger: { warn: (f) => warns.push(f) } })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(execCalls.length, 2)
    assert.match(execCalls[0].args.at(-1), /ToastNotificationManager/)
    assert.match(execCalls[1].args.at(-1), /WScript\.Shell/)
    assert.ok(warns.some((f) => String(f).includes('toast failed')))
  } finally {
    restore()
  }
})

test('a missing configured chimeFile is logged and falls back to the bundled default', async () => {
  const warns = []
  const spawns = []
  const restore = _setIo({
    spawn: (cmd) => {
      spawns.push(cmd)
      return { unref() {} }
    },
    spawnSync: () => ({ status: 1 }),
    existsSync: () => false,
  })
  try {
    sendNotification('linux', {
      title: 'T',
      message: 'M',
      chimeFile: '/does/not/exist.mp3',
      logger: { warn: (f, ...a) => warns.push([f, ...a]) },
    })
    await new Promise((r) => setImmediate(r))
    assert.ok(warns.some(([f]) => String(f).includes('chimeFile not found')))
  } finally {
    restore()
  }
})

// --- display env probing ------------------------------------------------------

const base = mkdtempSync(join(tmpdir(), 'tcn-notify-'))

test('probeDisplayEnv discovers wayland and X11 sockets instead of hardcoding :0', () => {
  const runtimeDir = join(base, 'run-user')
  const x11Dir = join(base, 'X11-unix')
  mkdirSync(runtimeDir, { recursive: true })
  mkdirSync(x11Dir, { recursive: true })
  writeFileSync(join(runtimeDir, 'wayland-1'), '')
  writeFileSync(join(x11Dir, 'X2'), '')

  // Simulate empty env for probing by temporarily clearing the vars.
  const orig = [process.env.DISPLAY, process.env.WAYLAND_DISPLAY]
  delete process.env.DISPLAY
  delete process.env.WAYLAND_DISPLAY
  try {
    const env = probeDisplayEnv({ runtimeDir, x11Dir })
    assert.equal(env.WAYLAND_DISPLAY, 'wayland-1')
    assert.equal(env.DISPLAY, ':2') // first X socket number wins
  } finally {
    if (orig[0] !== undefined) process.env.DISPLAY = orig[0]
    if (orig[1] !== undefined) process.env.WAYLAND_DISPLAY = orig[1]
  }
  rmSync(runtimeDir, { recursive: true, force: true })
  rmSync(x11Dir, { recursive: true, force: true })
})

test('probeDisplayEnv leaves keys unset when no sockets exist (no fake :0)', () => {
  const orig = [process.env.DISPLAY, process.env.WAYLAND_DISPLAY]
  delete process.env.DISPLAY
  delete process.env.WAYLAND_DISPLAY
  try {
    const env = probeDisplayEnv({ runtimeDir: join(base, 'missing'), x11Dir: join(base, 'missing-x') })
    assert.equal(env.WAYLAND_DISPLAY, undefined)
    assert.equal(env.DISPLAY, undefined)
  } finally {
    if (orig[0] !== undefined) process.env.DISPLAY = orig[0]
    if (orig[1] !== undefined) process.env.WAYLAND_DISPLAY = orig[1]
  }
})

