/**
 * dsh-service-control — cli-startup command tree tests.
 *
 * Runs lib/cli-startup.js apply() against a mock ctx carrying cmdlineArgs +
 * appExit, then asserts the published cliCommand descriptor for every
 * namespace/subcommand (including aliases and flags), and the exit behavior
 * for --help and unknown commands.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, CLI_COMMAND_SERVICE, COMMAND_TREE } from '../lib/cli-startup.js'

/** 运行一次命令解析，返回 { command, exits }。 */
function run(argv) {
  const services = {}
  const exits = []
  services.cmdlineArgs = { get: () => Object.freeze([...argv]) }
  services.appExit = (code) => exits.push(code)
  const ctx = {
    provide: (name, value) => { services[name] = value },
    get: (name) => services[name],
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  apply(ctx)
  return { command: services[CLI_COMMAND_SERVICE], exits }
}

test('systemd subcommands parse to command descriptors (incl. aliases)', () => {
  const cases = {
    'systemd install': { namespace: 'systemd', sub: 'install' },
    'systemd reinstall': { namespace: 'systemd', sub: 'reinstall' },
    'systemd status': { namespace: 'systemd', sub: 'status' },
    'systemd ps': { namespace: 'systemd', sub: 'status' },
    'systemd start': { namespace: 'systemd', sub: 'start' },
    'systemd up': { namespace: 'systemd', sub: 'start' },
    'systemd stop': { namespace: 'systemd', sub: 'stop' },
    'systemd down': { namespace: 'systemd', sub: 'stop' },
    'systemd restart': { namespace: 'systemd', sub: 'restart' },
    'systemd reload': { namespace: 'systemd', sub: 'restart' },
    'systemd enable': { namespace: 'systemd', sub: 'enable' },
    'systemd on': { namespace: 'systemd', sub: 'enable' },
    'systemd disable': { namespace: 'systemd', sub: 'disable' },
    'systemd off': { namespace: 'systemd', sub: 'disable' },
    'systemd uninstall': { namespace: 'systemd', sub: 'uninstall' },
    'systemd remove': { namespace: 'systemd', sub: 'uninstall' },
  }
  for (const [argv, want] of Object.entries(cases)) {
    const { command } = run(argv.split(' '))
    assert.deepEqual(command, { namespace: want.namespace, sub: want.sub, args: [], options: {} }, argv)
  }
})

test('systemd journal carries the follow flag', () => {
  assert.deepEqual(run(['systemd', 'journal', '-f']).command.options, { follow: true })
  assert.deepEqual(run(['systemd', 'journal']).command.options, {})
})

test('systemd install/reinstall carry repeatable --env specs', () => {
  // 无 --env 时 options 保持空对象（选项无默认值）
  assert.deepEqual(run(['systemd', 'install']).command.options, {})
  assert.deepEqual(run(['systemd', 'reinstall']).command.options, {})
  // 显式 KEY=VALUE 与隐式 KEY（裸键）都是普通字符串，透传给 control.sh 解析
  assert.deepEqual(run(['systemd', 'install', '--env', 'OPENROUTER_API_KEY=sk-1']).command.options,
    { env: ['OPENROUTER_API_KEY=sk-1'] })
  assert.deepEqual(run(['systemd', 'install', '--env', 'OPENROUTER_API_KEY']).command.options,
    { env: ['OPENROUTER_API_KEY'] })
  // 可重复 --env 聚合为数组；值含 = 不截断
  const multi = run(['systemd', 'install', '--env', 'A=1', '--env', 'B=2']).command.options
  assert.deepEqual(multi.env, ['A=1', 'B=2'])
  assert.deepEqual(run(['systemd', 'install', '--env', 'TOKEN=ab==cd']).command.options.env,
    ['TOKEN=ab==cd'])
  // reinstall 与 install 行为一致
  assert.deepEqual(run(['systemd', 'reinstall', '--env', 'A=1', '--env', 'B']).command.options,
    { env: ['A=1', 'B'] })
  // 不把 --env 泄漏到其它子命令
  assert.deepEqual(run(['systemd', 'status']).command.options, {})
})

test('config get/set parse arguments', () => {
  assert.deepEqual(run(['config', 'get']).command, { namespace: 'config', sub: 'get', args: [], options: {} })
  assert.deepEqual(run(['config', 'get', 'DSH_BIN']).command.args, ['DSH_BIN'])
  assert.deepEqual(run(['config', 'set', 'DSH_BIN', 'dsh']).command.args, ['DSH_BIN', 'dsh'])
})

test('svc subcommands parse (incl. aliases and logs -f)', () => {
  assert.deepEqual(run(['svc', 'doctor']).command, { namespace: 'svc', sub: 'doctor', args: [], options: {} })
  assert.deepEqual(run(['svc', 'd']).command.sub, 'doctor')
  assert.deepEqual(run(['svc', 'probe']).command.sub, 'probe')
  assert.deepEqual(run(['svc', 'h']).command.sub, 'probe')
  assert.deepEqual(run(['svc', 'logs', '-f']).command.options, { follow: true })
})

test('self info parses (incl. alias i)', () => {
  assert.deepEqual(run(['self', 'info']).command, { namespace: 'self', sub: 'info', args: [], options: {} })
  assert.deepEqual(run(['self', 'i']).command.sub, 'info')
})

test('plugin namespace alias resolves to self (parser level)', () => {
  // 设计稿的 plugin 命名空间：与 dsh 启动器内置 `dsh plugin` 子命令撞名，
  // shell 里第一个位置参数为 "plugin" 的调用会被启动器拦截（实测 rc.2），
  // 故可达入口是 `self`；此别名供 parseCmdline 直连/未来启动器放开后使用。
  assert.deepEqual(run(['plugin', 'info']).command, { namespace: 'self', sub: 'info', args: [], options: {} })
})

test('self update parses with --check flag', () => {
  assert.deepEqual(run(['self', 'update']).command, { namespace: 'self', sub: 'update', args: [], options: {} })
  assert.deepEqual(run(['self', 'update', '--check']).command.options, { check: true })
  assert.deepEqual(run(['plugin', 'update']).command.sub, 'update')
})

test('completions parses positional shell and flags', () => {
  assert.deepEqual(run(['completions', 'fish']).command, {
    namespace: 'completions', sub: 'gen', args: ['fish'], options: {},
  })
  const ws = run(['completions', '--write-state', '--install']).command
  assert.equal(ws.options.writeState, true)
  assert.equal(ws.options.install, true)
  const shellFlag = run(['completions', '--shell', 'bash']).command
  assert.equal(shellFlag.options.shell, 'bash')
})

test('--help exits 0 without publishing a command', () => {
  const r = run(['--help'])
  assert.deepEqual(r.exits, [0])
  assert.equal(r.command, undefined)
})

test('unknown command exits 1', () => {
  const r = run(['nonsense'])
  assert.deepEqual(r.exits, [1])
  assert.equal(r.command, undefined)
})

test('COMMAND_TREE is the single source of truth for namespaces', () => {
  assert.deepEqual(Object.keys(COMMAND_TREE), ['self', 'config', 'svc', 'systemd'])
  assert.deepEqual(Object.keys(COMMAND_TREE.systemd), [
    'install', 'reinstall', 'status', 'start', 'stop', 'restart', 'enable', 'disable', 'uninstall', 'journal',
  ])
})
