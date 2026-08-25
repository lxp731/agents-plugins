import { execFileSync } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from 'undici'

const NETWORK_PROXY_NAMESPACE = settingsNamespace('network-proxy')
const PROXY_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]
const inheritedProxyEnvironment = Object.fromEntries(
  PROXY_ENV_NAMES.map((name) => [name, process.env[name]]),
)

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

function restoreInheritedProxyEnvironment() {
  for (const name of PROXY_ENV_NAMES) {
    const value = inheritedProxyEnvironment[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

function setManualProxyEnvironment(url) {
  const normalized = normalizeProxyUrl(url) ?? url
  for (const name of PROXY_ENV_NAMES) delete process.env[name]
  process.env.HTTP_PROXY = normalized
  process.env.HTTPS_PROXY = normalized
  process.env.http_proxy = normalized
  process.env.https_proxy = normalized
  const noProxy = inheritedProxyEnvironment.NO_PROXY ?? inheritedProxyEnvironment.no_proxy
  if (noProxy !== undefined) {
    process.env.NO_PROXY = noProxy
    process.env.no_proxy = noProxy
  }
}

function clearProxyEnvironment() {
  for (const name of PROXY_ENV_NAMES) delete process.env[name]
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

function systemProxyOptions() {
  if (process.platform === 'win32') return readWindowsSystemProxy()
  return {
    httpProxy: inheritedProxyEnvironment.HTTP_PROXY ?? inheritedProxyEnvironment.http_proxy,
    httpsProxy: inheritedProxyEnvironment.HTTPS_PROXY ?? inheritedProxyEnvironment.https_proxy,
    noProxy: inheritedProxyEnvironment.NO_PROXY ?? inheritedProxyEnvironment.no_proxy,
  }
}

function dispatcherFor(value) {
  if (value.mode === 'direct') return new Agent()
  if (value.mode === 'manual') return new ProxyAgent(normalizeProxyUrl(value.url) ?? value.url)
  const options = systemProxyOptions()
  if (!options.httpProxy && !options.httpsProxy) return new Agent()
  return new EnvHttpProxyAgent(options)
}

function applyProxyEnvironment(value) {
  if (value.mode === 'system') restoreInheritedProxyEnvironment()
  else if (value.mode === 'manual') setManualProxyEnvironment(value.url)
  else clearProxyEnvironment()
}

function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      NETWORK_PROXY_NAMESPACE,
      NetworkProxySettingsSchema,
      { applies: 'live', validate: validateSettings },
    )
    let activeDispatcher = getGlobalDispatcher()
    let ownsDispatcher = false

    const activate = (value) => {
      validateSettings(value)
      const previous = activeDispatcher
      activeDispatcher = dispatcherFor(value)
      applyProxyEnvironment(value)
      setGlobalDispatcher(activeDispatcher)
      ownsDispatcher = true
      if (ownsDispatcher && previous !== activeDispatcher && typeof previous.close === 'function') {
        Promise.resolve(previous.close()).catch((error) => {
          ctx.logger?.warn?.('failed to close previous network dispatcher: %s', String(error))
        })
      }
    }

    activate(scope.get())
    settingsCtx.effect(() => scope.watch((next) => activate(next)), 'network-proxy: live settings')
  })
}

export { apply, parseWindowsProxyServer, readWindowsSystemProxy, validateSettings }
