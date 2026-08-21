/**
 * dshctl uninstall — systemd unit cleanup tests.
 *
 * Runs the real bin/dshctl.js in an isolated child process with temp
 * HOME / XDG_CONFIG_HOME and a fake `systemctl` on PATH, then asserts:
 *   - our unit files (dsh-<profile>.service, template signature) are disabled + removed
 *   - unrelated units (same name pattern but not ours, or other names) are kept
 *   - systemctl gets disable + daemon-reload
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(here, '..')
const BIN = path.join(pkgRoot, 'bin', 'dshctl.js')

function runUninstall({ home, xdg, shimDir }) {
  return spawnSync(process.execPath, [BIN, 'uninstall'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, PATH: `${shimDir}:${process.env.PATH}` },
  })
}

test('dshctl uninstall disables and removes our systemd units, keeps unrelated files', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-uninstall-'))
  try {
    const home = path.join(tmp, 'home')
    const xdg = path.join(tmp, 'xdg')
    const unitDir = path.join(xdg, 'systemd', 'user')
    mkdirSync(unitDir, { recursive: true })

    // 本插件的 unit（当前模板：带 marker 注释）
    writeFileSync(path.join(unitDir, 'dsh-web.service'), [
      '# managed by dsh-service-control (dshctl enable)',
      '[Unit]',
      'Description=dsh service (profile web)',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'ExecStart="/home/u/dsh" --profile web --no-open',
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'))
    // 旧模板（无 marker，但含 --profile）也应识别删除
    writeFileSync(path.join(unitDir, 'dsh-tui.service'),
      '[Service]\nExecStart="/home/u/dsh" --profile tui --no-open\n[Install]\nWantedBy=default.target\n')
    // 看门狗 unit（enable 一并创建）也应识别删除
    writeFileSync(path.join(unitDir, 'dsh-web-watchdog.service'),
      '[Service]\nExecStart="/home/u/dsh-service-control/scripts/control.sh" --profile web watchdog\nRestart=always\n\n[Install]\nWantedBy=default.target\n')

    // 非本插件的文件：必须保留
    writeFileSync(path.join(unitDir, 'dsh-manual.service'), '[Unit]\nDescription=user thing\n[Service]\nExecStart=/bin/true\n')
    writeFileSync(path.join(unitDir, 'other.service'), '[Unit]\n[Service]\nExecStart=/bin/true\n')

    // fake systemctl：记录调用，模拟成功
    const shimDir = path.join(tmp, 'shim')
    mkdirSync(shimDir)
    const logFile = path.join(tmp, 'systemctl.log')
    writeFileSync(path.join(shimDir, 'systemctl'), `#!/bin/sh\necho "$*" >> "${logFile}"\nexit 0\n`)
    spawnSync('chmod', ['+x', path.join(shimDir, 'systemctl')])

    const r = runUninstall({ home, xdg, shimDir })
    assert.equal(r.status, 0, `uninstall exited ${r.status}: ${r.stderr}`)

    // 我们的 unit 被删除
    assert.ok(!existsSync(path.join(unitDir, 'dsh-web.service')), 'our unit must be removed')
    assert.ok(!existsSync(path.join(unitDir, 'dsh-tui.service')), 'old-template unit must be removed')
    assert.ok(!existsSync(path.join(unitDir, 'dsh-web-watchdog.service')), 'watchdog unit must be removed')
    // 非本插件的文件保留
    assert.ok(existsSync(path.join(unitDir, 'dsh-manual.service')), 'non-ours dsh-*.service must be kept')
    assert.ok(existsSync(path.join(unitDir, 'other.service')), 'unrelated unit must be kept')

    // systemctl 收到 disable（每个 unit）与一次 daemon-reload
    const calls = readFileSync(logFile, 'utf8')
    assert.match(calls, /--user disable dsh-web\.service/)
    assert.match(calls, /--user disable dsh-tui\.service/)
    assert.match(calls, /--user disable dsh-web-watchdog\.service/)
    assert.match(calls, /--user daemon-reload/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('dshctl uninstall is a no-op for systemd when nothing ours exists', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-uninstall-'))
  try {
    const home = path.join(tmp, 'home')
    const xdg = path.join(tmp, 'xdg')
    mkdirSync(path.join(xdg, 'systemd', 'user'), { recursive: true })
    writeFileSync(path.join(xdg, 'systemd', 'user', 'other.service'), '[Unit]\n[Service]\nExecStart=/bin/true\n')

    const shimDir = path.join(tmp, 'shim')
    mkdirSync(shimDir)
    const logFile = path.join(tmp, 'systemctl.log')
    writeFileSync(path.join(shimDir, 'systemctl'), `#!/bin/sh\necho "$*" >> "${logFile}"\nexit 0\n`)
    spawnSync('chmod', ['+x', path.join(shimDir, 'systemctl')])

    const r = runUninstall({ home, xdg, shimDir })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(path.join(xdg, 'systemd', 'user', 'other.service')), 'unrelated unit must be kept')
    // 没有我们的 unit 时不应触发 daemon-reload（systemctl 可能根本没被调用）
    const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    assert.ok(!calls.includes('daemon-reload'), 'no daemon-reload when nothing was removed')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
