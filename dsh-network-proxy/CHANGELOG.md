# Changelog

## 1.1.2 (2026-09-20)
- Fix: replace removed `@deepseek-ai/dsh-client-runtime` with
  `@deepseek-ai/dsh-client-store` for `createSnapshotStore`, and drop the dead
  package from `dsh.client.inject` (deepseek-harness removed Runtime in
  be531688f3; the store package is now a platform seed word).
- Fix: drop the removed `settingsNamespace` export from `@deepseek-ai/dsh-settings`
  (gone in dsh 0.1.5-rc.2) — the server plugin now registers the plain
  `'network-proxy'` namespace string, so the plugin tree loads again on newer
  harnesses.

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
