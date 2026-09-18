/**
 * dsh-service-control — hosting launcher detection tests.
 *
 * `self info` reports the hosting dsh launcher's version (what `dsh --version`
 * prints), so detection must work from the launcher's bin script, through
 * symlinked bins, and via a PATH fallback. These tests build hermetic fake
 * install trees so nothing depends on the machine's global dsh.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LAUNCHER_PKG, readJson, whichSync, findUpPackage, detectLauncher,
} from '../lib/host-versions.js'

/** Write a package.json at `root` (npm-installed packages export nothing here). */
function writePackage(root, pkg) {
  mkdirSync(root, { recursive: true })
  const file = path.join(root, 'package.json')
  writeFileSync(file, JSON.stringify(pkg, null, 2))
  return file
}

/**
 * Fake launcher install tree:
 *   <tmp>/prefix/lib/node_modules/@deepseek-ai/dsh/{package.json,lib/bin.js}
 */
function fakeLauncher(tmp, { dshVersion = '9.9.9-test' } = {}) {
  const root = path.join(tmp, 'prefix', 'lib', 'node_modules', LAUNCHER_PKG)
  const pkgPath = writePackage(root, { name: LAUNCHER_PKG, version: dshVersion })
  const bin = path.join(root, 'lib', 'bin.js')
  mkdirSync(path.dirname(bin), { recursive: true })
  // npm installs bin entries executable; the PATH fallback relies on X_OK
  writeFileSync(bin, '// fake dsh launcher bin\n', { mode: 0o755 })
  return { root, pkgPath, bin }
}

function tmpdir(tag) {
  return mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`))
}

test('detectLauncher finds the hosting dsh package from its bin script', () => {
  const tmp = tmpdir('hv-launcher')
  try {
    const { root, bin } = fakeLauncher(tmp)
    const launcher = detectLauncher({ argv1: bin, env: { PATH: '' } })
    assert.equal(launcher.pkg.name, LAUNCHER_PKG)
    assert.equal(launcher.dir, root)
    assert.equal(launcher.version, '9.9.9-test')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('detectLauncher follows a symlinked bin (e.g. <prefix>/bin/dsh)', () => {
  const tmp = tmpdir('hv-symlink')
  try {
    const { root, bin } = fakeLauncher(tmp)
    const link = path.join(tmp, 'bin', 'dsh')
    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(bin, link)
    assert.equal(detectLauncher({ argv1: link, env: { PATH: '' } }).dir, root)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('detectLauncher falls back to dsh on PATH and returns null when absent', () => {
  const tmp = tmpdir('hv-path')
  try {
    const { root, bin } = fakeLauncher(tmp)
    const dir = path.join(tmp, 'bin')
    mkdirSync(dir, { recursive: true })
    // a real install links <prefix>/bin/dsh to the launcher's bin script
    const onPath = path.join(dir, 'dsh')
    symlinkSync(bin, onPath)
    // argv[1] does not point at the launcher (embedding/test host) → PATH fallback
    assert.equal(detectLauncher({ argv1: path.join(tmp, 'other.js'), env: { PATH: dir } }).dir, root)
    // no dsh on PATH and no launcher at argv[1] → null
    assert.equal(detectLauncher({ argv1: path.join(tmp, 'other.js'), env: { PATH: '' } }), null)
    assert.equal(whichSync('dsh', { PATH: dir }), onPath)
    assert.equal(whichSync('dsh', { PATH: '' }), null)
    // a same-named file without the executable bit is not a hit
    writeFileSync(path.join(dir, 'noexec'), '#!/bin/sh\n')
    assert.equal(whichSync('noexec', { PATH: dir }), null)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('detectLauncher reports a null version when the manifest has none', () => {
  const tmp = tmpdir('hv-noversion')
  try {
    const root = path.join(tmp, 'prefix', 'lib', 'node_modules', LAUNCHER_PKG)
    writePackage(root, { name: LAUNCHER_PKG })
    const bin = path.join(root, 'lib', 'bin.js')
    mkdirSync(path.dirname(bin), { recursive: true })
    writeFileSync(bin, '// fake\n')
    assert.equal(detectLauncher({ argv1: bin, env: { PATH: '' } }).version, null)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('findUpPackage honours the package-name filter', () => {
  const tmp = tmpdir('hv-findup')
  try {
    const { root } = fakeLauncher(tmp)
    // a nested subdirectory still resolves upward
    assert.equal(findUpPackage(path.join(root, 'lib'), LAUNCHER_PKG).dir, root)
    // a name mismatch returns null instead of grabbing an unrelated manifest
    assert.equal(findUpPackage(path.join(root, 'lib'), 'not-this-package'), null)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('readJson tolerates missing and malformed files', () => {
  const tmp = tmpdir('hv-json')
  try {
    assert.equal(readJson(path.join(tmp, 'nope.json')), null)
    const bad = path.join(tmp, 'bad.json')
    writeFileSync(bad, '{ not json')
    assert.equal(readJson(bad), null)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})
