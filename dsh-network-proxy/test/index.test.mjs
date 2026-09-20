import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import {
  apply,
  parseWindowsProxyServer,
  readWindowsSystemProxy,
  validateSettings,
} from '../lib/index.js'

describe('validateSettings', () => {
  it('accepts system and direct modes without a url', () => {
    assert.doesNotThrow(() => validateSettings({ mode: 'system' }))
    assert.doesNotThrow(() => validateSettings({ mode: 'direct' }))
    assert.doesNotThrow(() => validateSettings({ mode: 'system', url: '' }))
  })

  it('rejects manual mode with an empty url', () => {
    assert.throws(
      () => validateSettings({ mode: 'manual', url: '' }),
      /requires an HTTP or HTTPS URL/,
    )
  })

  it('rejects manual mode with an unparseable url', () => {
    assert.throws(
      () => validateSettings({ mode: 'manual', url: 'not a url' }),
      /valid HTTP or HTTPS URL/,
    )
  })

  it('rejects non-http(s) schemes', () => {
    assert.throws(
      () => validateSettings({ mode: 'manual', url: 'ftp://example.com' }),
      /only HTTP and HTTPS/,
    )
    assert.throws(
      () => validateSettings({ mode: 'manual', url: 'socks5://127.0.0.1:1080' }),
      /only HTTP and HTTPS/,
    )
  })

  it('accepts explicit http(s) urls', () => {
    assert.doesNotThrow(() => validateSettings({ mode: 'manual', url: 'http://127.0.0.1:7890' }))
    assert.doesNotThrow(() => validateSettings({ mode: 'manual', url: 'https://proxy.example.com:443' }))
  })

  it('accepts a bare host:port and normalizes it later', () => {
    assert.doesNotThrow(() => validateSettings({ mode: 'manual', url: '127.0.0.1:10808' }))
    assert.doesNotThrow(() => validateSettings({ mode: 'manual', url: 'proxy.example.com:8080' }))
  })
})

describe('parseWindowsProxyServer', () => {
  it('parses named http/https entries and preserves explicit schemes', () => {
    const result = parseWindowsProxyServer('http=1.2.3.4:80;https=5.6.7.8:443')
    assert.deepEqual(result, {
      httpProxy: 'http://1.2.3.4:80',
      httpsProxy: 'http://5.6.7.8:443',
    })
  })

  it('falls back to the bare proxy for both protocols', () => {
    const result = parseWindowsProxyServer('1.2.3.4:80')
    assert.deepEqual(result, {
      httpProxy: 'http://1.2.3.4:80',
      httpsProxy: 'http://1.2.3.4:80',
    })
  })

  it('falls https back to the http entry when https is absent', () => {
    const result = parseWindowsProxyServer('http=1.2.3.4:80')
    assert.deepEqual(result, {
      httpProxy: 'http://1.2.3.4:80',
      httpsProxy: 'http://1.2.3.4:80',
    })
  })

  it('keeps https-only entries isolated from http', () => {
    const result = parseWindowsProxyServer('https=5.6.7.8:443')
    assert.deepEqual(result, {
      httpProxy: undefined,
      httpsProxy: 'http://5.6.7.8:443',
    })
  })

  it('ignores unrelated protocols such as ftp', () => {
    const result = parseWindowsProxyServer('http=1.2.3.4:80;https=5.6.7.8:443;ftp=9.9.9.9:21')
    assert.deepEqual(result, {
      httpProxy: 'http://1.2.3.4:80',
      httpsProxy: 'http://5.6.7.8:443',
    })
  })

  it('handles empty and whitespace-only input', () => {
    assert.deepEqual(parseWindowsProxyServer(''), {})
    assert.deepEqual(parseWindowsProxyServer('  '), {})
    assert.deepEqual(parseWindowsProxyServer(undefined), {})
    assert.deepEqual(parseWindowsProxyServer(null), {})
  })

  it('preserves an explicit https scheme on the server value', () => {
    const result = parseWindowsProxyServer('https=proxy.example.com:443')
    assert.equal(result.httpsProxy, 'http://proxy.example.com:443')
  })
})

