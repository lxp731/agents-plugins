/**
 * dsh-service-control — systemd enable/disable + watchdog loop tests.
 *
 * Runs the real scripts/control.sh in isolated child processes with temp
 * HOME / XDG_CONFIG_HOME and fake `systemctl` / `ss` / `dsh` shims, then
 * asserts:
 *   - enable writes BOTH unit files (service + watchdog) and enables both
 *   - disable stops the watchdog, disables both, and removes both files
 *   - watchdog restarts an active-but-unresponsive service (hang)
 *   - watchdog leaves a healthy service alone
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(here, '..')
const CONTROL = path.join(pkgRoot, 'scripts', 'control.sh')

/** 搭建隔离环境：fake systemctl/ss/dsh + temp HOME/XDG。返回清理函数。 */
function makeShims(tmp, { isActive = true, fakeSsPort } = {}) {
  const shimDir = path.join(tmp, 'shim')
  mkdirSync(shimDir, { recursive: true })
  const systemctlLog = path.join(tmp, 'systemctl.log')
  writeFileSync(path.join(shimDir, 'systemctl'), `#!/bin/sh
echo "$*" >> "${systemctlLog}"
# systemctl 以 (systemctl --user 子命令) 调用，子命令在 $2
case "$2" in
  is-active) ${isActive ? 'echo active; exit 0' : 'exit 1'} ;;
  is-enabled) echo enabled; exit 0 ;;
  *) exit 0 ;;
esac
`)
  // 模拟 dsh：node 进程（cmdline 含 --profile web，SIGINT 立刻退出，同真实 dsh）
  writeFileSync(path.join(shimDir, 'dsh'), '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n')
  if (fakeSsPort !== undefined) {
    writeFileSync(path.join(shimDir, 'ss'), `#!/bin/bash
pid=$(pgrep -f '[d]sh --profile' | head -1)
[ -n "$pid" ] || exit 1
echo "LISTEN 0 4096 127.0.0.1:${fakeSsPort} 0.0.0.0:* users:((\\"node\\",pid=$pid,fd=17))"
`)
  }
  for (const f of ['systemctl', 'dsh', 'ss']) {
    if (existsSync(path.join(shimDir, f))) spawnSync('chmod', ['+x', path.join(shimDir, f)])
  }
  return { shimDir, systemctlLog }
}

