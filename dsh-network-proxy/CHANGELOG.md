# Changelog

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

## 1.0.0 (2026-08-19)
- Initial release: network proxy management plugin for DeepSeek Harness.
- Three modes: system / manual / direct, applied live via settings UI.
- Windows system proxy parsing (ProxyServer / ProxyOverride).
- Bilingual (zh/en) settings UI.
