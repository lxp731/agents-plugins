#!/usr/bin/env node
/**
 * dshctl — standalone CLI for dsh service control.
 * Thin wrapper around scripts/control.sh (single source of truth).
 *
 * Usage:
 *   dshctl [--profile <name>] status|start|stop|restart|open|enable|disable
 */
import { execFile, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const CONTROL = path.join(here, '..', 'scripts', 'control.sh')

const args = process.argv.slice(2)
const profileFlag = args.indexOf('--profile')
let profile = 'web'
let profileFromFlag = false
let rest = args
if (profileFlag !== -1 && profileFlag + 1 < args.length) {
  profile = args[profileFlag + 1]
  profileFromFlag = true
  rest = args.slice(0, profileFlag).concat(args.slice(profileFlag + 2))
}
const cmd = rest[0]
// 兼容 `dshctl stop web` 这种位置参数指定 profile 的写法
if (!profileFromFlag && rest[1] && !rest[1].startsWith('-')) {
  profile = rest[1]
}

if (cmd === 'setup') {
  process.exit(doSetup() ? 0 : 1)
}
if (cmd === 'uninstall') {
  process.exit(doUninstall() ? 0 : 1)
}

if (!cmd || !['status', 'start', 'stop', 'restart', 'open', 'enable', 'disable'].includes(cmd)) {
  console.error('Usage: dshctl [--profile <name>] status|start|stop|restart|open|enable|disable')
  console.error('       dshctl enable     # create user systemd unit + enable boot autostart')
  console.error('       dshctl disable    # disable boot autostart + remove unit file')
  console.error('       dshctl setup      # link CLI to PATH and install shell completion')
  console.error('       dshctl uninstall  # remove CLI link and installed completions')
  process.exit(64)
}

execFile(CONTROL, ['--profile', profile, cmd], { encoding: 'utf8' }, (err, stdout, stderr) => {
  if (err) {
    const info = (() => { try { return JSON.parse(stdout) } catch { return null } })()
    console.error(info?.error || stderr.trim() || `command failed (${err.code})`)
    process.exit(err.code ?? 1)
  }
  const data = (() => { try { return JSON.parse(stdout) } catch { return null } })()
  if (data) {
    if (data.running !== undefined) {
      const sysd = data.unit ? ` [systemd ${data.systemd}]` : ''
      console.log(data.running
        ? (data.port ? `running (pid ${data.pid}, http://127.0.0.1:${data.port})${sysd}` : `running (pid ${data.pid})${sysd}`)
        : `not running${sysd}`)
    } else if (data.ok) {
      if (cmd === 'open') {
        console.log(data.url ? `opened ${data.url}` : 'opened')
      } else if (cmd === 'enable') {
        console.log(`boot autostart enabled (${data.unit} + ${data.watchdog})`)
        if (data.note) console.warn(`note: ${data.note}`)
      } else if (cmd === 'disable') {
        console.log(data.disabled
          ? `boot autostart disabled (${data.unit} + ${data.watchdog})`
          : `not enabled — nothing to disable (${data.unit})`)
        if (data.note) console.warn(`note: ${data.note}`)
      } else if (data.already) {
        const loc = data.port
          ? ` (pid ${data.pid}, http://127.0.0.1:${data.port})`
          : (data.pid ? ` (pid ${data.pid})` : '')
        console.log(`${cmd === 'stop' ? 'already stopped' : 'already running'}${loc}${browserNote(data)}`)
      } else {
        const loc = data.port ? ` (pid ${data.pid}, http://127.0.0.1:${data.port})` : ''
        console.log(`${loc ? 'done' + loc : 'done'}${browserNote(data)}`)
      }
    } else {
      console.error(data.error || 'failed')
      process.exit(1)
    }
  } else {
    console.log(stdout.trim())
  }
})

/** start/restart 自动打开浏览器后附加的提示 */
function browserNote(data) {
  if (data.opened === true) return ' — browser opened'
  if (data.opened === false) return ' (browser open failed)'
  return ''
}

/**
 * dshctl setup — link CLI into ~/.local/bin and install shell completion.
 * Idempotent: safe to re-run. Never touches shell rc files.
 */
function doSetup() {
  const home = os.homedir()
  const selfReal = fs.realpathSync(fileURLToPath(import.meta.url))
  const pkgRoot = path.join(path.dirname(selfReal), '..')
  let ok = true

  // ── 1. CLI symlink → ~/.local/bin ──
  const localBin = path.join(home, '.local', 'bin')
  const target = path.join(localBin, 'dshctl')
  const inPath = (process.env.PATH || '').split(':').includes(localBin)
  try {
    if (fs.existsSync(target)) {
      const existing = fs.lstatSync(target)
      if (existing.isSymbolicLink() && fs.realpathSync(target) === selfReal) {
        console.log(`✓ dshctl already linked (${target})`)
      } else {
        console.warn(`⚠  ${target} exists and is not our symlink — left untouched`)
        ok = false
      }
    } else {
      fs.mkdirSync(localBin, { recursive: true })
      fs.symlinkSync(selfReal, target)
      console.log(`✓ linked dshctl → ${target}`)
    }
  } catch (err) {
    console.error(`✗ failed to link ${target}: ${err.message}`)
    ok = false
  }
  if (!inPath) {
    console.warn(`⚠  ${localBin} is not in PATH — add it to your shell rc, or link dshctl elsewhere`)
  }

  // ── 2. shell completion ──
  const zshSrc = path.join(pkgRoot, 'completions', '_dshctl')
  const bashSrc = path.join(pkgRoot, 'completions', 'dshctl.bash')
  const fishSrc = path.join(pkgRoot, 'completions', 'dshctl.fish')
  const shell = (process.env.SHELL || '').split('/').pop()
  const hasZshRc = fs.existsSync(path.join(home, '.zshrc'))
  const hasBashRc = fs.existsSync(path.join(home, '.bashrc'))
  const hasFish = fs.existsSync(path.join(home, '.config', 'fish'))

  const copy = (src, dest) => {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      console.log(`✓ completion installed: ${dest}`)
    } catch (err) {
      console.error(`✗ failed to install completion: ${err.message}`)
      ok = false
    }
  }

  if (fs.existsSync(zshSrc) && (shell === 'zsh' || hasZshRc)) {
    const dir = path.join(home, '.zsh', 'completions')
    copy(zshSrc, path.join(dir, '_dshctl'))
  }
  if (fs.existsSync(bashSrc) && (shell === 'bash' || hasBashRc)) {
    copy(bashSrc, path.join(home, '.local', 'share', 'bash-completion', 'completions', 'dshctl'))
  }
  if (hasFish) {
    copy(fishSrc, path.join(home, '.config', 'fish', 'completions', 'dshctl.fish'))
  }
  if (!hasZshRc && !hasBashRc && !hasFish) {
    console.warn('⚠  no shell rc detected — copy completions manually (see README)')
    ok = false
  }

  console.log('\nDone. Open a NEW terminal (or run `compinit -C` in zsh) to activate completion.')
  return ok
}

