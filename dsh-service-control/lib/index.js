/**
 * dsh-service-control — runner: executes the command published by
 * lib/cli-startup.js and requests process exit.
 *
 * Follows the @deepseek-ai/dsh-headless runner pattern: this consumer row
 * reads its lazy config (`command: !!js ctx.cliCommand`), maps the invoked
 * namespace/subcommand to scripts/control.sh arguments (the single source of
 * truth), renders human-readable output, and calls `ctx.appExit(code)`.
 * `self info` and `completions` are handled in-process.
 */
import z from '@deepseek-ai/schemastery'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  generateCompletion, cacheFilePath, installPath, completionCacheDir,
  normalizeShell, detectShell, COMPLETION_SHELLS,
} from './completions.js'

export const name = 'dsh-service-control'
export const inject = ['cliCommand']

export const Config = z.object({
  // 由 cli-startup 通过 `!!js ctx.cliCommand` 注入的命令描述
  command: z.any(),
  // 被控目标 profile（ctl 控制面作用到的服务）；可在 ctl profile 的
  // cordis.patch.yml 中覆盖
  profile: z.string().pattern(/^[a-zA-Z0-9_.-]+$/).default('web'),
})

const here = path.dirname(fileURLToPath(import.meta.url))
const CONTROL = path.join(here, '..', 'scripts', 'control.sh')
const PKG = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('dsh-service-control: the launcher must provide ctx.appExit before the tree mounts')
  const io = { stdout: process.stdout, stderr: process.stderr, exit }
  run(ctx, config, io).catch((error) => fail(io, error))
}

async function run(ctx, { command, profile }, io) {
  // 注意：不 await ctx.get('loader') —— 我们的命令只调 control.sh 或进程内
  // 处理，不依赖树内服务。立即执行并 io.exit 能让退出赶在启动器建立
  // HMR/watcher 之前（launcher 的 "fast one-shot" 路径），否则 watcher 的
  // inotify 句柄会阻止事件循环排空、进程挂住不退出。
  const { namespace, sub, args, options } = command
  switch (namespace) {
    case 'self':
      if (sub === 'update') return runSelfUpdate(io, profile, command.options)
      return runPluginInfo(io, profile)
    case 'config':
      return runControl(profile, ['config', sub, ...args], io)
    case 'svc':
      if (sub === 'logs') return runControl(profile, ['logs', 'dsh', ...(options.follow ? ['-f'] : [])], io)
      return runControl(profile, [sub], io)
    case 'systemd': {
      if (sub === 'journal') return runControl(profile, ['logs', 'journal', ...(options.follow ? ['-f'] : [])], io)
      // install/reinstall 携带的 --env 规格原样透传给 control.sh（显式/隐式取值都在脚本内处理）
      const envArgs = (options.env ?? []).flatMap((e) => ['--env', e])
      return runControl(profile, [sub, ...envArgs], io)
    }
    case 'completions':
      return runCompletions(command, io)
    default:
      return fail(io, new Error(`unknown command: ${namespace}`))
  }
}

/** 执行 control.sh；跟随类命令（logs -f）用 spawn 流式输出。 */
function runControl(profile, args, io) {
  const isFollow = args.includes('-f')
  if (isFollow) {
    return new Promise((resolve) => {
      const child = spawn(CONTROL, ['--profile', profile, ...args], { stdio: 'inherit' })
      child.on('exit', (code) => { io.exit(code ?? 1); resolve() })
    })
  }
  return new Promise((resolve) => {
    execFile(CONTROL, ['--profile', profile, ...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (err.code ?? 1) : 0
      if (isTextCommand(args)) {
        if (stdout.trim()) io.stdout.write(stdout)
        if (stderr.trim()) io.stderr.write(stderr)
      } else {
        renderJson(stdout, stderr, io)
      }
      io.exit(code === 0 ? 0 : 1)
      resolve()
    })
  })
}

/** doctor / logs 输出人读文本，其余输出 JSON。 */
function isTextCommand(args) {
  return args[0] === 'doctor' || args[0] === 'logs'
}

