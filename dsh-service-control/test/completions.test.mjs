/**
 * dsh-service-control — completions generation tests.
 *
 * Asserts the generated bash/zsh/fish scripts embed the command tree, and
 * that cache/profile path resolution honors $DSH_HOME / $HOME.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  generateCompletion, genBash, genZsh, genFish,
  normalizeShell, detectShell, completionCacheDir, cacheFilePath, installPath,
} from '../lib/completions.js'

test('normalizeShell accepts bash/zsh/fish and rejects others', () => {
  assert.equal(normalizeShell('bash'), 'bash')
  assert.equal(normalizeShell('ZSH'), 'zsh')
  assert.equal(normalizeShell('fish'), 'fish')
  assert.equal(normalizeShell('powershell'), undefined)
  assert.equal(normalizeShell(''), undefined)
})

test('detectShell falls back to zsh', () => {
  assert.equal(detectShell({ SHELL: '/usr/bin/fish' }), 'fish')
  assert.equal(detectShell({ SHELL: '/bin/zsh' }), 'zsh')
  assert.equal(detectShell({}), 'zsh')
})

test('cache and install paths honor DSH_HOME / HOME / XDG_DATA_HOME', () => {
  const env = { DSH_HOME: '/custom/dsh', HOME: '/home/u', XDG_DATA_HOME: '/xdg/data' }
  assert.equal(completionCacheDir(env), path.join('/custom/dsh', 'completions'))
  assert.equal(cacheFilePath('bash', env), path.join('/custom/dsh', 'completions', 'dsh.bash'))
  assert.equal(cacheFilePath('zsh', env), path.join('/custom/dsh', 'completions', 'dsh.zsh'))
  assert.equal(cacheFilePath('fish', env), path.join('/custom/dsh', 'completions', 'dsh.fish'))
  // 安装目标 = 各 shell 默认自动加载目录（不修改 rc 文件）
  assert.equal(installPath('bash', env), '/xdg/data/bash-completion/completions/dsh')
  assert.equal(installPath('bash', { HOME: '/home/u' }), '/home/u/.local/share/bash-completion/completions/dsh')
  assert.equal(installPath('zsh', env), '/home/u/.zsh/completions/_dsh')
  assert.equal(installPath('fish', env), '/home/u/.config/fish/completions/dsh.fish')
})

test('scripts embed the full command surface', () => {
  for (const [name, script] of [['bash', genBash()], ['zsh', genZsh()], ['fish', genFish()]]) {
    assert.match(script, /self/, `${name}: self namespace`)
    assert.match(script, /config/, `${name}: config namespace`)
    assert.match(script, /svc/, `${name}: svc namespace`)
    assert.match(script, /systemd/, `${name}: systemd namespace`)
    assert.match(script, /completions/, `${name}: completions namespace`)
    assert.match(script, /install/, `${name}: systemd install`)
    assert.match(script, /journal/, `${name}: systemd journal`)
    assert.match(script, /--profile/, `${name}: --profile completion`)
  }
})

test('zsh script has NO top-level executable code — registration relies on #compdef header only', () => {
  const zsh = genZsh()
  // compinit 只会把「仅含注释 + 单个函数定义」的 #compdef 文件注册为
  // 自动加载补全。任何顶层语句（如 compdef _dsh dsh 调用）都会让注册
  // 静默失效——按 TAB 无报错也无候选（真机复现过）。安装方式是放入
  // fpath 自动加载目录（installPath），不存在 rc 文件 source 模式。
  assert.match(zsh, /^#compdef dsh\n/, 'must start with #compdef header')
  const body = zsh.split('\n').slice(1).join('\n').replace(/^\s*#[^\n]*\n/gm, '')
  // 去掉注释后，顶层（未缩进）行只允许出现在 _dsh() { ... } 函数体内或为空行
  let depth = 0
  for (const [i, raw] of body.split('\n').entries()) {
    const line = raw.trimEnd()
    if (line === '') continue
    if (depth === 0) {
      assert.match(line, /^_dsh\(\) \{$/, `line ${i + 2}: top-level code not allowed: ${JSON.stringify(line)}`)
      depth = 1
    } else {
      if (/^\}$/.test(line)) { depth = 0; continue }
      assert.ok(/^\s{2}/.test(raw), `line ${i + 2}: unexpected unindented line inside function: ${JSON.stringify(line)}`)
    }
  }
  assert.equal(depth, 0, 'function definition must be closed')
})

test('zsh script never passes option-like strings to _describe', () => {
  const zsh = genZsh()
  // 以 - 开头的串传给 _describe 会被 compdescribe 当成其自身选项，
  // 触发 "invalid argument: --profile:..." 报错——必须用 compadd
  assert.ok(!zsh.includes("_describe -t option 'option' '--profile:"), 'must not pass --profile to _describe')
  assert.match(zsh, /compadd -- --profile/, 'must complete --profile via compadd')
})

test('zsh script passes _describe candidates as real zsh arrays, never string literals', () => {
  const zsh = genZsh()
  // 字符串字面量列表 '(name:desc name2:desc2)' 会被按空格切词，描述里的
  // 空格/引号会裂出 "status\""、"生命周期" 之类的垃圾候选。
  // 必须用真 zsh 数组（cmds/subs/profiles）+ 数组名传给 _describe。
  assert.ok(!/\(\\'|_describe[^\n]*'\(/.test(zsh), `must not pass parenthesized string literal to _describe`)
  assert.match(zsh, /_describe -t command 'command' cmds/, 'cmds branch must pass cmds array')
  assert.match(zsh, /_describe -t sub 'subcommand' subs/, 'args branch must pass subs array')
  assert.match(zsh, /_describe -t profiles 'profile' profiles/, 'profiles branch must pass profiles array')
  assert.match(zsh, /local -a cmds/, 'must declare cmds array')
  assert.match(zsh, /local -a subs/, 'must declare subs array')
})

test('zsh candidates cover full command tree with descriptions from COMMAND_DESCRIPTIONS', () => {
  const zsh = genZsh()
  // 一级：五个 namespace 全部出现（completions 不在 COMMAND_TREE，需单独补）
  for (const ns of ['self', 'config', 'svc', 'systemd', 'completions']) {
    assert.ok(new RegExp(`'${ns}:`).test(zsh), `first-level candidate missing: ${ns}`)
  }
  // 二级：systemd 全部子命令 + 别名
  for (const sub of ['install', 'status', 'start', 'stop', 'restart', 'enable', 'disable', 'uninstall', 'journal', 'ps', 'up', 'down', 'reload', 'on', 'off', 'remove']) {
    assert.ok(new RegExp(`'${sub}:`).test(zsh), `systemd candidate missing: ${sub}`)
  }
})

test('fish script uses fish-compatible parameter handling', () => {
  const fish = genFish()
  assert.ok(!fish.includes('${DSH_HOME'), 'fish has no ${...} expansion — must use set -q')
  assert.match(fish, /set -q DSH_HOME/, 'must branch on DSH_HOME presence')
})

test('generateCompletion rejects unknown shells', () => {
  assert.throws(() => generateCompletion('powershell'), /unsupported shell/)
})

test('all shells recognize --profile=ctl (equals form) for ctl gating', () => {
  // 等号形式下命令树必须照常补全：旧版只认分离式 "--profile ctl"，
  // 导致 `dsh --profile=ctl syst<TAB>` 静默无候选。
  const bash = genBash()
  assert.match(bash, /--profile=ctl\|-p=ctl\|-pctl/, 'bash: equals form in case pattern')

  const zsh = genZsh()
  assert.match(zsh, /\(--profile=\*\|-p=\*\|-pctl\)/, 'zsh: equals form case pattern')
  assert.match(zsh, /words\[i\]#\*=}/, 'zsh: strip prefix up to =')

  const fish = genFish()
  assert.match(fish, /'--profile=ctl' '-p=ctl' '-pctl'/, 'fish: equals form in switch')
  assert.match(fish, /__dsh_have_ctl/, 'fish: custom gate function')
})

test('all shells complete subcommand options (--check/--follow/--shell/--install)', () => {
  const zsh = genZsh()
  assert.match(zsh, /\(update\) opts=\(--check\)/, 'zsh: self update --check')
  assert.match(zsh, /\(logs\) opts=\(-f --follow\)/, 'zsh: svc logs -f/--follow')
  assert.match(zsh, /\(journal\) opts=\(-f --follow\)/, 'zsh: systemd journal -f/--follow')
  assert.match(zsh, /opts=\(--shell --write-state --install\)/, 'zsh: completions options')
  assert.match(zsh, /compadd -p '--shell=' -- bash zsh fish/, 'zsh: --shell= value completion')
  assert.match(zsh, /compadd -- \$opts/, 'zsh: option candidates via compadd')

  const bash = genBash()
  assert.match(bash, /--check/, 'bash: --check candidate')
  assert.match(bash, /-f --follow/, 'bash: -f/--follow candidates')
  assert.match(bash, /--write-state --install/, 'bash: completions option candidates')
  assert.match(bash, /--shell=\*\)/, 'bash: --shell= value completion')
  assert.match(bash, /\$\{cur#--shell=\}/, 'bash: strip --shell= prefix')

  const fish = genFish()
  assert.match(fish, /-l check -d/, 'fish: --check option')
  assert.match(fish, /-s f -l follow/, 'fish: -f/--follow option')
  assert.match(fish, /-l write-state/, 'fish: --write-state option')
  assert.match(fish, /-l install/, 'fish: --install option')
  assert.match(fish, /-l shell -r -d '指定 shell' -a 'bash zsh fish'/, 'fish: --shell value candidates')
})
