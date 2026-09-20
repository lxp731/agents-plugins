import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

const NETWORK_PROXY_NAMESPACE = 'network-proxy'

/**
 * Every proxy environment name this plugin manages, in both casings.
 *
 * `@deepseek-ai/dsh-http-proxy` reads the lowercase spelling first, so a `.env`
 * that carries both has to be cleared in both; a leftover lowercase entry would
 * otherwise shadow the value this plugin writes.
 */
const MANAGED_PROXY_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]
/** Marks the `.env` block this plugin owns, so removing it leaves no residue. */
const ENV_FILE_MARKER = '# Managed by dsh-network-proxy (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY)'

const NetworkProxySettingsSchema = z.object({
  mode: z.union([
    z.const('system').description('Follow system'),
    z.const('manual').description('Manual proxy'),
    z.const('direct').description('Direct'),
  ]).default('system'),
  url: z.string().default(''),
})

function validateSettings(value) {
  if (value.mode !== 'manual') return
  const raw = typeof value.url === 'string' ? value.url.trim() : ''
  if (!raw) throw new Error('Manual proxy requires an HTTP or HTTPS URL')
  let url
  try {
    url = new URL(normalizeProxyUrl(raw))
  } catch {
    throw new Error('Manual proxy must be a valid HTTP or HTTPS URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Manual proxy supports only HTTP and HTTPS URLs')
  }
}

