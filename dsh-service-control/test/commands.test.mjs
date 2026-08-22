/**
 * dsh-service-control — new CLI commands tests (probe/info/doctor/logs/config/diagnostics + aliases).
 *
 * Runs the real scripts/control.sh / bin/dshctl.js in isolated temp HOME/XDG
 * with fake systemctl/ss/dsh shims where needed.
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
const BIN = path.join(pkgRoot, 'bin', 'dshctl.js')

const run = (args, env) => spawnSync('bash', [CONTROL, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

function fakeShims(tmp, fakeSsPort) {
  const shimDir = path.join(tmp, 'shim')
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(path.join(shimDir, 'systemctl'), '#!/bin/sh\ncase "$2" in is-active) echo active; exit 0;; is-enabled) echo enabled; exit 0;; *) exit 0;; esac\n')
  writeFileSync(path.join(shimDir, 'dsh'), '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n')
  if (fakeSsPort !== undefined) {
    writeFileSync(path.join(shimDir, 'ss'), `#!/bin/bash\nfor pid in $(pgrep -f '[d]sh --profile'); do echo "LISTEN 0 4096 127.0.0.1:${fakeSsPort} 0.0.0.0:* users:((\\"node\\",pid=$pid,fd=17))"; done\n[ -n "$pid" ] || exit 1\n`)
  }
  for (const f of ['systemctl', 'dsh', 'ss']) if (existsSync(path.join(shimDir, f))) spawnSync('chmod', ['+x', path.join(shimDir, f)])
  return shimDir
}

test('probe reports unhealthy when not running', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-cmd-'))
  try {
    const shimDir = fakeShims(tmp)
    const env = { HOME: path.join(tmp, 'home'), XDG_CONFIG_HOME: path.join(tmp, 'xdg'), PATH: `${shimDir}:${process.env.PATH}`, DSH_BIN: path.join(shimDir, 'dsh') }
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    const r = run(['--profile', 'web', 'probe'], env)
    assert.equal(r.status, 1)
    const d = JSON.parse(r.stdout)
    assert.equal(d.healthy, false)
    assert.ok(d.error)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('probe reports healthy with latency when serving', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-cmd-'))
  let httpServer = null
  try {
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    httpServer = spawn(process.execPath, ['-e',
      "require('node:http').createServer((q,s)=>{s.writeHead(200);s.end('{\"ok\":true}')}).listen(18998,'127.0.0.1')",
    ], { stdio: 'ignore' })
    const shimDir = fakeShims(tmp, 18998)
    const env = { HOME: path.join(tmp, 'home'), XDG_CONFIG_HOME: path.join(tmp, 'xdg'), PATH: `${shimDir}:${process.env.PATH}`, DSH_BIN: path.join(shimDir, 'dsh') }
    const fakeDsh = spawn(path.join(shimDir, 'dsh'), ['--profile', 'web', '--no-open'], { stdio: 'ignore' })
    const wait = spawnSync('bash', ['-c',
      'for i in $(seq 1 40); do curl -fsS --max-time 1 http://127.0.0.1:18998/dsh-health >/dev/null 2>&1 && exit 0; sleep 0.2; done; exit 1',
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` } })
    try {
      assert.equal(wait.status, 0, 'http server must come up')
      const r = run(['--profile', 'web', 'probe'], env)
      assert.equal(r.status, 0, r.stderr)
      const d = JSON.parse(r.stdout)
      assert.equal(d.healthy, true)
      assert.equal(d.port, 18998)
      assert.ok(Number.isInteger(d.latency_ms) && d.latency_ms >= 0)
    } finally { fakeDsh.kill('SIGKILL') }
  } finally {
    if (httpServer) httpServer.kill('SIGKILL')
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('config set/get/list round-trips through a per-profile file', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-cmd-'))
  try {
    const home = path.join(tmp, 'home'); mkdirSync(home, { recursive: true })
    const xdg = path.join(tmp, 'xdg')
    const env = { HOME: home, XDG_CONFIG_HOME: xdg }
    const set = run(['--profile', 'web', 'config', 'set', 'DSH_WATCHDOG_FAIL_LIMIT', '2'], env)
    assert.equal(JSON.parse(set.stdout).ok, true)
    // 已写盘：随后 control.sh 启动时会 source，get 应读到 2
    const get = run(['--profile', 'web', 'config', 'get', 'DSH_WATCHDOG_FAIL_LIMIT'], env)
    assert.equal(JSON.parse(get.stdout).value, '2')
    const list = run(['--profile', 'web', 'config'], env)
    const ld = JSON.parse(list.stdout)
    assert.equal(ld.config.DSH_WATCHDOG_FAIL_LIMIT, '2')
    // 非法键拒绝
    const bad = run(['--profile', 'web', 'config', 'set', 'EVIL_KEY', '1'], env)
    assert.equal(JSON.parse(bad.stdout).ok, false)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('info and doctor produce expected output', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-cmd-'))
  try {
    const home = path.join(tmp, 'home'); mkdirSync(home, { recursive: true })
    const shimDir = fakeShims(tmp)
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(tmp, 'xdg'), PATH: `${shimDir}:${process.env.PATH}`, DSH_BIN: path.join(shimDir, 'dsh') }
    const info = run(['--profile', 'web', 'info'], env)
    const id = JSON.parse(info.stdout)
    assert.equal(id.ok, true)
    assert.equal(id.profile, 'web')
    assert.ok(id.unit && id.watchdog_unit)
    const doc = run(['--profile', 'web', 'doctor'], env)
    assert.equal(doc.status, 0)
    assert.match(doc.stdout, /doctor/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('CLI aliases resolve to real commands', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-cmd-'))
  try {
    const home = path.join(tmp, 'home'); mkdirSync(home, { recursive: true })
    const xdg = path.join(tmp, 'xdg')
    // `dshctl h` (probe alias) on not-running → exit 1, unhealthy
    const h = spawnSync(process.execPath, [BIN, 'h'], { encoding: 'utf8', env: { HOME: home, XDG_CONFIG_HOME: xdg } })
    assert.equal(h.status, 1)
    assert.match(h.stdout, /unhealthy|not running/)
    // `dshctl config set` via CLI → writes temp XDG file
    const cs = spawnSync(process.execPath, [BIN, 'config', 'set', 'DSH_WATCHDOG_COOLDOWN', '30'], { encoding: 'utf8', env: { HOME: home, XDG_CONFIG_HOME: xdg } })
    assert.equal(cs.status, 0)
    const confFile = path.join(xdg, 'dsh-service-control', 'web.conf')
    assert.ok(existsSync(confFile), 'config file must be written')
    assert.match(readFileSync(confFile, 'utf8'), /DSH_WATCHDOG_COOLDOWN=30/)
    // `dshctl i` (info alias) → JSON info
    const info = spawnSync(process.execPath, [BIN, 'i'], { encoding: 'utf8', env: { HOME: home, XDG_CONFIG_HOME: xdg } })
    assert.equal(info.status, 0)
    assert.match(info.stdout, /profile:\s+web/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('logs dsh reads the log file; unknown source errors', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-cmd-'))
  try {
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    const shimDir = fakeShims(tmp)
    const logFile = path.join(tmp, 'dsh-web.log')
    writeFileSync(logFile, '[t] dsh-service-control: start requested\n[t] dsh-service-control: started OK — pid=1 port=3080\n')
    const env = { HOME: path.join(tmp, 'home'), XDG_CONFIG_HOME: path.join(tmp, 'xdg'), PATH: `${shimDir}:${process.env.PATH}`, DSH_BIN: path.join(shimDir, 'dsh'), DSH_LOG: logFile }
    // 显式 dsh 源
    const r = run(['--profile', 'web', 'logs', 'dsh'], env)
    assert.equal(r.status, 0)
    assert.match(r.stdout, /start requested/)
    assert.match(r.stdout, /started OK/)
    // 默认（无子命令）→ dsh
    const r2 = run(['--profile', 'web', 'logs'], env)
    assert.match(r2.stdout, /start requested/)
    // 未知源报错
    const bad = run(['--profile', 'web', 'logs', 'foo'], env)
    assert.notEqual(bad.status, 0)
    assert.match(bad.stdout + bad.stderr, /unknown source/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('raw start/stop writes timestamped lifecycle log entries', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-cmd-'))
  let httpServer = null
  try {
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    httpServer = spawn(process.execPath, ['-e',
      "require('node:http').createServer((q,s)=>{s.writeHead(200);s.end('{\"ok\":true}')}).listen(18997,'127.0.0.1')",
    ], { stdio: 'ignore' })
    const shimDir = fakeShims(tmp, 18997)
    const logFile = path.join(tmp, 'dsh-web.log')
    const env = { HOME: path.join(tmp, 'home'), XDG_CONFIG_HOME: path.join(tmp, 'xdg'), PATH: `${shimDir}:${process.env.PATH}`, DSH_BIN: path.join(shimDir, 'dsh'), DSH_LOG: logFile }
    const wait = spawnSync('bash', ['-c',
      'for i in $(seq 1 40); do curl -fsS --max-time 1 http://127.0.0.1:18997/dsh-health >/dev/null 2>&1 && exit 0; sleep 0.2; done; exit 1',
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` } })
    assert.equal(wait.status, 0, 'http server must come up')
    const st = run(['--profile', 'web', 'start'], env)
    assert.equal(st.status, 0, st.stderr)
    const sp = run(['--profile', 'web', 'stop'], env)
    assert.equal(sp.status, 0, sp.stderr)
    const log = readFileSync(logFile, 'utf8')
    assert.match(log, /start requested \(raw mode/)
    assert.match(log, /started OK — pid=\d+ port=18997/)
    assert.match(log, /stop requested/)
    assert.match(log, /stopped/)
  } finally {
    if (httpServer) httpServer.kill('SIGKILL')
    rmSync(tmp, { recursive: true, force: true })
  }
})
