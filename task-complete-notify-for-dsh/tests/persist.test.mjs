import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The module resolves the profile dir from DSH_HOME (else ~/.dsh). We set
// DSH_HOME to a temp dir per test so we never touch the real user config.
// The module is loaded after DSH_HOME is set for the first test; since the
// resolution happens at call time (not import time), re-importing per test is
// unnecessary — profileDir() reads process.env.DSH_HOME on each call.
import * as persist from '../lib/persist.js'

const DSH_HOME = join(tmpdir(), `tcn-home-${process.pid}`)
process.env.DSH_HOME = DSH_HOME
// Force the 'web' profile path under the temp home: the module reads argv for
// --profile, defaulting to 'web'. Our calls don't pass --profile, so patchFile
// = $DSH_HOME/profiles/web/cordis.patch.yml.
const PATCH = join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')

function withPatch(content, fn) {
  mkdirSync(join(DSH_HOME, 'profiles', 'web'), { recursive: true })
  writeFileSync(PATCH, content)
  try { return fn() } finally { rmSync(join(DSH_HOME, 'profiles'), { recursive: true, force: true }) }
}

test('readConfig returns null when file absent', () => {
  rmSync(join(DSH_HOME, 'profiles'), { recursive: true, force: true })
  assert.equal(persist.readConfig(), null)
})

test('readConfig parses an existing row', () => withPatch(
  '- id: task-complete-notify\n  name: task-complete-notify-for-dsh\n  config:\n    threshold: 30\n',
  () => assert.equal(persist.readConfig().threshold, 30),
))

test('writeConfig creates a row on empty patch', () => withPatch(
  '[]\n',
  () => {
    assert.equal(persist.writeConfig({ threshold: 10 }), true)
    const text = readFileSync(PATCH, 'utf8')
    assert.match(text, /threshold: 10/)
    assert.match(text, /id: task-complete-notify/)
  },
))

test('writeConfig preserves unrelated entries', () => withPatch(
  '- id: other-plugin\n  config:\n    foo: bar\n',
  () => {
    persist.writeConfig({ threshold: 5 })
    const text = readFileSync(PATCH, 'utf8')
    assert.match(text, /other-plugin/)
    assert.match(text, /foo: bar/)
    assert.match(text, /threshold: 5/)
  },
))

test('writeConfig merges into an existing row, keeping other keys', () => withPatch(
  '- id: task-complete-notify\n  name: task-complete-notify-for-dsh\n  config:\n    threshold: 30\n    sound: false\n',
  () => {
    persist.writeConfig({ threshold: 60 })
    const text = readFileSync(PATCH, 'utf8')
    assert.match(text, /threshold: 60/)
    assert.match(text, /sound: false/)
  },
))

test('writeConfig removes a key when given empty value', () => withPatch(
  '- id: task-complete-notify\n  config:\n    threshold: 30\n',
  () => {
    persist.writeConfig({ threshold: '' })
    assert.doesNotMatch(readFileSync(PATCH, 'utf8'), /threshold/)
  },
))

test('writeConfig falls back to empty patch on invalid file', () => withPatch(
  'this: is: not: valid\n:::',
  () => {
    assert.equal(persist.writeConfig({ threshold: 10 }), true)
    assert.match(readFileSync(PATCH, 'utf8'), /threshold: 10/)
  },
))

test('writeConfig writes [] when the only row becomes empty', () => withPatch(
  '- id: task-complete-notify\n  config:\n    threshold: 30\n',
  () => {
    persist.writeConfig({ threshold: '' })
    const text = readFileSync(PATCH, 'utf8')
    assert.match(text.trim(), /^\[\]$/)
  },
))