/** 渲染 control.sh 的 JSON 输出为人读文本（移植自旧 dshctl）。 */
function renderJson(stdout, stderr, io) {
  let data
  try {
    data = JSON.parse(stdout)
  } catch {
    io.stderr.write(stderr.trim() || stdout.trim() || 'command failed\n')
    io.exit(1)
    return
  }
  if (data.error) {
    io.stderr.write(`${data.error}\n`)
    io.exit(1)
    return
  }
  if (data.ok === false) {
    io.stderr.write(`${data.message || 'failed'}\n`)
    io.exit(1)
    return
  }
  if (data.installed === false) {
    io.stdout.write('not installed — run: dsh --profile ctl systemd install\n')
    io.exit(0)
    return
  }
  if (data.running !== undefined) {
    const sysd = data.unit ? ` [systemd ${data.systemd}]` : ''
    io.stdout.write(data.running
      ? (data.port ? `running (pid ${data.pid}, http://127.0.0.1:${data.port})${sysd}\n` : `running (pid ${data.pid})${sysd}\n`)
      : `not running${sysd}\n`)
    io.exit(0)
    return
  }
  if (data.healthy !== undefined) {
    io.stdout.write(data.healthy
      ? `healthy (pid ${data.pid}, http://127.0.0.1:${data.port}, ${data.latency_ms}ms)\n`
      : `unhealthy: ${data.error || 'down'}\n`)
    io.exit(data.healthy ? 0 : 1)
    return
  }
  if (data.config) {
    for (const [k, v] of Object.entries(data.config)) io.stdout.write(`${k}=${v}\n`)
    io.exit(0)
    return
  }
  if (data.key !== undefined) {
    io.stdout.write(`${data.key}=${data.value}\n`)
    io.exit(0)
    return
  }
  if (data.ok === true) {
    io.stdout.write('ok\n')
    // 脚本返回的补充提示（如 reinstall 的"下次 restart 生效"、install 的野进程提醒）
    if (data.note) io.stdout.write(`${data.note}\n`)
    io.exit(0)
    return
  }
  io.stdout.write(`${stdout.trim()}\n`)
  io.exit(0)
}

/** self info：本包信息 + 目标 profile（进程内，不调 control.sh）。 */
function runPluginInfo(io, profile) {
  io.stdout.write(`name:      ${PKG.name}\n`)
  io.stdout.write(`version:   ${PKG.version}\n`)
  io.stdout.write(`path:      ${path.dirname(here)}\n`)
  io.stdout.write(`target:    ${profile}\n`)
  io.stdout.write(`dsh-cmdline: ${PKG.dependencies?.['@deepseek-ai/dsh-cmdline'] ?? '?'}\n`)
  io.exit(0)
}

/**
 * 检测安装来源与宿主 profile：
 *  - kind: 'link'（符号链接/git 仓库，开发安装）| 'file'（快照/registry）
 *  - realPath: 真实源码路径（Node import.meta.url 已解析符号链接）
 *  - isGit: 源码目录是否在 git 仓库内（含 monorepo 父目录 .git）
 *  - entry: 宿主 profile 的 node_modules/dsh-service-control 入口路径
 *  - profileDir: 宿主 profile 目录（不是被控目标！被控目标见 Config.profile）
 *  - pm: 宿主 profile 的包管理器（按 lock 文件检测）
 */
function detectInstall() {
  const realPath = path.dirname(here)
  const isGit = (() => {
    try {
      // monorepo：.git 可能在父目录
      let dir = realPath
      while (dir && dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '.git'))) return true
        dir = path.dirname(dir)
      }
    } catch {}
    return false
  })()
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  let entry = null
  let profileDir = null
  try {
    for (const p of fs.readdirSync(path.join(home, 'profiles'))) {
      if (p === 'node_modules') continue
      const e = path.join(home, 'profiles', p, 'node_modules', 'dsh-service-control')
      let rp
      try { rp = fs.realpathSync(e) } catch { continue }
      if (rp === realPath) {
        entry = e
        profileDir = path.join(home, 'profiles', p)
        break
      }
    }
  } catch {}
  const isLink = entry !== null && (() => {
    try { return fs.lstatSync(entry).isSymbolicLink() } catch { return false }
  })()
  let pm = 'npm'
  if (profileDir) {
    if (fs.existsSync(path.join(profileDir, 'pnpm-workspace.yaml')) || fs.existsSync(path.join(profileDir, 'pnpm-lock.yaml'))) pm = 'pnpm'
    else if (fs.existsSync(path.join(profileDir, 'yarn.lock'))) pm = 'yarn'
  }
  return { kind: isLink || isGit ? 'link' : 'file', realPath, isGit, entry, profileDir, pm }
}