/**
 * dshctl uninstall — remove everything setup() installed.
 * Also removes systemd user units created by `dshctl enable`
 * (dsh-<profile>.service), after disabling them.
 * Only removes files we own (verified symlink target / our unit signature).
 * Does NOT remove the plugin from the dsh profile (see printed instructions).
 */
function doUninstall() {
  const home = os.homedir()
  const selfReal = fs.realpathSync(fileURLToPath(import.meta.url))
  let ok = true

  const removeIfOurs = (file, verify) => {
    try {
      if (!fs.existsSync(file)) return
      if (verify && !verify()) {
        console.warn(`⚠  ${file} exists but is not ours — left untouched`)
        ok = false
        return
      }
      fs.unlinkSync(file)
      console.log(`✗ removed ${file}`)
    } catch (err) {
      console.error(`✗ failed to remove ${file}: ${err.message}`)
      ok = false
    }
  }

  // 1. CLI symlink（仅当指向当前 dshctl 本体时删除）
  const linkTarget = path.join(home, '.local', 'bin', 'dshctl')
  removeIfOurs(linkTarget, () => {
    const st = fs.lstatSync(linkTarget)
    return st.isSymbolicLink() && fs.realpathSync(linkTarget) === selfReal
  })

  // 2. 补全文件（文件名为本插件独有，直接删除）
  removeIfOurs(path.join(home, '.zsh', 'completions', '_dshctl'))
  removeIfOurs(path.join(home, '.local', 'share', 'bash-completion', 'completions', 'dshctl'))
  removeIfOurs(path.join(home, '.config', 'fish', 'completions', 'dshctl.fish'))

  // 3. systemd user units（dshctl enable 创建的开机自启 unit）
  //    仅删除我们自己的：文件名 dsh-*.service 且内容含模板签名
  //    （--profile 兼容添加 marker 之前创建的 unit）
  const unitDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user')
  let removedUnits = 0
  let haveSystemctl = true
  try {
    const units = fs
      .readdirSync(unitDir)
      .filter((f) => /^dsh-.+\.service$/.test(f))
      .filter((f) => {
        try {
          const content = fs.readFileSync(path.join(unitDir, f), 'utf8')
          return content.includes('--profile') || content.includes('managed by dsh-service-control')
        } catch {
          return false
        }
      })
    for (const unit of units) {
      const file = path.join(unitDir, unit)
      // 先 disable（unit 文件尚在时解除 .wants 链接），再删文件
      if (haveSystemctl) {
        const r = spawnSync('systemctl', ['--user', 'disable', unit], { stdio: 'ignore', timeout: 10000 })
        if (r.error && r.error.code === 'ENOENT') haveSystemctl = false
      }
      try {
        fs.unlinkSync(file)
        console.log(`✗ removed ${file}`)
        removedUnits += 1
      } catch (err) {
        console.error(`✗ failed to remove ${file}: ${err.message}`)
        ok = false
      }
    }
    if (removedUnits > 0) {
      if (haveSystemctl) {
        spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', timeout: 10000 })
      } else {
        console.warn('⚠  systemctl not found — removed unit file(s); boot autostart symlinks (if any) were left untouched')
      }
    }
  } catch (err) {
    // 目录不存在等：没有 unit 需要处理
    if (err.code !== 'ENOENT') {
      console.error(`✗ failed to scan systemd user units: ${err.message}`)
      ok = false
    }
  }

  console.log(`\nCLI and completion removed.${removedUnits > 0 ? ` ${removedUnits} systemd unit${removedUnits > 1 ? 's' : ''} removed.` : ''}`)
  console.log('To fully remove the plugin itself:')
  console.log('  dsh plugin --profile web remove dsh-service-control')
  console.log('(repeat for each profile where it is installed; then restart dsh)')
  return ok
}
