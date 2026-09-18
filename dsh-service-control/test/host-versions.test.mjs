/**
 * dsh-service-control — host version probing tests.
 *
 * `self info` must report installed versions, never the semver ranges declared
 * in package.json. These tests build hermetic fake install trees (a launcher
 * prefix and a plugin directory, each with their own @deepseek-ai/dsh-cmdline
 * copy) so nothing depends on the machine's global dsh.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import {
  CMDLINE_PKG, LAUNCHER_PKG, readJson, resolvePackageJson, resolvePackageVersion,
  whichSync, findUpPackage, detectLauncher, hostVersions,
} from '../lib/host-versions.js'

/** Write a package.json at `root`, exporting ./package.json like the real one. */
function writePackage(root, pkg) {
  mkdirSync(root, { recursive: true })
  const file = path.join(root, 'package.json')
  writeFileSync(file, JSON.stringify({
    exports: { '.': './lib/index.js', './package.json': './package.json' },
    ...pkg,
  }, null, 2))
  return file
}

/** Install a fake dependency into `baseDir/node_modules/<name>`. */
function installDep(baseDir, name, version) {
  return writePackage(path.join(baseDir, 'node_modules', name), { name, version })
}

/**
 * Fake launcher install tree:
 *   <tmp>/prefix/lib/node_modules/@deepseek-ai/dsh/{package.json,lib/bin.js}
 *   <tmp>/prefix/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-cmdline
 */
function fakeLauncher(tmp, {
  dshVersion = '9.9.9-test', cmdlineVersion = '9.9.9-rc.1', declaredCmdline = '^9.9.9-rc.1',
} = {}) {
  const root = path.join(tmp, 'prefix', 'lib', 'node_modules', LAUNCHER_PKG)
  const pkgPath = writePackage(root, {
    name: LAUNCHER_PKG,
    version: dshVersion,
    dependencies: { [CMDLINE_PKG]: declaredCmdline },
  })
  const bin = path.join(root, 'lib', 'bin.js')
  mkdirSync(path.dirname(bin), { recursive: true })
  // npm 安装的 bin 条目是可执行的（PATH 回退探测依赖 X_OK）
  writeFileSync(bin, '// fake dsh launcher bin\n', { mode: 0o755 })
  installDep(root, CMDLINE_PKG, cmdlineVersion)
  return { root, pkgPath, bin, cmdlineVersion }
}

/** Fake plugin tree: <tmp>/plugin/{lib/index.js,node_modules/@deepseek-ai/dsh-cmdline}. */
function fakePlugin(tmp, { cmdlineVersion = '1.1.1' } = {}) {
  const dir = path.join(tmp, 'plugin')
  const entry = path.join(dir, 'lib', 'index.js')
  mkdirSync(path.dirname(entry), { recursive: true })
  writeFileSync(entry, '// fake plugin entry\n')
  installDep(dir, CMDLINE_PKG, cmdlineVersion)
  return { dir, entry, url: pathToFileURL(entry).href, cmdlineVersion }
}

function tmpdir(tag) {
  return mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`))
}

test('resolvePackageVersion reports the installed version, not the declared range', () => {
  const tmp = tmpdir('hv-resolve')
  try {
    const plugin = fakePlugin(tmp, { cmdlineVersion: '3.4.5-rc.6' })
    assert.equal(resolvePackageVersion(CMDLINE_PKG, plugin.url), '3.4.5-rc.6')
    // 未安装的包 → null（不抛异常）
    assert.equal(resolvePackageVersion('@deepseek-ai/definitely-not-installed', plugin.url), null)
    assert.equal(resolvePackageJson('@deepseek-ai/definitely-not-installed', plugin.url), null)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

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
    // 真实安装里 <prefix>/bin/dsh 就是指向 launcher bin 脚本的符号链接
    const onPath = path.join(dir, 'dsh')
    symlinkSync(bin, onPath)
    // argv[1] 不指向 launcher（模拟嵌入/测试宿主）→ 回退 PATH
    assert.equal(detectLauncher({ argv1: path.join(tmp, 'other.js'), env: { PATH: dir } }).dir, root)
    // PATH 里没有 dsh、argv[1] 也不匹配 → null
    assert.equal(detectLauncher({ argv1: path.join(tmp, 'other.js'), env: { PATH: '' } }), null)
    assert.equal(whichSync('dsh', { PATH: dir }), onPath)
    assert.equal(whichSync('dsh', { PATH: '' }), null)
    // 同名但不可执行的文件不算命中
    writeFileSync(path.join(dir, 'noexec'), '#!/bin/sh\n')
    assert.equal(whichSync('noexec', { PATH: dir }), null)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('findUpPackage honours the package-name filter', () => {
  const tmp = tmpdir('hv-findup')
  try {
    const { root } = fakeLauncher(tmp)
    // 嵌套子目录也能向上找到
    assert.equal(findUpPackage(path.join(root, 'lib'), LAUNCHER_PKG).dir, root)
    // 名称不匹配 → null（不会随便抓一个 package.json）
    assert.equal(findUpPackage(path.join(root, 'lib'), 'not-this-package'), null)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('hostVersions reports loaded vs harness cmdline and flags drift', () => {
  const tmp = tmpdir('hv-versions')
  try {
    const launcher = fakeLauncher(tmp, { dshVersion: '9.9.9-test', cmdlineVersion: '9.9.9-rc.1' })
    const plugin = fakePlugin(tmp, { cmdlineVersion: '1.1.1-rc.2' })
    const v = hostVersions({
      argv1: launcher.bin, env: { PATH: '' }, pluginUrl: plugin.url, declared: '^1.1.1-rc.2',
    })
    assert.equal(v.dsh, '9.9.9-test')
    assert.equal(v.dshPath, launcher.root)
    assert.equal(v.cmdline, '1.1.1-rc.2')
    assert.equal(v.harnessCmdline, '9.9.9-rc.1')
    assert.equal(v.declared, '^1.1.1-rc.2')
    assert.equal(v.drift, true, 'differing copies must be flagged')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('hostVersions reports no drift when both copies match', () => {
  const tmp = tmpdir('hv-nodrift')
  try {
    const launcher = fakeLauncher(tmp, { cmdlineVersion: '2.2.2' })
    const plugin = fakePlugin(tmp, { cmdlineVersion: '2.2.2' })
    const v = hostVersions({ argv1: launcher.bin, env: { PATH: '' }, pluginUrl: plugin.url, declared: '^2.2.2' })
    assert.equal(v.drift, false)
    assert.equal(v.cmdline, v.harnessCmdline)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('hostVersions degrades gracefully when the launcher cannot be found', () => {
  const tmp = tmpdir('hv-nolauncher')
  try {
    const plugin = fakePlugin(tmp, { cmdlineVersion: '4.4.4' })
    const v = hostVersions({ argv1: path.join(tmp, 'plain.js'), env: { PATH: '' }, pluginUrl: plugin.url })
    assert.equal(v.dsh, null)
    assert.equal(v.harnessCmdline, null)
    assert.equal(v.cmdline, '4.4.4')
    assert.equal(v.drift, false, 'unknown harness version must not be reported as drift')
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
