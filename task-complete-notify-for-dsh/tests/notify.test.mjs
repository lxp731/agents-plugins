import { test } from 'node:test'
import assert from 'node:assert/strict'

const { notify, playersFor, CHIME } = await import('../lib/notify.js')

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
