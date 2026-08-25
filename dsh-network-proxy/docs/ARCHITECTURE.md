# Architecture

- `index.js` — server-side plugin: manages the global undici `Dispatcher`
  (ProxyAgent / EnvHttpProxyAgent) and injects proxy environment variables.
- `client.js` — web client: the settings UI and live state for the
  `network-proxy` namespace.
- `cordis.patch.yml` — declares the `network-proxy` loader entry that the
  Harness composes into its cordis tree.

Modes:
- `system` — read the OS proxy (Windows registry `Internet Settings`, resolved
  for the *interactive* user when the process runs as a service account; else
  `HTTP(S)_PROXY` env vars).
- `manual` — use a single `http(s)://` URL; a bare `host:port` is auto-prefixed
  with `http://`.
- `direct` — clear all proxy env vars.

The web client commits `mode` + `url` atomically (single `settings.mutate`)
and shows the URL field before first switching to manual, so an empty URL is
never validated server-side.
