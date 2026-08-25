/**
 * dsh-service-control — plugin shape unit tests (v3: cli-startup + runner).
 *
 * Validates the two plugin entries the bundle relies on:
 *   1. cli-startup (name / inject ['cmdlineArgs'] / apply) — the cmdline
 *      provider that publishes the invoked command.
 *   2. runner (main entry: name / Config / inject ['cliCommand'] / apply) —
 *      consumes the command, runs control.sh, requests exit.
 * Plus the cordis.patch.yml shape (insert rows + hmr disable).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(here, '..')

const startup = await import('../lib/cli-startup.js')
const runner = await import('../lib/index.js')

test('cli-startup exports the provider plugin shape', () => {
  assert.equal(typeof startup.name, 'string')
  assert.ok(startup.name.length > 0)
  assert.equal(typeof startup.apply, 'function')
  assert.ok(Array.isArray(startup.inject))
  assert.ok(startup.inject.includes('cmdlineArgs'), 'cli-startup must inject cmdlineArgs')
})

test('runner exports the official plugin shape', () => {
  assert.equal(typeof runner.name, 'string')
  assert.ok(runner.Config, 'runner must export Config (schemastery schema)')
  assert.equal(typeof runner.apply, 'function')
  assert.ok(Array.isArray(runner.inject))
  assert.ok(runner.inject.includes('cliCommand'), 'runner must inject cliCommand')
})

test('runner Config validates the target profile charset', () => {
  const s = runner.Config['~standard']
  assert.equal(typeof s.validate, 'function')
  const ok = s.validate({ command: {}, profile: 'web' })
  assert.ok(!ok.issues, JSON.stringify(ok.issues))
  const bad = s.validate({ command: {}, profile: '../evil' })
  assert.ok(bad.issues, 'unsafe profile must be rejected')
})

test('cordis.patch.yml inserts both rows and disables hmr', () => {
  const raw = readFileSync(path.join(pkgRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(raw, /- id: dsh-service-control-cli/, 'must insert the cli-startup row')
  assert.match(raw, /name: 'dsh-service-control\/cli-startup'/, 'cli-startup row must resolve the subpath')
  assert.match(raw, /- id: dsh-service-control/, 'must insert the runner row')
  assert.match(raw, /inject: \[cliCommand\]/, 'runner row must inject cliCommand')
  assert.match(raw, /command: !!js ctx\.cliCommand/, 'runner config must read the published command')
  assert.match(raw, /- id: hmr\s+disabled: true/, 'one-shot mode must disable hmr')
})

test('scripts/control.sh is executable and passes bash -n', () => {
  const mode = statSync(path.join(pkgRoot, 'scripts', 'control.sh')).mode
  assert.ok(mode & 0o111, 'control.sh must be executable')
  execFileSync('bash', ['-n', path.join(pkgRoot, 'scripts', 'control.sh')])
})

test('control.sh dispatches install/enable/disable/uninstall', () => {
  const src = readFileSync(path.join(pkgRoot, 'scripts', 'control.sh'), 'utf8')
  assert.match(src, /install\|enable\|disable\|uninstall/, 'parser must list the lifecycle commands')
  assert.match(src, /\binstall\)[\s\S]*?\binstall_service\b/, 'install must dispatch to install_service')
  assert.match(src, /\benable\)[\s\S]*?\benable_service\b/, 'enable must dispatch to enable_service')
  assert.match(src, /\bdisable\)[\s\S]*?\bdisable_service\b/, 'disable must dispatch to disable_service')
  assert.match(src, /\buninstall\)[\s\S]*?\buninstall_service\b/, 'uninstall must dispatch to uninstall_service')
})
