# Changelog

## 1.1.3 (2026-09-20)
- Change: the server plugin no longer builds its own undici dispatcher. On every
  mode change it installs the process-wide policy through
  `@deepseek-ai/dsh-http-proxy` (`installProxyFromEnvironment`) — the same policy
  `dsh-web-fetch-http` consults through `proxyRouteFor`. The mode therefore now
  governs `web_fetch` too, not only the callers that use the undici global
  dispatcher, and it still applies live without a restart.
- Add: the plugin keeps `$DSH_HOME/.env` in sync with the selected mode
  (`HTTP_PROXY` / `HTTPS_PROXY` for Manual; proxy keys removed for System and
  Direct) so the decision also takes effect at the next launch, before any plugin
  mounts. Only the proxy keys are managed — every other line, comment and blank
  line is preserved — and the file is replaced atomically at 0600 because a proxy
  URL may carry credentials.
- Fix: "Follow system" now reads the launch snapshot's `process` layer
  (`launchEnvironmentOf(ctx).getFrom(name, ['process'])`) instead of
  `process.env`. `loadLayeredEnv` copies `$DSH_HOME/.env` into `process.env`, so
  reading it directly would have made Follow system inherit the plugin's own last
  manual decision after a restart. Windows still reads the interactive user's
  registry hive, and an inherited value wins over the registry one.
- Change: `undici` is no longer a runtime dependency (nothing in the package
  imports it); add peer dependencies on `@deepseek-ai/dsh-http-proxy` and
  `@deepseek-ai/dsh-launch-environment`.
- Test: cover the live policy install and the `.env` mirroring — Manual routes
  through the configured proxy, Direct and System clear it, System resolves
  against the inherited launch environment (not the plugin's own `.env`), and a
  user-authored `.env` keeps its unrelated lines.

## 1.1.2 (2026-09-20)
- Fix: replace removed `@deepseek-ai/dsh-client-runtime` with
  `@deepseek-ai/dsh-client-store` for `createSnapshotStore`, and drop the dead
  package from `dsh.client.inject` (deepseek-harness removed Runtime in
  be531688f3; the store package is now a platform seed word).
- Fix: drop the removed `settingsNamespace` export from `@deepseek-ai/dsh-settings`
  (gone in dsh 0.1.5-rc.2) — the server plugin now registers the plain
  `'network-proxy'` namespace string, so the plugin tree loads again on newer
  harnesses.
- Fix: client settings transport now calls `ctx.remote.settings` (describe/
  mutate) instead of the removed `ctx.get('connection').api`; inject
  `remote.settings` and `@deepseek-ai/dsh-api-remotes` so the web proxy row can
  read and write settings again on dsh 0.1.5-rc.2.

## 1.1.0 (2026-08-26)
- Fix: web UI deadlock when switching to Manual — mode + URL are now committed
  atomically; the URL field appears before the mode is applied (issue #1).
- Fix: `host:port` shorthand accepted in Manual mode (auto-prefixed with `http://`);
  distinct error messages for empty vs. unparseable vs. unsupported scheme.
- Fix: Follow system on Windows now reads the *interactive user's* registry
  hive, not the service account's, when DSH runs as a service (issue #2).
- Fix: initial activation no longer closes the pre-existing global dispatcher.
- Add `index.test.js` (previously referenced but missing, breaking `npm test`),
  drop `private: true`, tidy `.gitignore`.
- Restructure to the monorepo convention: source into `lib/`, tests into
  `test/*.test.mjs`, docs folded into README, package metadata aligned
  (bilingual description, author, repository, `dsh.category`/`displayName`).

## 1.0.0 (2026-08-19)
- Initial release: network proxy management plugin for DeepSeek Harness.
- Three modes: system / manual / direct, applied live via settings UI.
- Windows system proxy parsing (ProxyServer / ProxyOverride).
- Bilingual (zh/en) settings UI.