/** self update：按安装来源自更新（--check 只预检）。 */
async function runSelfUpdate(io, profile, options = {}) {
  const { check } = options
  const { kind, realPath, isGit, entry, profileDir, pm } = detectInstall()
  io.stdout.write(`name:       ${PKG.name}\n`)
  io.stdout.write(`current:    ${PKG.version}\n`)
  io.stdout.write(`install:    ${kind}\n`)
  io.stdout.write(`path:       ${realPath}\n`)
  if (kind === 'link') {
    if (!isGit) {
      io.stderr.write('link 安装但源码目录不是 git 仓库，无法自更新（请手动替换源码）\n')
      io.exit(1)
      return
    }
    // 预检：fetch 远端并比较本地/远端 HEAD
    const git = (args) => new Promise((resolve) => {
      execFile('git', args, { cwd: realPath, encoding: 'utf8' }, (err, stdout) => resolve({ err, stdout: stdout.trim() }))
    })
    const fetch = await git(['fetch', '--quiet'])
    if (fetch.err) {
      io.stderr.write(`git fetch 失败：${fetch.err.message}\n`)
      io.exit(1)
      return
    }
    const local = await git(['rev-parse', 'HEAD'])
    const remote = await git(['rev-parse', '@{u}'])
    if (remote.err) {
      // 没有配置上游分支：用 ls-remote 直接对比远端（不修改本地状态）
      const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
      const ls = await git(['ls-remote', 'origin', branch.stdout === 'HEAD' ? 'HEAD' : `refs/heads/${branch.stdout}`])
      if (ls.err || !ls.stdout) {
        io.stderr.write('无法确定远端引用（无 upstream 且 ls-remote 失败）；请手动 git pull\n')
        io.exit(1)
        return
      }
      const remoteSha = ls.stdout.split(/\s+/)[0]
      if (remoteSha === local.stdout) {
        io.stdout.write('状态：     up-to-date（本地 HEAD 与远端一致）\n')
        if (!check) io.stdout.write('无需更新\n')
        io.exit(0)
        return
      }
      io.stdout.write(`状态：     远端 ${remoteSha.slice(0, 8)} 与本地不同（本地 ${local.stdout.slice(0, 8)}）\n`)
      if (check) {
        io.stdout.write('（--check 预检模式，未更新。执行 self update 拉取）\n')
        io.exit(0)
        return
      }
      io.stdout.write('正在拉取远端更新（fetch + ff-only merge）...\n')
      const fetch = await git(['fetch', 'origin', branch.stdout === 'HEAD' ? 'HEAD' : branch.stdout])
      if (fetch.err) {
        io.stderr.write(`git fetch 失败：${fetch.err.message}\n`)
        io.exit(1)
        return
      }
      const pull = await git(['merge', '--ff-only', 'FETCH_HEAD', '--quiet'])
      if (pull.err) {
        io.stderr.write(`合并失败：${pull.err.message}（本地有未提交改动或分叉，请手动处理）\n`)
        io.exit(1)
        return
      }
      const after = await git(['rev-parse', 'HEAD'])
      io.stdout.write(`更新完成：${local.stdout.slice(0, 8)} → ${after.stdout.slice(0, 8)}\n`)
      io.stdout.write('提示：下次调用生效（dsh 每次命令都是新进程）。若依赖有变化，在源码目录执行 pnpm install\n')
      io.exit(0)
      return
    }
    if (local.stdout === remote.stdout) {
      io.stdout.write('状态：     up-to-date（本地 HEAD 与远端一致）\n')
      if (!check) io.stdout.write('无需更新\n')
      io.exit(0)
      return
    }
    const behind = await git(['rev-list', '--count', 'HEAD..@{u}'])
    const ahead = await git(['rev-list', '--count', '@{u}..HEAD'])
    io.stdout.write(`状态：     ${behind.stdout} commit(s) 落后，${ahead.stdout} commit(s) 领先\n`)
    if (check) {
      io.stdout.write('（--check 预检模式，未更新。执行 self update 拉取）\n')
      io.exit(0)
      return
    }
    if (ahead.stdout !== '0') {
      io.stderr.write(`本地领先远端 ${ahead.stdout} 个 commit，ff-only 拉取会失败；请先手动处理本地改动\n`)
      io.exit(1)
      return
    }
    io.stdout.write('正在 git pull --ff-only ...\n')
    const pull = await git(['pull', '--ff-only', '--quiet'])
    if (pull.err) {
      io.stderr.write(`git pull 失败：${pull.err.message}\n`)
      io.exit(1)
      return
    }
    const after = await git(['rev-parse', 'HEAD'])
    io.stdout.write(`更新完成：${local.stdout.slice(0, 8)} → ${after.stdout.slice(0, 8)}\n`)
    io.stdout.write('提示：下次调用生效（dsh 每次命令都是新进程）。若依赖有变化，在源码目录执行 pnpm install\n')
    io.exit(0)
    return
  }
  // file / npm 安装：在宿主 profile 目录用包管理器升级到 latest
  if (!profileDir || !entry) {
    io.stderr.write('找不到插件安装位置（DSH_HOME/profiles 下无 dsh-service-control 入口）；请手动重装：\n')
    io.stderr.write(`  cd <ctl profile 目录> && pnpm add ${PKG.name}@latest\n`)
    io.exit(1)
    return
  }
  io.stdout.write(`profile:    ${profileDir}\n`)
  const runPm = (args) => new Promise((resolve) => {
    const child = spawn(pm, args, { cwd: profileDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('exit', (code) => resolve({ code, out, err }))
  })
  if (check) {
    // 预检：查 registry 最新版并对比（只读，不改任何文件）
    const view = await runPm(['view', PKG.name, 'version'])
    if (view.code !== 0 || !view.out.trim()) {
      io.stderr.write(`${pm} view 失败（无网络或包未发布）：${(view.err || view.out).trim()}\n`)
      io.exit(1)
      return
    }
    const latest = view.out.trim().split(/\s+/).pop()
    io.stdout.write(`latest:     ${latest}\n`)
    io.stdout.write(latest === PKG.version
      ? '状态：     已是最新\n'
      : `状态：     有新版本 → 执行 self update 升级到 ${latest}\n`)
    io.exit(0)
    return
  }
  io.stdout.write(`正在用 ${pm} 升级 ${PKG.name}@latest（${profileDir}）...\n`)
  const add = await runPm(['add', `${PKG.name}@latest`])
  if (add.out.trim()) io.stdout.write(add.out)
  if (add.err.trim()) io.stderr.write(add.err)
  if (add.code !== 0) {
    io.stderr.write(`升级失败（exit ${add.code}）；可手动执行：cd ${profileDir} && ${pm} add ${PKG.name}@latest\n`)
    io.exit(1)
    return
  }
  let after = PKG.version
  try {
    after = JSON.parse(fs.readFileSync(path.join(entry, 'package.json'), 'utf8')).version
  } catch {}
  io.stdout.write(`升级完成：${PKG.version} → ${after}（dsh 每次命令都是新进程，下次调用自动生效）\n`)
  io.exit(0)
}

/** completions：openclaw 模式（打印 / --write-state 缓存 / --install 放入默认加载路径）。 */
async function runCompletions(command, io) {
  const { args, options } = command
  const rawExplicit = options.shell ?? args[0]
  let explicit
  if (rawExplicit !== undefined && rawExplicit !== '') {
    explicit = normalizeShell(rawExplicit)
    if (!explicit) {
      fail(io, new Error(`unsupported shell: ${rawExplicit} (bash|zsh|fish)`))
      return
    }
  }
  const shell = explicit ?? detectShell()
  if (options.writeState) {
    const dir = completionCacheDir()
    fs.mkdirSync(dir, { recursive: true })
    for (const s of COMPLETION_SHELLS) {
      const file = cacheFilePath(s)
      fs.writeFileSync(file, generateCompletion(s))
      io.stdout.write(`cached ${file}\n`)
    }
  }
  if (options.install) {
    // 放入各 shell 的默认自动加载目录（不修改任何用户 rc 文件）。
    // 总是现场生成——缓存只是可选产物，避免装上过期脚本。
    const targets = explicit ? [explicit] : COMPLETION_SHELLS
    for (const s of targets) {
      const dest = installPath(s)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, generateCompletion(s))
      io.stdout.write(`installed ${dest}\n`)
    }
  }
  if (!options.writeState && !options.install) {
    io.stdout.write(generateCompletion(shell))
  }
  io.exit(0)
}

function fail(io, error) {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}
