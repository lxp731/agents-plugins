# Changelog

All notable changes to this plugin are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning follows semver.

## [0.2.0]

### Changed
- **`notify` tool `status` enum is now `"success" | "failure"`** (was `"完成" |
  "失败"`). The harness validates the enum strictly; update any prompts that
  pass Chinese values.
- Windows now sends a real WinRT Toast notification (no focus stealing,
  lands in the Action Center); the blocking `WScript.Shell.Popup` is only a
  fallback when the Toast fails.

### Added
- **i18n**: all notification/command strings centralized in one table;
  new `lang` config (`'zh'` default, `'en'` available) switches messages and
  `/notify-threshold` replies.
- **Failure logging everywhere**: missing notifiers (`notify-send`, players),
  failed delivery, persistence failures are all logged via the plugin logger —
  no more silent no-ops.
- **Linux display probing**: `DISPLAY`/`WAYLAND_DISPLAY` discovered from
  session sockets (`/tmp/.X11-unix`, `XDG_RUNTIME_DIR/wayland-*`) instead of
  hardcoded `:0`/`wayland-0`; works under systemd user services.
- **Blocking-notification cooldown** (`blockedCooldownSec`, default 60s):
  approval retries / repeated questions for the same session no longer spam.
- **Tool rate limit** (`toolCooldownSec`, default 10s): rapid model-invoked
  `notify` calls return `{ ok: false, throttled: true }`.
- **Profile fallback warning**: when the profile cannot be determined and the
  plugin falls back to `'web'`, it logs a warning (runtime config would persist
  to that profile).
- **Host-API self-check**: warns once if no harness events arrive within 5
  minutes of an active session (detects silent breakage after dsh updates).
- **CI** (GitHub Actions): lint + tests on Node 18/20/24 for this directory.
- `repository` / `bugs` / `homepage` / `engines` fields in package.json.

### Fixed
- Config persistence **preserves user comments** in `cordis.patch.yml`
  (YAML Document AST instead of full-file restringify).
- Persistence writes are **atomic** (temp file + rename) with a best-effort
  cross-process lockfile; a crash mid-write can no longer tear the file.
- Tracking maps (`reasons`/`starts`) are capped and stale state is consumed at
  idle — no unbounded growth if a run crashes before returning to idle.
- README development instructions now match the repo's actual package manager
  (npm), removed the empty `src/` directory.

## [0.1.0]

- Initial release: run-end notifications, error/approval/question alerts,
  duration threshold, custom chime on all three OSes, `/notify-threshold`,
  model-callable `notify` tool.
