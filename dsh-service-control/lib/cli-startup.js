/**
 * dsh-service-control — cli-startup: the `dsh --profile ctl` command parser.
 *
 * Follows the @deepseek-ai/dsh-headless pattern: this provider plugin injects
 * `cmdlineArgs`, builds the command tree (namespaces + subcommands) and, on a
 * successful parse, publishes the invoked command as the `cliCommand` service.
 * The runner row (the package main entry) consumes that service, executes the
 * command via scripts/control.sh (or in-process), and requests process exit.
 *
 * The command tree is defined once in COMMAND_TREE and shared with
 * lib/completions.js so the generated `dsh` shell completion matches the
 * parsed surface exactly.
 */
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

export const name = 'dsh-service-control-cli'
export const inject = ['cmdlineArgs']
/** Service published by this provider and injected by the runner row. */
export const CLI_COMMAND_SERVICE = 'cliCommand'

/**
 * 单一命令树数据源：namespace → { subcommand: [aliases] }。
 * `completions` 没有子命令（位置参数 + flag），单独处理。
 */
export const COMMAND_TREE = {
  self: { info: ['i'], update: [] },
  config: { get: [], set: [] },
  svc: { doctor: ['d'], logs: [], probe: ['h'], open: [] },
  systemd: {
    install: [],
    reinstall: [],
    status: ['ps'],
    start: ['up'],
    stop: ['down'],
    restart: ['reload'],
    enable: ['on'],
    disable: ['off'],
    uninstall: ['remove'],
    journal: [],
  },
}

/** 每个子命令的功能描述（补全与 --help 共用）。 */
export const COMMAND_DESCRIPTIONS = {
  'self': '插件自身管理',
  'self.info': '插件信息：版本、安装来源、目标 profile、服务 URL（运行中带 token）',
  'self.update': '自更新：按安装来源升级插件（--check 只预检不更新）',
  'config': '持久化配置',
  'config.get': '查看配置（无 key 列出全部）',
  'config.set': '设置并持久化配置（白名单键）',
  'svc': '服务运行时诊断与操作',
  'svc.doctor': '一键自检',
  'svc.logs': '查看 dsh 日志文件',
  'svc.probe': '探测健康（/dsh-health 或 /，可达性 + 延迟）',
  'svc.open': '打开服务 Web 面板（带 token URL；服务未运行不自动启动，仅提示）',
  'systemd': '服务的 systemd 生命周期管理',
  'systemd.install': '安装 unit（服务+看门狗）→ systemd 托管，不开机自启（--env 可携带环境变量）',
  'systemd.reinstall': '向已安装 unit 追加环境变量（保留用户修改；--env KEY=VALUE 或 KEY 从当前环境取值）',
  'systemd.status': '运行状态（pid/端口/URL/systemd state）',
  'systemd.start': '启动（systemctl start，就绪后开浏览器）',
  'systemd.stop': '停止（systemctl stop，绝不自动重启）',
  'systemd.restart': '重启（systemctl restart，不开浏览器）',
  'systemd.enable': '开机自启（无 unit 时先自动 install）',
  'systemd.disable': '停看门狗 + 取消自启（保留 unit 文件）',
  'systemd.uninstall': '删除 unit 文件（撤销托管）',
  'systemd.journal': '查看 systemd journal',
  'completions': '为 dsh 命令生成 shell 补全',
}

/**
 * 构建 commander 命令树。dispatch 回调收到解析出的命令描述
 * `{ namespace, sub, args, options }`（测试可注入记录器）。
 */
