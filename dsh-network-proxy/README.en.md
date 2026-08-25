# dsh-network-proxy

Network proxy management plugin for DSH (DeepSeek Harness): switch between
**Follow system / Manual proxy / Direct** from the settings UI, applied live —
no restart needed.

## Features

| Feature | Details |
|---------|---------|
| **Follow system** `system` | Windows reads the registry `Internet Settings` (under a service-account deployment it resolves the **interactive user's** config); other platforms read the `HTTP(S)_PROXY` env vars |
| **Manual proxy** `manual` | A single `http(s)://` proxy URL takes effect immediately; a bare `host:port` shorthand is accepted too (auto-prefixed with `http://`) |
| **Direct** `direct` | Clears all proxy env vars, forcing a direct connection (your OS proxy setting is untouched) |
| **Applied live** | Uses the DSH live-settings mechanism; no restart required |
| **One dispatcher for all protocols** | `ProxyAgent` / `EnvHttpProxyAgent` from undici take over the global Dispatcher, so `fetch` and undici requests are all covered |
| **Bilingual UI** | Built-in Chinese / English copy, follows the DSH locale automatically |

## Install

**From npm (recommended):**

```bash
dsh plugin --profile web add dsh-network-proxy
```

**From the GitHub monorepo (alternative):**

```bash
dsh plugin --profile web add github:lxp731/agents-plugins#path:/dsh-network-proxy
```

Restart `dsh web` afterwards; the "Network proxy" item appears under
Settings → General.

## Configuration

The plugin registers two fields under the `network-proxy` namespace:

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `mode` | `system` \| `manual` \| `direct` | `system` | proxy mode |
| `url` | `string` | `""` | manual-mode proxy address (`http(s)://` or `host:port`) |

Manual mode example:

```json
{ "network-proxy": { "mode": "manual", "url": "http://127.0.0.1:7890" } }
```

## How it works

- **Server** (`lib/index.js`): watches the `network-proxy` namespace through
  live settings, builds and swaps the global undici Dispatcher per mode, and
  injects/clears the proxy env vars accordingly.
  - `system`: reads the registry via PowerShell on Windows; when the process
    identity differs from a service account (e.g. NSSM/LocalSystem) it prefers
    the interactive user's `HKEY_USERS\<sid>` config.
  - `manual`: the web UI commits `mode` + `url` atomically in one
    `settings.mutate`, so an empty URL never trips server validation.
  - `direct`: only clears DSH's in-process proxy env vars; the OS proxy is
    unaffected.
- **Client** (`lib/client.js`): registers the `settings.general.item` slot and
  renders the mode switcher plus the manual URL input; switching to Manual
  shows the input first, and mode + URL take effect together on submit.

## Development & testing

```bash
npm install
npm test          # node --test test/*.test.mjs
```

Tests cover manual-URL validation (empty / unparseable / non-http(s) /
`host:port` shorthand), Windows proxy-string parsing (multi-protocol entries,
explicit-scheme preservation, https fallback), and (Windows only) reading the
active system proxy.

## Layout

```
dsh-network-proxy/
├── lib/index.js        # server plugin: proxy Dispatcher management & env injection
├── lib/client.js       # web client: settings UI and live state
├── test/index.test.mjs # unit tests
├── cordis.patch.yml    # cordis plugin injection manifest
├── package.json
└── package-lock.json
```

## FAQ

**Q: My manual proxy URL is rejected?**
A: It must be `http://` or `https://`, or a `host:port` shorthand that gets
auto-prefixed with `http://`; anything else is rejected before save.

**Q: Does direct mode affect the system proxy?**
A: No — it only clears the env vars DSH reads; your OS proxy setting is untouched.

**Q: DSH runs as a Windows service (NSSM/LocalSystem) — Follow system goes direct?**
A: Older versions read the process's own `HKCU`, which under a service account
is the service's hive, silently degrading to direct. The plugin now resolves
the interactive user's `HKEY_USERS\<sid>` and prefers it; Manual mode works
under any account.

**Q: Why does the URL input appear before I switch to Manual?**
A: Mode and URL are committed atomically in a single request, so an empty URL
is never rejected server-side — the field shows up first for you to fill in.

## License

[MIT](./LICENSE) © 2026 七朔
