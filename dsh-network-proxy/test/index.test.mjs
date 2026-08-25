import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
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
