/**
 * dsh-service-control — control.sh systemd lifecycle tests (install / enable /
 * disable / uninstall layering, raw-removed start/stop/restart, watchdog,
 * install/reinstall --env environment variables).
 *
 * Runs the real scripts/control.sh in isolated child processes with temp
 * HOME / XDG_CONFIG_HOME and fake systemctl / ss / dsh shims, then asserts:
 *   - install writes both units and starts the watchdog WITHOUT enabling
 *   - enable implies install when units are missing, then enables
 *   - disable stops the watchdog + disables but KEEPS unit files
 *   - uninstall stops both units, disables, and removes the files
 *   - start/stop/restart without install fail with a clear error (raw removed)
 *   - install --env bakes explicit/implicit values, escapes, and fails on missing
 *   - reinstall appends new keys, preserves user edits, skips existing keys
 *   - watchdog restarts a hung service and leaves a healthy one alone
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
for pid in $(pgrep -f '[d]sh --profile'); do
  echo "LISTEN 0 4096 127.0.0.1:${fakeSsPort} 0.0.0.0:* users:((\\"node\\",pid=$pid,fd=17))"
done
[ -n "$pid" ] || exit 1
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

function baseEnv(tmp, shimDir) {
  return {
    HOME: path.join(tmp, 'home'), XDG_CONFIG_HOME: path.join(tmp, 'xdg'),
    PATH: `${shimDir}:${process.env.PATH}`, DSH_BIN: path.join(shimDir, 'dsh'),
  }
}

test('install writes both units and starts the watchdog WITHOUT enabling', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-install-'))
  try {
    const { shimDir, systemctlLog } = makeShims(tmp)
    const env = baseEnv(tmp, shimDir)
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    const r = runControl(['--profile', 'web', 'install'], env)
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, true)
    assert.equal(out.installed, true)
    assert.equal(out.unit, 'dsh-web.service')

    const unitDir = path.join(tmp, 'xdg', 'systemd', 'user')
    assert.ok(existsSync(path.join(unitDir, 'dsh-web.service')), 'main unit written')
    assert.ok(existsSync(path.join(unitDir, 'dsh-web-watchdog.service')), 'watchdog unit written')
    const main = readFileSync(path.join(unitDir, 'dsh-web.service'), 'utf8')
    assert.match(main, /Restart=on-failure/, 'main unit must use Restart=on-failure')

    const calls = readFileSync(systemctlLog, 'utf8')
    assert.match(calls, /--user daemon-reload/)
    assert.match(calls, /--user start dsh-web-watchdog\.service/, 'install must start the watchdog')
    assert.ok(!calls.includes('--user enable'), 'install must NOT enable (autostart is enable)')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('enable implies install when units are missing, then enables', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-enable-'))
  try {
    const { shimDir, systemctlLog } = makeShims(tmp)
    const env = baseEnv(tmp, shimDir)
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    const r = runControl(['--profile', 'web', 'enable'], env)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).ok, true)
    const unitDir = path.join(tmp, 'xdg', 'systemd', 'user')
    assert.ok(existsSync(path.join(unitDir, 'dsh-web.service')), 'enable must install missing units')
    const calls = readFileSync(systemctlLog, 'utf8')
    assert.match(calls, /--user enable dsh-web\.service dsh-web-watchdog\.service/, 'enable must enable both')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('disable stops the watchdog and disables but KEEPS unit files', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-disable-'))
  try {
    const { shimDir, systemctlLog } = makeShims(tmp)
    const env = baseEnv(tmp, shimDir)
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    runControl(['--profile', 'web', 'install'], env)
    const r = runControl(['--profile', 'web', 'disable'], env)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).ok, true)
    const unitDir = path.join(tmp, 'xdg', 'systemd', 'user')
    assert.ok(existsSync(path.join(unitDir, 'dsh-web.service')), 'disable must KEEP the main unit')
    assert.ok(existsSync(path.join(unitDir, 'dsh-web-watchdog.service')), 'disable must KEEP the watchdog unit')
    const calls = readFileSync(systemctlLog, 'utf8')
    assert.match(calls, /--user stop dsh-web-watchdog\.service/, 'disable must stop the watchdog')
    assert.match(calls, /--user disable dsh-web\.service dsh-web-watchdog\.service/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('uninstall stops both units, disables, and removes the unit files', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-uninstall-'))
  try {
    const { shimDir, systemctlLog } = makeShims(tmp)
    const env = baseEnv(tmp, shimDir)
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    runControl(['--profile', 'web', 'install'], env)
    const r = runControl(['--profile', 'web', 'uninstall'], env)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).ok, true)
    const unitDir = path.join(tmp, 'xdg', 'systemd', 'user')
    assert.ok(!existsSync(path.join(unitDir, 'dsh-web.service')), 'main unit removed')
    assert.ok(!existsSync(path.join(unitDir, 'dsh-web-watchdog.service')), 'watchdog unit removed')
    const calls = readFileSync(systemctlLog, 'utf8')
    assert.match(calls, /--user stop dsh-web-watchdog\.service/)
    assert.match(calls, /--user stop dsh-web\.service/, 'uninstall must stop the main service')
    assert.match(calls, /--user disable dsh-web\.service dsh-web-watchdog\.service/)
    assert.match(calls, /--user daemon-reload/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('install --env bakes Environment lines into the main unit (explicit + implicit)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-env-install-'))
  try {
    const { shimDir } = makeShims(tmp)
    const env = { ...baseEnv(tmp, shimDir), MY_TOKEN: 'tok-abc' }
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    const r = runControl(['--profile', 'web', 'install',
      '--env', 'OPENROUTER_API_KEY=sk-123', '--env', 'MY_TOKEN'], env)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).ok, true)
    const unitDir = path.join(tmp, 'xdg', 'systemd', 'user')
    const main = readFileSync(path.join(unitDir, 'dsh-web.service'), 'utf8')
    assert.match(main, /Environment="OPENROUTER_API_KEY=sk-123"/, 'explicit --env must be written')
    assert.match(main, /Environment="MY_TOKEN=tok-abc"/, 'implicit --env must resolve from the shell env')
    // 看门狗 unit 不写用户 env
    const wd = readFileSync(path.join(unitDir, 'dsh-web-watchdog.service'), 'utf8')
    assert.ok(!wd.includes('OPENROUTER_API_KEY'), 'watchdog unit must not carry service env')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('install --env with unset or empty variable fails and writes no units', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-env-miss-'))
  try {
    const { shimDir } = makeShims(tmp)
    const env = { ...baseEnv(tmp, shimDir), EMPTY_VAR: '' }
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    for (const spec of ['SURELY_NOT_SET_XYZ', 'EMPTY_VAR']) {
      const r = runControl(['--profile', 'web', 'install', '--env', spec], env)
      assert.equal(r.status, 1, `${spec} must fail`)
      const out = JSON.parse(r.stdout)
      assert.equal(out.ok, false)
      assert.match(out.error, new RegExp(spec), 'error must name the missing key')
    }
    // 失败时不得写出任何 unit 文件
    assert.ok(!existsSync(path.join(tmp, 'xdg', 'systemd', 'user', 'dsh-web.service')))
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('install --env escapes systemd-special characters', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-env-esc-'))
  try {
    const { shimDir } = makeShims(tmp)
    const env = baseEnv(tmp, shimDir)
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    const r = runControl(['--profile', 'web', 'install',
      '--env', 'PCT=50%', '--env', 'DOLLAR=pa$$word', '--env', 'QUOTE=with"quote', '--env', 'SLASH=back\\slash'],
    env)
    assert.equal(r.status, 0, r.stderr)
    const main = readFileSync(path.join(tmp, 'xdg', 'systemd', 'user', 'dsh-web.service'), 'utf8')
    assert.match(main, /Environment="PCT=50%%"/, '% must be escaped as %% (specifier)')
    assert.match(main, /Environment="DOLLAR=pa\$\$word"/, '$ has no special meaning in Environment=, keep verbatim')
    assert.match(main, /Environment="QUOTE=with\\"quote"/, 'double quote must be escaped')
    assert.match(main, /Environment="SLASH=back\\\\slash"/, 'backslash must be escaped')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('reinstall appends new env keys into [Service] and preserves user edits', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-reinstall-'))
  try {
    const { shimDir, systemctlLog } = makeShims(tmp)
    const env = baseEnv(tmp, shimDir)
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    assert.equal(runControl(['--profile', 'web', 'install'], env).status, 0)
    const file = path.join(tmp, 'xdg', 'systemd', 'user', 'dsh-web.service')
    // 模拟用户手改 unit 文件：追加一行注释
    writeFileSync(file, readFileSync(file, 'utf8') + '\n# user edit\n')
    const r = runControl(['--profile', 'web', 'reinstall', '--env', 'OPENROUTER_API_KEY=sk-9'], env)
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, true)
    assert.deepEqual(out.env.added, ['OPENROUTER_API_KEY'])
    assert.deepEqual(out.env.skipped, [])
    const after = readFileSync(file, 'utf8')
    assert.ok(after.includes('# user edit'), 'user edits must be preserved')
    // 新行必须落在 [Service] 段内（[Install] 之前）
    const svc = after.split('[Service]')[1].split('[Install]')[0]
    assert.match(svc, /Environment="OPENROUTER_API_KEY=sk-9"/, 'env must be inserted inside [Service]')
    const calls = readFileSync(systemctlLog, 'utf8')
    assert.match(calls, /--user daemon-reload/, 'reinstall must daemon-reload')
    assert.ok(!calls.includes('--user restart'), 'reinstall must NOT restart automatically')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('reinstall skips keys already present and reports them', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-reinstall-skip-'))
  try {
    const { shimDir } = makeShims(tmp)
    const env = baseEnv(tmp, shimDir)
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    assert.equal(runControl(['--profile', 'web', 'install', '--env', 'KEEP=old'], env).status, 0)
    const r = runControl(['--profile', 'web', 'reinstall', '--env', 'KEEP=new', '--env', 'FRESH=1'], env)
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.env.added, ['FRESH'])
    assert.deepEqual(out.env.skipped, ['KEEP'])
    const main = readFileSync(path.join(tmp, 'xdg', 'systemd', 'user', 'dsh-web.service'), 'utf8')
    assert.match(main, /Environment="KEEP=old"/, 'existing key must keep its original value')
    assert.ok(!main.includes('KEEP=new'), 'skipped key must not be written')
    assert.match(main, /Environment="FRESH=1"/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('reinstall without an installed unit fails with a clear error', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-reinstall-miss-'))
  try {
    const { shimDir } = makeShims(tmp)
    const env = baseEnv(tmp, shimDir)
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    const r = runControl(['--profile', 'web', 'reinstall', '--env', 'A=1'], env)
    assert.equal(r.status, 1)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, false)
    assert.match(out.error, /not installed/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('runner forwards --env to control.sh through the full cmdline chain', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-chain-'))
  try {
    const { shimDir } = makeShims(tmp)
    const env = {
      HOME: path.join(tmp, 'home'), XDG_CONFIG_HOME: path.join(tmp, 'xdg'),
      PATH: `${shimDir}:${process.env.PATH}`, DSH_BIN: path.join(shimDir, 'dsh'),
    }
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    // 子进程模拟真实 boot：cli-startup 解析 → 发布 cliCommand → runner 执行 control.sh
    const chain = path.join(tmp, 'chain.mjs')
    writeFileSync(chain, `import { apply as cliApply } from '${pkgRoot}/lib/cli-startup.js'
import { apply as runnerApply } from '${pkgRoot}/lib/index.js'
const services = { cmdlineArgs: { get: () => Object.freeze([...process.argv.slice(2)]) } }
services.appExit = (code) => process.exit(code)
const ctx = { provide: (k, v) => { services[k] = v }, get: (k) => services[k] }
cliApply(ctx)
runnerApply(ctx, { command: services.cliCommand, profile: 'web' })
`)
    // install --env：解析 → 转发 → 写入 unit
    const r = spawnSync(process.execPath, [chain, 'systemd', 'install', '--env', 'OPENROUTER_API_KEY=sk-77'],
      { encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'ok')
    const main = readFileSync(path.join(tmp, 'xdg', 'systemd', 'user', 'dsh-web.service'), 'utf8')
    assert.match(main, /Environment="OPENROUTER_API_KEY=sk-77"/)
    // reinstall --env：追加 + renderJson 渲染 note 提示
    const r2 = spawnSync(process.execPath, [chain, 'systemd', 'reinstall', '--env', 'EXTRA=1'],
      { encoding: 'utf8', env })
    assert.equal(r2.status, 0, r2.stderr)
    assert.match(r2.stdout, /ok\nenvironment applies on next restart/,
      'runner must render the restart hint from the JSON note')
    const after = readFileSync(path.join(tmp, 'xdg', 'systemd', 'user', 'dsh-web.service'), 'utf8')
    assert.match(after, /Environment="EXTRA=1"/)
    // self info：只报告宿主 dsh 版本，不再输出 dsh-cmdline 副本详情
    const info = spawnSync(process.execPath, [chain, 'self', 'info'], { encoding: 'utf8', env })
    assert.equal(info.status, 0, info.stderr)
    // 测试环境的 PATH 里 shim 的假 dsh 会遮蔽真 dsh，故这里接受 not-detected 标记
    assert.match(info.stdout, /^dsh:\s+(?:\d+\.\d+\.\d+\S*|\(not detected\))$/m,
      'must report the hosting dsh version, or a clear marker when it cannot be located')
    assert.ok(!info.stdout.includes('dsh-cmdline'), 'cmdline copy details must not be printed')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('start/stop/restart without install fail with a clear error (raw removed)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-raw-gone-'))
  try {
    const { shimDir } = makeShims(tmp)
    const env = baseEnv(tmp, shimDir)
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    for (const cmd of ['start', 'stop', 'restart']) {
      const r = runControl(['--profile', 'web', cmd], env)
      assert.equal(r.status, 1, `${cmd} must fail without install`)
      assert.match(r.stdout, /not installed — run: dsh --profile ctl systemd install/)
    }
    // status 不报错，返回 installed:false
    const st = JSON.parse(runControl(['--profile', 'web', 'status'], env).stdout)
    assert.equal(st.installed, false)
    assert.equal(st.running, false)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('watchdog restarts a hung service (active but unresponsive)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-wd-'))
  try {
    const { shimDir, systemctlLog } = makeShims(tmp, { isActive: true, fakeSsPort: 1 })
    const env = {
      ...baseEnv(tmp, shimDir),
      DSH_WATCHDOG_INTERVAL: '0.2', DSH_WATCHDOG_FAIL_LIMIT: '2',
      DSH_WATCHDOG_PROBE_TIMEOUT: '1', DSH_WATCHDOG_COOLDOWN: '1',
    }
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    // 模拟 unit 文件存在 + 假 dsh 常驻（供 pgrep 匹配）
    runControl(['--profile', 'wdtest', 'install'], env)
    const fakeDsh = spawn(path.join(shimDir, 'dsh'), ['--profile', 'wdtest', '--no-open'], { stdio: 'ignore' })
    try {
      const r = spawnSync('timeout', ['6', 'bash', CONTROL, '--profile', 'wdtest', 'watchdog'], { encoding: 'utf8', env })
      assert.ok(r.status === 124 || r.status === 0, `watchdog exited ${r.status}`)
      assert.match(readFileSync(systemctlLog, 'utf8'), /--user restart dsh-wdtest\.service/, 'hung service must be restarted')
    } finally { fakeDsh.kill('SIGKILL') }
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('watchdog leaves a healthy service alone', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-wd-'))
  let httpServer = null
  try {
    const { shimDir, systemctlLog } = makeShims(tmp, { isActive: true, fakeSsPort: 18999 })
    const env = {
      ...baseEnv(tmp, shimDir),
      DSH_WATCHDOG_INTERVAL: '0.2', DSH_WATCHDOG_FAIL_LIMIT: '2',
      DSH_WATCHDOG_PROBE_TIMEOUT: '1', DSH_WATCHDOG_COOLDOWN: '1',
    }
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    httpServer = spawn(process.execPath, ['-e',
      "require('node:http').createServer((q,s)=>{s.writeHead(200);s.end('{\"ok\":true}')}).listen(18999,'127.0.0.1')",
    ], { stdio: 'ignore' })
    runControl(['--profile', 'wdtest', 'install'], env)
    const fakeDsh = spawn(path.join(shimDir, 'dsh'), ['--profile', 'wdtest', '--no-open'], { stdio: 'ignore' })
    const wait = spawnSync('bash', ['-c',
      'for i in $(seq 1 20); do curl -fsS --max-time 1 http://127.0.0.1:18999/dsh-health >/dev/null 2>&1 && exit 0; sleep 0.2; done; exit 1',
    ], { encoding: 'utf8', env: { ...process.env, PATH: env.PATH } })
    assert.equal(wait.status, 0, 'health server must come up')
    try {
      const r = spawnSync('timeout', ['5', 'bash', CONTROL, '--profile', 'wdtest', 'watchdog'], { encoding: 'utf8', env })
      assert.ok(r.status === 124 || r.status === 0, `watchdog exited ${r.status}`)
      assert.ok(!readFileSync(systemctlLog, 'utf8').includes('restart'), 'healthy service must not be restarted')
    } finally { fakeDsh.kill('SIGKILL') }
  } finally {
    if (httpServer) httpServer.kill('SIGKILL')
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('watchdog leaves a healthy service alone when only / responds (dsh 0.1.x has no /dsh-health)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshctl-wd-fallback-'))
  let httpServer = null
  try {
    const { shimDir, systemctlLog } = makeShims(tmp, { isActive: true, fakeSsPort: 18998 })
    const env = {
      ...baseEnv(tmp, shimDir),
      DSH_WATCHDOG_INTERVAL: '0.2', DSH_WATCHDOG_FAIL_LIMIT: '2',
      DSH_WATCHDOG_PROBE_TIMEOUT: '1', DSH_WATCHDOG_COOLDOWN: '1',
    }
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    // 模拟 dsh 0.1.x：/ 返回 200（活），/dsh-health 返回 404（端点不存在）。
    // 看门狗必须通过回退路径判定健康，绝不能重启。
    httpServer = spawn(process.execPath, ['-e',
      "require('node:http').createServer((q,s)=>{ if(q.url==='/dsh-health'){s.writeHead(404);s.end('not found')} else {s.writeHead(200);s.end('ok')} }).listen(18998,'127.0.0.1')",
    ], { stdio: 'ignore' })
    runControl(['--profile', 'wdtest', 'install'], env)
    const fakeDsh = spawn(path.join(shimDir, 'dsh'), ['--profile', 'wdtest', '--no-open'], { stdio: 'ignore' })
    const wait = spawnSync('bash', ['-c',
      'for i in $(seq 1 20); do curl -fsS --max-time 1 http://127.0.0.1:18998/ >/dev/null 2>&1 && exit 0; sleep 0.2; done; exit 1',
    ], { encoding: 'utf8', env: { ...process.env, PATH: env.PATH } })
    assert.equal(wait.status, 0, 'root server must come up')
    try {
      const r = spawnSync('timeout', ['5', 'bash', CONTROL, '--profile', 'wdtest', 'watchdog'], { encoding: 'utf8', env })
      assert.ok(r.status === 124 || r.status === 0, `watchdog exited ${r.status}`)
      assert.ok(!readFileSync(systemctlLog, 'utf8').includes('restart'), 'healthy service must not be restarted despite /dsh-health 404')
    } finally { fakeDsh.kill('SIGKILL') }
  } finally {
    if (httpServer) httpServer.kill('SIGKILL')
    rmSync(tmp, { recursive: true, force: true })
  }
})
