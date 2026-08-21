/**
 * dsh-service-control — plugin shape unit tests.
 *
 * Validates the two things dsh's bundle mechanism relies on:
 *   1. The plugin entry exports name / Config / apply (official plugin shape).
 *   2. cordis.patch.yml is a top-level array with an `insert` row.
 *
 * Run: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(here, '..')

const plugin = await import('../lib/index.js')

test('exports official plugin shape: name / Config / apply', () => {
  assert.equal(typeof plugin.name, 'string')
  assert.ok(plugin.name.length > 0)
  assert.ok(plugin.Config, 'Config must be exported (schemastery schema)')
  assert.equal(typeof plugin.apply, 'function')
})

/** Decode a value through a schemastery schema (standard-schema interface). */
function decode(schema, value) {
  const r = schema['~standard'].validate(value)
  if (r.issues) throw new Error(r.issues.map((i) => i.message).join('; '))
  return r.value
}

test('Config is a schemastery schema', () => {
  assert.equal(typeof plugin.Config['~standard'].validate, 'function')
  // fields are optional by default: {} decodes fine, profile stays undefined
  assert.deepEqual(decode(plugin.Config, {}), {})
  assert.deepEqual(decode(plugin.Config, { profile: 'web' }), { profile: 'web' })
})

test('inject declares webServer (service accessed via ctx.webServer)', () => {
  assert.ok(Array.isArray(plugin.inject))
  assert.ok(plugin.inject.includes('webServer'))
})

test('cordis.patch.yml is a top-level array with an insert row', () => {
  const raw = readFileSync(path.join(pkgRoot, 'cordis.patch.yml'), 'utf8')
  // Top-level list item with a nested insert list (official patch shape).
  assert.match(raw, /^- insert:\s*$/m, 'patch must start with a top-level `- insert:` row')
  assert.match(raw, /^\s+- id: dsh-service-control\s*$/m, 'insert row must carry our id')
  assert.match(raw, /^\s+name: dsh-service-control\s*$/m, 'insert row must carry our name')
})

test('scripts/control.sh is executable', () => {
  const mode = statSync(path.join(pkgRoot, 'scripts', 'control.sh')).mode
  assert.ok(mode & 0o111, 'control.sh must be executable')
})

test('control.sh implements enable/disable/watchdog systemd commands', () => {
  const src = readFileSync(path.join(pkgRoot, 'scripts', 'control.sh'), 'utf8')
  // parser must accept all subcommands
  assert.match(src, /enable\|disable\|watchdog/, 'parser must list enable|disable|watchdog')
  // dispatcher must route them
  assert.match(src, /\benable\)[\s\S]*?\benable_service\b/, 'enable must dispatch to enable_service')
  assert.match(src, /\bdisable\)[\s\S]*?\bdisable_service\b/, 'disable must dispatch to disable_service')
  assert.match(src, /\bwatchdog\)[\s\S]*?\bwatchdog_loop\b/, 'watchdog must dispatch to watchdog_loop')
  // unit names follow dsh-<profile>.service / dsh-<profile>-watchdog.service
  assert.match(src, /dsh-%s\.service/, 'unit name must be dsh-<profile>.service')
  assert.match(src, /dsh-%s-watchdog\.service/, 'watchdog unit name must be dsh-<profile>-watchdog.service')
})

test('control.sh passes bash -n syntax check', () => {
  execFileSync('bash', ['-n', path.join(pkgRoot, 'scripts', 'control.sh')])
})

test('dshctl CLI accepts enable/disable', () => {
  const src = readFileSync(path.join(pkgRoot, 'bin', 'dshctl.js'), 'utf8')
  assert.match(src, /'enable', 'disable'/, 'CLI must validate enable/disable commands')
})