function normalizeProxyUrl(value) {
  if (!value) return undefined
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`
}

function parseWindowsProxyServer(value) {
  const entries = String(value ?? '').split(';').map((entry) => entry.trim()).filter(Boolean)
  if (!entries.length) return {}
  const named = Object.fromEntries(entries.flatMap((entry) => {
    const separator = entry.indexOf('=')
    return separator < 0 ? [] : [[entry.slice(0, separator).toLowerCase(), entry.slice(separator + 1)]]
  }))
  const fallback = entries.find((entry) => !entry.includes('='))
  return {
    httpProxy: normalizeProxyUrl(named.http ?? fallback),
    httpsProxy: normalizeProxyUrl(named.https ?? named.http ?? fallback),
  }
}

function readWindowsSystemProxy() {
  // Reads the proxy of the account DSH runs as. When DSH runs as a Windows
  // service (e.g. NSSM as LocalSystem), the process's own HKCU is the service
  // hive, not the interactive user's, so we additionally resolve the console
  // user's SID (Win32_ComputerSystem.UserName) and prefer their hive when the
  // two differ. SYSTEM has read access to every HKU profile; interactive
  // sessions fall back to their own HKCU as before.
  const script = [
    'function Get-ProxyInfo([string]$Path){',
    "$p=Get-ItemProperty -LiteralPath $Path -ErrorAction SilentlyContinue;",
    'if(-not $p){return $null}',
    '[pscustomobject]@{',
    'ProxyEnable=[int]$p.ProxyEnable;',
    'ProxyServer=[string]$p.ProxyServer;',
    'ProxyOverride=[string]$p.ProxyOverride;',
    'AutoConfigURL=[string]$p.AutoConfigURL',
    '}',
    '}',
    "$current=Get-ProxyInfo 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';",
    '$interactive=$null;$interactiveSid=$null;',
    'try{',
    '$cs=Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop;',
    '}catch{$cs=Get-WmiObject -Class Win32_ComputerSystem -ErrorAction SilentlyContinue}',
    'if($cs -and $cs.UserName){',
    'try{',
    '$interactiveSid=(New-Object System.Security.Principal.NTAccount($cs.UserName)).Translate([System.Security.Principal.SecurityIdentifier]).Value;',
    '}catch{$interactiveSid=$null}',
    '}',
    'if($interactiveSid -and $interactiveSid -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value){',
    "$interactive=Get-ProxyInfo ('Registry::HKEY_USERS\\' + $interactiveSid + '\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings');",
    '}',
    '$resolved=if($interactive -and $interactive.ProxyEnable){$interactive}else{$current};',
    '[pscustomobject]@{',
    'current=$current;',
    'interactive=$interactive;',
    'interactiveSid=$interactiveSid;',
    'resolved=$resolved',
    '}|ConvertTo-Json -Compress',
  ].join('')
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const raw = JSON.parse(output)
  const config = raw.resolved ?? raw
  if (!config.ProxyEnable) {
    if (config.AutoConfigURL) throw new Error('Windows PAC proxy is not supported; use Manual proxy')
    return {}
  }
  const proxies = parseWindowsProxyServer(config.ProxyServer)
  if (!proxies.httpProxy && !proxies.httpsProxy) {
    throw new Error('Windows system proxy is enabled but no proxy server is configured')
  }
  return {
    ...proxies,
    noProxy: String(config.ProxyOverride ?? '').split(';').map((entry) => entry.trim()).filter((entry) => entry && entry !== '<local>').join(','),
  }
}

/**
 * Read one proxy name from the launch snapshot's `process` layer — the
 * environment the launcher inherited, before any `.env` was merged in.
 *
 * The snapshot keeps its layers apart precisely so this answer can exclude the
 * harness-home `.env` this plugin maintains: `loadLayeredEnv` copies that file
 * into `process.env`, so reading `process.env` here would make "follow system"
 * inherit this plugin's own last decision after a manual-mode restart.
 */
function inheritedValue(ctx, name) {
  const snapshot = launchEnvironmentOf(ctx)
  for (const candidate of [name, name.toUpperCase()]) {
    const value = snapshot.getFrom(candidate, ['process'])?.value
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/**
 * The proxy "follow system" resolves to: the inherited launch environment on
 * every platform, plus the Windows registry on win32 — the inherited
 * environment does not carry the system-configured proxy there. An inherited
 * value wins over the registry one when both are present.
 */
function systemProxyOptions(ctx) {
  const inherited = {
    httpProxy: inheritedValue(ctx, 'http_proxy'),
    httpsProxy: inheritedValue(ctx, 'https_proxy'),
    allProxy: inheritedValue(ctx, 'all_proxy'),
    noProxy: inheritedValue(ctx, 'no_proxy'),
  }
  if (process.platform !== 'win32') return inherited
  const system = readWindowsSystemProxy()
  return {
    ...inherited,
    httpProxy: inherited.httpProxy ?? system.httpProxy,
    httpsProxy: inherited.httpsProxy ?? system.httpsProxy,
    noProxy: inherited.noProxy ?? system.noProxy,
  }
}

/**
 * Build a launch-environment snapshot with the shape
 * `installProxyFromEnvironment` reads — `get(name) -> { value } | undefined`.
 * An absent or blank value stays unset, exactly as it would at launch.
 */
function createSnapshot(values) {
  const entries = new Map()
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue
    entries.set(name.toLowerCase(), { value: String(value) })
  }
  return { get: (name) => entries.get(String(name).toLowerCase()) }
}

/** The proxy policy the selected mode asks for, expressed as a launch snapshot. */
function launchSnapshotFor(ctx, value) {
  if (value.mode === 'manual') {
    const url = normalizeProxyUrl(value.url) ?? value.url
    return createSnapshot({
      http_proxy: url,
      https_proxy: url,
      no_proxy: inheritedValue(ctx, 'no_proxy'),
    })
  }
  if (value.mode === 'direct') return createSnapshot({})
  const system = systemProxyOptions(ctx)
  return createSnapshot({
    http_proxy: system.httpProxy,
    https_proxy: system.httpsProxy,
    all_proxy: system.allProxy,
    no_proxy: system.noProxy,
  })
}

/** `$DSH_HOME/.env` — the launch-time proxy source the harness reads before any plugin mounts. */
function resolveEnvFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.env')
}

function isManagedProxyName(name) {
  return MANAGED_PROXY_NAMES.some((candidate) => candidate.toLowerCase() === name.toLowerCase())
}

/** The proxy entries the `.env` file should carry for `value`. */
function desiredEnvEntries(value) {
  if (value.mode !== 'manual') return {}
  const url = normalizeProxyUrl(value.url) ?? value.url
  return { HTTP_PROXY: url, HTTPS_PROXY: url }
}

/**
 * Rewrite only the proxy block of `$DSH_HOME/.env`, preserving every other line
 * the user put there. The file is replaced atomically and kept at 0600: a proxy
 * URL may carry credentials.
 */
function syncEnvFile(value) {
  const path = resolveEnvFilePath()
  let existing
  try {
    existing = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    existing = undefined
  }
  const kept = []
  if (existing !== undefined) {
    for (const line of existing.split(/\r?\n/)) {
      if (line.trim() === ENV_FILE_MARKER) continue
      const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z\d_]*)\s*=/.exec(line)
      if (assignment !== null && isManagedProxyName(assignment[1])) continue
      kept.push(line)
    }
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  const wanted = Object.entries(desiredEnvEntries(value))
  const lines = [...kept]
  if (wanted.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(ENV_FILE_MARKER)
    for (const [name, url] of wanted) lines.push(`${name}=${url}`)
  }
  const next = lines.length === 0 ? '' : `${lines.join('\n')}\n`
  if (next === (existing ?? '')) return
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, next, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      NETWORK_PROXY_NAMESPACE,
      NetworkProxySettingsSchema,
      { applies: 'live', validate: validateSettings },
    )
    const report = (message) => { ctx.logger?.warn?.('network-proxy: %s', String(message)) }

    let disposePolicy
    let generation = 0
    let released = false

    // The live half: `installProxyFromEnvironment` owns the process-wide policy
    // that `dsh-web-fetch-http` consults through `proxyRouteFor`, so re-installing
    // it here is what makes a mode switch reach the fetch tool without a restart.
    const activate = async (value) => {
      const mine = ++generation
      const previous = disposePolicy
      disposePolicy = undefined
      if (previous !== undefined) {
        try {
          await previous()
        } catch (error) {
          report(`failed to restore the previous policy: ${String(error)}`)
        }
      }
      let dispose
      try {
        validateSettings(value)
        dispose = await installProxyFromEnvironment(launchSnapshotFor(ctx, value), report)
      } catch (error) {
        report(`failed to install the ${value?.mode ?? 'unknown'} proxy policy: ${String(error)}`)
        return
      }
      if (released || mine !== generation) {
        try { await dispose() } catch {}
        return
      }
      disposePolicy = dispose
      // The durable half: `.env` carries the same decision into the next launch,
      // before any plugin mounts. A failure here must not undo the live policy.
      try {
        syncEnvFile(value)
      } catch (error) {
        report(`failed to update ${resolveEnvFilePath()}: ${String(error)}`)
      }
    }

    void activate(scope.get())
    settingsCtx.effect(() => scope.watch((next) => { void activate(next) }), 'network-proxy: live settings')
    settingsCtx.effect(() => () => {
      released = true
      const dispose = disposePolicy
      disposePolicy = undefined
      if (dispose === undefined) return
      Promise.resolve(dispose()).catch((error) => report(`failed to release the proxy policy: ${String(error)}`))
    }, 'network-proxy: release policy')
  })
}

export { apply, parseWindowsProxyServer, readWindowsSystemProxy, validateSettings }
