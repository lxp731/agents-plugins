# dsh-network-proxy

Network proxy management plugin for DSH (DeepSeek Harness): switch between
**Follow system / Manual proxy / Direct** from the settings UI, applied live —
no restart needed.

## Features

| Feature | Details |
|---------|---------|
| **Follow system** `system` | Reads the environment DSH **inherited at launch** (`HTTP(S)_PROXY` etc.); on Windows it additionally reads the registry `Internet Settings` (under a service-account deployment it resolves the **interactive user's** config), with an inherited value winning |
| **Manual proxy** `manual` | A single `http(s)://` proxy URL takes effect immediately; a bare `host:port` shorthand is accepted too (auto-prefixed with `http://`) |
| **Direct** `direct` | Installs a direct policy and removes the proxy keys, forcing a direct connection (your OS proxy setting is untouched) |
| **Applied live** | Re-installs the process-wide policy through the DSH live-settings mechanism; no restart required |
| **Covers DSH's own traffic** | Shares the *same* policy as `dsh-web-fetch-http` (`@deepseek-ai/dsh-http-proxy`), so `web_fetch`, model API calls and `web_search` all leave through the same exit |
| **Durable** | Mirrors the decision into `$DSH_HOME/.env` so it also applies at the next launch, before any plugin mounts; only the proxy keys are touched |
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

- **Server** (`lib/index.js`):
  - Watches the `network-proxy` namespace through live settings; every change
    calls `installProxyFromEnvironment()` from `@deepseek-ai/dsh-http-proxy` to
    **re-install the process-wide proxy policy**. That is the same policy
    `dsh-web-fetch-http` consults via `proxyRouteFor()`, so `web_fetch` follows
    the mode too — still without a restart.
  - Mirrors the mode into `$DSH_HOME/.env`: `manual` writes
    `HTTP_PROXY` / `HTTPS_PROXY`, while `system` / `direct` remove the proxy keys.
    Only the proxy keys are managed; every other line, comment and blank line is
    preserved. The file is replaced atomically at 0600 because a proxy URL may
    carry credentials.
  - `system`: reads the launch snapshot's `process` layer
    (`launchEnvironmentOf(ctx).getFrom(name, ['process'])`) — the environment the
    dsh process actually inherited, deliberately excluding the `.env` this plugin
    writes itself. On Windows it then reads the registry, with an inherited value
    winning.
  - `manual`: the web UI commits `mode` + `url` atomically in one
    `settings.mutate`, so an empty URL never trips server validation.
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
explicit-scheme preservation, https fallback), (Windows only) reading the
active system proxy, and the **live policy install plus `.env` mirroring**
(Manual routes through the proxy, Direct and System clear it, System resolves
against the inherited launch environment rather than the plugin's own `.env`,
and a user-authored `.env` keeps its unrelated lines).

> **Local-development note**: when you develop the plugin by symlinking it into a
> profile, link `@deepseek-ai/dsh-http-proxy` and
> `@deepseek-ai/dsh-launch-environment` under the plugin's `node_modules` to the
> harness copies rather than installing private ones. They hold the
> process-wide policy, so they must be the *same module instance*
> `dsh-web-fetch-http` uses — otherwise the policy this plugin installs is
> invisible to `web_fetch`.

## Layout

```
dsh-network-proxy/
├── lib/index.js        # server plugin: installs the dsh-http-proxy policy & maintains $DSH_HOME/.env
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
A: No — it only installs a direct policy inside the DSH process and removes the
`.env` proxy keys the plugin manages; your OS proxy setting is untouched.

**Q: Why doesn't Follow system pick up the proxy I `export` in my shell?**
A: DSH runs as a systemd user service, so it never executes your shell startup
files (`.zshrc`, oh-my-zsh, …) and cannot see variables that only exist in an
interactive shell. Put the proxy where the systemd user manager can read it — for
example `HTTP_PROXY=...` in `~/.config/environment.d/99-proxy.conf` (takes effect
after a **re-login**), or `systemctl --user set-environment HTTP_PROXY=...`
followed by a `dsh-web` restart.

**Q: Does switching modes write my `$DSH_HOME/.env`?**
A: Yes — that is the durability mechanism, so the decision also applies at the
next launch before any plugin mounts. The plugin only manages
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` (both casings) and preserves
everything else; the file is written atomically at 0600.

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