function runControl(args, env) {
  return spawnSync('bash', [CONTROL, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
}

test('enable writes service + watchdog units and enables both', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-sysd-'))
  try {
    const home = path.join(tmp, 'home')
    const xdg = path.join(tmp, 'xdg')
    mkdirSync(home, { recursive: true })
    const { shimDir } = makeShims(tmp)
    const env = {
      HOME: home, XDG_CONFIG_HOME: xdg, PATH: `${shimDir}:${process.env.PATH}`,
      DSH_BIN: path.join(shimDir, 'dsh'),
    }
    const r = runControl(['--profile', 'web', 'enable'], env)
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, true)
    assert.equal(out.unit, 'dsh-web.service')
    assert.equal(out.watchdog, 'dsh-web-watchdog.service')

    const unitDir = path.join(xdg, 'systemd', 'user')
    const main = readFileSync(path.join(unitDir, 'dsh-web.service'), 'utf8')
    assert.match(main, /Restart=on-failure/, 'main unit must use Restart=on-failure')
    assert.match(main, /RestartSec=10/, 'main unit must restart after 10s')
    assert.match(main, /KillSignal=SIGTERM/, 'main unit must stop via SIGTERM (dsh exits 0 cleanly)')
    assert.match(main, /SuccessExitStatus=130/, 'SIGINT path must be a clean exit')
    assert.match(main, /Environment="PATH=/, 'main unit must carry a PATH (node shebang needs it)')
    assert.match(main, /ExecStart=.*--profile web --no-open/)

    const wd = readFileSync(path.join(unitDir, 'dsh-web-watchdog.service'), 'utf8')
    assert.match(wd, /Restart=always/, 'watchdog must self-restart')
    assert.match(wd, /Environment="PATH=/, 'watchdog unit must carry a PATH')
    assert.match(wd, /ExecStart=.*control\.sh" --profile web watchdog/)
    assert.match(wd, /WantedBy=default\.target/)

    const calls = readFileSync(path.join(tmp, 'systemctl.log'), 'utf8')
    assert.match(calls, /--user daemon-reload/)
    assert.match(calls, /--user enable dsh-web\.service dsh-web-watchdog\.service/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('disable stops watchdog, disables and removes both units', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-sysd-'))
  try {
    const home = path.join(tmp, 'home')
    const xdg = path.join(tmp, 'xdg')
    mkdirSync(home, { recursive: true })
    const { shimDir } = makeShims(tmp)
    const env = {
      HOME: home, XDG_CONFIG_HOME: xdg, PATH: `${shimDir}:${process.env.PATH}`,
      DSH_BIN: path.join(shimDir, 'dsh'),
    }
    runControl(['--profile', 'web', 'enable'], env)
    const r = runControl(['--profile', 'web', 'disable'], env)
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.disabled, true)

    const unitDir = path.join(xdg, 'systemd', 'user')
    assert.ok(!existsSync(path.join(unitDir, 'dsh-web.service')), 'main unit must be removed')
    assert.ok(!existsSync(path.join(unitDir, 'dsh-web-watchdog.service')), 'watchdog unit must be removed')
    const calls = readFileSync(path.join(tmp, 'systemctl.log'), 'utf8')
    assert.match(calls, /--user stop dsh-web-watchdog\.service/, 'watchdog must be stopped first')
    assert.match(calls, /--user disable dsh-web\.service dsh-web-watchdog\.service/)
    assert.match(calls, /--user daemon-reload/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('watchdog restarts a hung service (active but unresponsive)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-wd-'))
  try {
    const home = path.join(tmp, 'home')
    const xdg = path.join(tmp, 'xdg')
    mkdirSync(home, { recursive: true })
    // fake ss reports port 1 — nothing listens → curl refused → probe fails
    const { shimDir, systemctlLog } = makeShims(tmp, { isActive: true, fakeSsPort: 1 })
    const env = {
      HOME: home, XDG_CONFIG_HOME: xdg, PATH: `${shimDir}:${process.env.PATH}`,
      DSH_BIN: path.join(shimDir, 'dsh'),
      DSH_WATCHDOG_INTERVAL: '0.2', DSH_WATCHDOG_FAIL_LIMIT: '2',
      DSH_WATCHDOG_PROBE_TIMEOUT: '1', DSH_WATCHDOG_COOLDOWN: '1',
    }
    // fake dsh 常驻（供 pgrep 匹配）
    const fakeDsh = spawn(path.join(shimDir, 'dsh'), ['--profile', 'wdtest', '--no-open'], { stdio: 'ignore' })
    try {
      const r = spawnSync('timeout', ['6', 'bash', CONTROL, '--profile', 'wdtest', 'watchdog'], {
        encoding: 'utf8', env,
      })
      assert.ok(r.status === 124 || r.status === 0, `watchdog exited ${r.status}: ${r.stdout} ${r.stderr}`)
      const calls = readFileSync(systemctlLog, 'utf8')
      assert.match(calls, /--user restart dsh-wdtest\.service/, 'hung service must be restarted')
    } finally {
      fakeDsh.kill('SIGKILL')
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('watchdog leaves a healthy service alone', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-wd-'))
  let httpServer = null
  try {
    const home = path.join(tmp, 'home')
    const xdg = path.join(tmp, 'xdg')
    mkdirSync(home, { recursive: true })
    // 真实 HTTP 服务模拟 /dsh-health（200 即可，curl -fsS 只看状态码）
    httpServer = spawn(process.execPath, ['-e',
      "require('node:http').createServer((q,s)=>{s.writeHead(200);s.end('{\"ok\":true}')}).listen(18999,'127.0.0.1')",
    ], { stdio: 'ignore' })
    const { shimDir, systemctlLog } = makeShims(tmp, { isActive: true, fakeSsPort: 18999 })
    const env = {
      HOME: home, XDG_CONFIG_HOME: xdg, PATH: `${shimDir}:${process.env.PATH}`,
      DSH_BIN: path.join(shimDir, 'dsh'),
      DSH_WATCHDOG_INTERVAL: '0.2', DSH_WATCHDOG_FAIL_LIMIT: '2',
      DSH_WATCHDOG_PROBE_TIMEOUT: '1', DSH_WATCHDOG_COOLDOWN: '1',
    }
    const fakeDsh = spawn(path.join(shimDir, 'dsh'), ['--profile', 'wdtest', '--no-open'], { stdio: 'ignore' })
    // 等 HTTP server 就绪
    const wait = spawnSync('bash', ['-c',
      'for i in $(seq 1 20); do curl -fsS --max-time 1 http://127.0.0.1:18999/dsh-health >/dev/null 2>&1 && exit 0; sleep 0.2; done; exit 1',
    ], { encoding: 'utf8', env: { ...process.env, PATH: env.PATH } })
    assert.equal(wait.status, 0, 'health server must come up')
    try {
      const r = spawnSync('timeout', ['5', 'bash', CONTROL, '--profile', 'wdtest', 'watchdog'], {
        encoding: 'utf8', env,
      })
      assert.ok(r.status === 124 || r.status === 0, `watchdog exited ${r.status}`)
      const calls = existsSync(systemctlLog) ? readFileSync(systemctlLog, 'utf8') : ''
      assert.ok(!calls.includes('restart'), 'healthy service must not be restarted')
    } finally {
      fakeDsh.kill('SIGKILL')
    }
  } finally {
    if (httpServer) httpServer.kill('SIGKILL')
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('stop kills a raw (non-systemd) process even when the unit exists', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-raw-'))
  try {
    const home = path.join(tmp, 'home')
    const xdg = path.join(tmp, 'xdg')
    mkdirSync(home, { recursive: true })
    // unit 存在但 systemd 认为 inactive（模拟 enable 前的 raw 进程场景）
    const { shimDir } = makeShims(tmp, { isActive: false })
    const env = {
      HOME: home, XDG_CONFIG_HOME: xdg, PATH: `${shimDir}:${process.env.PATH}`,
      DSH_BIN: path.join(shimDir, 'dsh'),
    }
    runControl(['--profile', 'web', 'enable'], env)
    // 手动起一个非 systemd 托管的 raw dsh
    const raw = spawn(path.join(shimDir, 'dsh'), ['--profile', 'web', '--no-open'], { stdio: 'ignore' })
    try {
      // status 应能通过 pgrep 回退识别到 raw 进程
      const st = JSON.parse(runControl(['--profile', 'web', 'status'], env).stdout)
      assert.equal(st.running, true, 'status must detect the raw process')
      assert.match(st.note || '', /outside systemd/)
      // stop 必须杀掉 raw 进程（而不是只停 systemd unit）
      const r = runControl(['--profile', 'web', 'stop'], env)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(JSON.parse(r.stdout).ok, true)
      // 轮询等它真正被回收（避免僵尸态误判），最多 3s
      const deadline = Date.now() + 3000
      let dead = false
      while (Date.now() < deadline) {
        try {
          process.kill(raw.pid, 0)
          await new Promise((res) => setTimeout(res, 50))
        } catch {
          dead = true
          break
        }
      }
      assert.ok(dead, 'raw process must be dead after stop')
    } finally {
      raw.kill('SIGKILL')
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('start does not duplicate a raw process when the unit is inactive', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-raw-'))
  try {
    const home = path.join(tmp, 'home')
    const xdg = path.join(tmp, 'xdg')
    mkdirSync(home, { recursive: true })
    const { shimDir } = makeShims(tmp, { isActive: false })
    const env = {
      HOME: home, XDG_CONFIG_HOME: xdg, PATH: `${shimDir}:${process.env.PATH}`,
      DSH_BIN: path.join(shimDir, 'dsh'),
    }
    runControl(['--profile', 'web', 'enable'], env)
    const raw = spawn(path.join(shimDir, 'dsh'), ['--profile', 'web', '--no-open'], { stdio: 'ignore' })
    try {
      const r = runControl(['--profile', 'web', 'start'], env)
      assert.equal(r.status, 0, r.stderr)
      const out = JSON.parse(r.stdout)
      assert.equal(out.ok, true)
      assert.equal(out.already, true, 'must report already running (not duplicate)')
      assert.equal(out.pid, raw.pid, 'must keep using the raw pid')
      // 只应存在一个进程
      const n = spawnSync('bash', ['-c', 'pgrep -cf "[d]sh --profile web"'], { env, encoding: 'utf8' }).stdout.trim()
      assert.equal(Number(n), 1, 'must not spawn a duplicate instance')
    } finally {
      raw.kill('SIGKILL')
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
