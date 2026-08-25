# Architecture

- `index.js` — server-side plugin: manages the global undici `Dispatcher`
  (ProxyAgent / EnvHttpProxyAgent) and injects proxy environment variables.
- `client.js` — web client: the settings UI and live state for the
  `network-proxy` namespace.
- `cordis.patch.yml` — declares the `network-proxy` loader entry that the
  Harness composes into its cordis tree.

Modes:
- `system` — read the OS proxy (Windows registry `Internet Settings`, else `HTTP(S)_PROXY`).
- `manual` — use a single `http(s)://` URL.
- `direct` — clear all proxy env vars.
