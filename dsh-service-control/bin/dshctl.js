#!/usr/bin/env node
/**
 * dshctl — standalone CLI for dsh service control.
 * Thin wrapper around scripts/control.sh (single source of truth).
 *
 * Usage:
 *   dshctl [--profile <name>] status|start|stop|restart|open
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const CONTROL = path.join(here, '..', 'scripts', 'control.sh')

const args = process.argv.slice(2)
const profileFlag = args.indexOf('--profile')
let profile = 'web'
let rest = args
if (profileFlag !== -1 && profileFlag + 1 < args.length) {
  profile = args[profileFlag + 1]
  rest = args.slice(0, profileFlag).concat(args.slice(profileFlag + 2))
}
const cmd = rest[0]

if (cmd === 'setup') {
  process.exit(doSetup() ? 0 : 1)
}
if (cmd === 'uninstall') {
  process.exit(doUninstall() ? 0 : 1)
}

if (!cmd || !['status', 'start', 'stop', 'restart', 'open'].includes(cmd)) {
  console.error('Usage: dshctl [--profile <name>] status|start|stop|restart|open')
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
      console.log(data.running
        ? (data.port ? `running (pid ${data.pid}, http://127.0.0.1:${data.port})` : `running (pid ${data.pid})`)
        : 'not running')
    } else if (data.ok) {
      if (cmd === 'open') {
        console.log(data.url ? `opened ${data.url}` : 'opened')
      } else if (data.already) {
        console.log(`already ${cmd === 'stop' ? 'stopped' : 'running'}${data.pid ? ` (pid ${data.pid})` : ''}`)
      } else {
        console.log(data.port ? `done (pid ${data.pid}, http://127.0.0.1:${data.port})` : 'done')
      }
    } else {
      console.error(data.error || 'failed')
      process.exit(1)
    }
  } else {
    console.log(stdout.trim())
  }
})

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
 * Only removes files we own (verified symlink target / our known names).
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

  console.log('\nCLI and completion removed. To fully remove the plugin itself:')
  console.log('  dsh plugin --profile web remove dsh-service-control')
  console.log('(repeat for each profile where it is installed; then restart dsh)')
  return ok
}