export function buildCommand(dispatch) {
  const program = new Command()
    .name('dsh --profile ctl')
    .description('DSH 服务控制：systemd 生命周期管理、配置与诊断（由 dsh-service-control 提供）')
    .helpOption('-h, --help', 'show this help')

  const wire = (ns, sub, aliases = [], action) => {
    const cmd = program.command(ns).description(COMMAND_DESCRIPTIONS[ns])
    for (const alias of aliases) cmd.alias(alias)
    return cmd
  }

  // self（plugin 别名见下）：设计稿中的 plugin 命名空间因与 dsh 启动器内置的
  // `dsh plugin <pnpm args>` 子命令撞名而改用 self；plugin 作为别名保留——
  // 注意 dsh 0.1.1-rc.2 启动器会把第一个位置参数为 "plugin" 的调用拦截到
  // 它自己的 plugin 子命令（-- 分隔符也无法绕过），故 shell 里实际可达的是
  // `dsh --profile ctl self info`。别名供 parseCmdline 直连通道/未来版本用。
  const selfNs = wire('self', null, ['plugin'])
  const pluginInfo = selfNs.command('info').description(COMMAND_DESCRIPTIONS['self.info'])
  pluginInfo.alias('i')
  pluginInfo.action(() => dispatch({ namespace: 'self', sub: 'info', args: [], options: {} }))
  const selfUpdate = selfNs.command('update').description(COMMAND_DESCRIPTIONS['self.update'])
  selfUpdate.option('--check', '只预检：报告安装来源与更新状态，不实际更新')
  selfUpdate.action((options) => dispatch({ namespace: 'self', sub: 'update', args: [], options: options ?? {} }))

  // config
  const config = wire('config')
  const configGet = config.command('get').description(COMMAND_DESCRIPTIONS['config.get'])
  configGet.argument('[key]')
  configGet.action((key) => dispatch({ namespace: 'config', sub: 'get', args: key ? [key] : [], options: {} }))
  const configSet = config.command('set').description(COMMAND_DESCRIPTIONS['config.set'])
  configSet.argument('<key>').argument('<value>')
  configSet.action((key, value) => dispatch({ namespace: 'config', sub: 'set', args: [key, value], options: {} }))

  // svc
  const svc = wire('svc')
  const svcDoctor = svc.command('doctor').description(COMMAND_DESCRIPTIONS['svc.doctor'])
  svcDoctor.alias('d')
  svcDoctor.action(() => dispatch({ namespace: 'svc', sub: 'doctor', args: [], options: {} }))
  const svcLogs = svc.command('logs').description(COMMAND_DESCRIPTIONS['svc.logs'])
  svcLogs.option('-f, --follow', '跟随输出')
  svcLogs.action((options) => dispatch({ namespace: 'svc', sub: 'logs', args: [], options }))
  const svcProbe = svc.command('probe').description(COMMAND_DESCRIPTIONS['svc.probe'])
  svcProbe.alias('h')
  svcProbe.action(() => dispatch({ namespace: 'svc', sub: 'probe', args: [], options: {} }))
  const svcOpen = svc.command('open').description(COMMAND_DESCRIPTIONS['svc.open'])
  svcOpen.action(() => dispatch({ namespace: 'svc', sub: 'open', args: [], options: {} }))

  // systemd
  const systemd = wire('systemd')
  for (const [sub, aliases] of Object.entries(COMMAND_TREE.systemd)) {
    const cmd = systemd.command(sub).description(COMMAND_DESCRIPTIONS[`systemd.${sub}`])
    for (const alias of aliases) cmd.alias(alias)
    if (sub === 'journal') cmd.option('-f, --follow', '跟随输出')
    if (sub === 'install' || sub === 'reinstall') {
      // 可重复 --env：KEY=VALUE 显式传值，或只写 KEY 从当前环境取值（未设置/为空则失败）
      cmd.option('--env <KEY[=VALUE]>', '设置环境变量：KEY=VALUE 显式传值，或只写 KEY 从当前环境取值（未找到则失败）；可重复',
        (value, prev) => [...(prev ?? []), value])
    }
    cmd.action((options) => dispatch({ namespace: 'systemd', sub, args: [], options: options ?? {} }))
  }

  // completions
  const completions = program.command('completions').description(COMMAND_DESCRIPTIONS['completions'])
  completions.argument('[shell]', 'bash|zsh|fish（默认检测当前 shell）')
  completions.option('--shell <shell>', '指定 shell（打印脚本）')
  completions.option('--write-state', '缓存全部 shell 脚本到 $DSH_HOME/completions（不打印）')
  completions.option('--install', '写入 shell profile（需先 --write-state）')
  completions.action((shell, options) =>
    dispatch({ namespace: 'completions', sub: 'gen', args: shell ? [shell] : [], options }))

  return program
}

/** Parse the launcher's inner arguments and publish the invoked command. */
export function apply(ctx) {
  const program = buildCommand((command) => {
    ctx.provide(CLI_COMMAND_SERVICE, command)
  })
  parseCmdline(ctx, program)
}