describe('readWindowsSystemProxy (Windows only)', () => {
  it('executes and returns a structured config on win32', { skip: process.platform !== 'win32' }, () => {
    let config
    assert.doesNotThrow(() => { config = readWindowsSystemProxy() })
    assert.ok(Array.isArray(config) || typeof config === 'object')
    assert.ok(config && 'httpProxy' in config)
  })

  it('keeps the PowerShell probe script reading the interactive user hive', () => {
    // The probe must resolve the console user (service-account deployments
    // otherwise read the service hive and silently go direct).
    const source = readWindowsSystemProxy.toString()
    assert.match(source, /HKEY_USERS/)
    assert.match(source, /Win32_ComputerSystem/)
    assert.match(source, /interactiveSid/)
  })
})

/** Poll `check` until it is truthy, failing the test after `timeoutMs`. */
async function waitFor(check, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The proxy `proxyRouteFor` routes a URL through, or `undefined` for a direct route. */
function routeOf(url) {
  const route = proxyRouteFor(new URL(url))
  return route.proxied ? route.proxy : undefined
}

/**
 * Drive `apply()` with a mock cordis context: a settings scope whose current
 * value the test can replace (to emulate a live settings change) and a launch
 * snapshot whose `process` layer stands in for the inherited environment.
 */
function createHarness({ launchValues, initial, envFile }) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-network-proxy-'))
  const envPath = join(home, '.env')
  if (envFile !== undefined) writeFileSync(envPath, envFile)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const launchSnapshot = createLaunchEnvironmentSnapshot([{ source: 'process', values: launchValues }])
  let current = initial
  let watcher
  const scope = {
    get: () => current,
    watch: (callback) => { watcher = callback; return () => {} },
  }
  const settingsCtx = {
    settings: { register: () => scope },
    effect: (callback) => { callback() },
  }
  apply({
    logger: { warn: () => {} },
    inject: (_deps, callback) => callback(settingsCtx),
    get: (key) => (key === 'launchEnvironment' ? launchSnapshot : undefined),
  })

  return {
    envPath,
    readEnvFile: () => (existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''),
    switchTo(mode) {
      current = { mode, url: 'http://127.0.0.1:7890' }
      watcher?.(current)
    },
    dispose() {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    },
  }
}

describe('live policy install and $DSH_HOME/.env mirroring', () => {
  it('applies each mode live and keeps the env file in sync', async () => {
    const harness = createHarness({
      launchValues: {
        http_proxy: 'http://system-proxy:1111',
        https_proxy: 'http://system-proxy:1111',
      },
      initial: { mode: 'manual', url: 'http://127.0.0.1:7890' },
      envFile: '# keep me\nSOME_USER_KEY=keepme\nhttp_proxy=http://stale:9999\n',
    })
    try {
      const google = 'https://www.google.com'

      // Manual: installs the configured proxy live and mirrors it into .env.
      await waitFor(() => routeOf(google) === 'http://127.0.0.1:7890', 'manual policy was not installed')
      await waitFor(() => harness.readEnvFile().includes('HTTP_PROXY=http://127.0.0.1:7890'), 'manual mode never reached .env')
      const manualFile = harness.readEnvFile()
      assert.match(manualFile, /^HTTP_PROXY=http:\/\/127\.0\.0\.1:7890$/m)
      assert.match(manualFile, /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:7890$/m)
      assert.match(manualFile, /^SOME_USER_KEY=keepme$/m, 'unrelated .env lines must survive')
      assert.match(manualFile, /^# keep me$/m, 'comments must survive')
      assert.doesNotMatch(manualFile, /stale/, 'a hand-written proxy key must be overwritten, not duplicated')

      // Direct: installs a direct policy and drops the managed proxy keys.
      harness.switchTo('direct')
      await waitFor(() => routeOf(google) === undefined, 'direct policy was not installed')
      await waitFor(() => !harness.readEnvFile().includes('HTTP_PROXY='), 'direct mode never cleared .env')
      const directFile = harness.readEnvFile()
      assert.doesNotMatch(directFile, /PROXY=/i, 'direct mode must clear every proxy key')
      assert.doesNotMatch(directFile, /Managed by dsh-network-proxy/, 'the managed block marker must be removed')
      assert.match(directFile, /^SOME_USER_KEY=keepme$/m)

      // Follow system: resolves against the inherited launch environment, never
      // against the .env this plugin itself wrote.
      harness.switchTo('system')
      await waitFor(() => routeOf(google) === 'http://system-proxy:1111', 'system mode did not resolve the launch environment')
      assert.doesNotMatch(harness.readEnvFile(), /PROXY=/i, 'system mode must clear every proxy key')
    } finally {
      harness.dispose()
    }
  })
})
