# task-complete-notify-for-dsh

DSH (DeepSeek Harness) plugin: desktop notification + chime when a run finishes — **completion, errors, and approval requests** — with a configurable duration threshold.

> **The essence: a custom chime that works on all three OSes.** Replace
> `lib/assets/prompt-tone.mp3` with any audio you like and the sound changes
> everywhere — Windows, macOS, Linux — not just Linux.

## Cross-platform

Runs on **Windows, macOS and Linux** from the same package — no code changes.
Notification and the custom chime work on each OS (see
[Platform support](#platform-support)).

## Features

| Feature | Details |
|---------|---------|
| Run **completion** | ✅ notify + chime |
| Run **error** (`turn/end` reason=error) | ✅ **critical** "任务失败" |
| **Approval request** (`approval/asked`) | ✅ **critical** "等待审批" |
| Model **question** (`ask_user_question`) | ✅ **critical** "模型需要你回答" |
| Duration threshold | ✅ configurable |
| Model-callable `notify` tool | ✅ (rate-limited) |
| `notify-threshold` command | ✅ persists to user config |
| Cross-platform | ✅ Windows / macOS / Linux |
| Custom chime | ✅ `chimeFile` config or replace the mp3 |
| i18n messages | ✅ `lang: 'zh'` (default) or `'en'` |
| Anti-spam cooldowns | ✅ for approval retries and tool calls |
| Failure diagnostics | ✅ every notification/persistence failure is logged |

## Why this is a safer install than `curl | bash` plugins

This package ships **pre-built `lib/`** with **no `prepare`/`postinstall`/`install` build script** — `dsh plugin add` has nothing to execute beyond loading the published JS. Build-time code only runs on the author's machine at publish (`prepublishOnly`), never on your machine at install. This avoids the "install runs a remote build script" supply-chain concern.

## Install

Source: [github.com/lxp731/agents-plugins/tree/main/task-complete-notify-for-dsh](https://github.com/lxp731/agents-plugins/tree/main/task-complete-notify-for-dsh)

**From npm (recommended):**

```bash
dsh plugin --profile web add task-complete-notify-for-dsh
```

**From the GitHub monorepo** (alternative): the plugin lives in the
`agents-plugins` monorepo, so point dsh at the subdirectory with `#path:`:

```bash
dsh plugin --profile web add github:lxp731/agents-plugins#path:/task-complete-notify-for-dsh
```

Then restart `dsh web`. Or via the dsh-market panel: Settings → Plugin Market.

## How it works

- **One notification per run**, not per turn. A run can span many turns; the plugin records the latest `turn/end` reason and fires **once** when the root agent returns to `agent/status` `'idle'` (the harness's own "run ended" signal).
- **Errors and token limits** carry the final `turn/end` reason, so a run that errors gets a critical "任务失败" with the true final result.
- **Approval / question** fire an immediate critical notification, because each is a separate "the session is waiting on you" moment.
- **Subagent sessions are excluded** (`header.origin === 'subagent'`) so a top-level run produces one notification.

## Configuration

Declare the row in `~/.dsh/profiles/web/cordis.patch.yml` (the user layer, applied last):

```yaml
- id: task-complete-notify
  name: task-complete-notify-for-dsh
  config:
    enabled: true             # master switch
    threshold: 0              # min run duration (s) before notifying; 0 = always
    title: DeepSeek Harness   # notification title
    sound: true               # play a chime
    onQuestion: true          # notify when the model asks a question
    onApproval: true          # notify when the harness waits for approval
    chimeFile: ''             # absolute path to a custom mp3; empty = bundled default
    lang: zh                  # message language: 'zh' (default) or 'en'
    blockedCooldownSec: 60    # min seconds between question/approval notifications per session
    toolCooldownSec: 10       # min seconds between model-invoked notify tool calls
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch; `false` disables everything |
| `threshold` | number | `0` | Only notify when the run took longer than this (seconds). `0` = always notify |
| `title` | string | `DeepSeek Harness` | Notification title |
| `sound` | boolean | `true` | Play a chime with the notification |
| `onQuestion` | boolean | `true` | Notify when the model calls `ask_user_question` |
| `onApproval` | boolean | `true` | Notify when the harness waits for approval |
| `chimeFile` | string | `''` | Absolute path to a custom chime mp3, e.g. `/usr/local/music/xx.mp3`. Overrides the bundled `prompt-tone.mp3`. Empty uses the default |
| `lang` | string | `'zh'` | Message language for notifications and command replies (`'zh'` / `'en'`) |
| `blockedCooldownSec` | number | `60` | Minimum seconds between blocking-event notifications (question/approval) for the same session — retries no longer spam while you're away |
| `toolCooldownSec` | number | `10` | Minimum seconds between model-invoked `notify` tool calls; faster calls return `{ ok: false, throttled: true }` |

### Runtime threshold (`/notify-threshold`) — persists

`/notify-threshold <秒>` sets the threshold **and persists it to the user layer**
(`cordis.patch.yml`), so it survives a restart — no need to edit the file by
hand. With no argument it prints the current value. Example:
`/notify-threshold 30` notifies only on runs longer than 30s.

### Custom chime (`chimeFile`)

Point `chimeFile` at your own audio file to override the bundled prompt:

```yaml
- id: task-complete-notify
  name: task-complete-notify-for-dsh
  config:
    chimeFile: /usr/local/music/xx.mp3
```

Any mp3 works; the file is played on all platforms (see Platform support). If
`chimeFile` is configured but the file is missing, the plugin logs a warning at
startup and falls back to the default.

### Model-callable `notify` tool

The model can explicitly notify the user for important events:

```
notify(message: "Data export complete: 100,000 records", status: "success")
notify(message: "Build failed: TypeScript compilation error", status: "failure")
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | string | Notification content (required) |
| `status` | `"success"` / `"failure"` | Optional; `"failure"` uses critical urgency. Defaults to `"success"` |

> **Breaking change in v0.2.0:** `status` values changed from `"完成"/"失败"
> to `"success"/"failure"`. Update any prompts that pass Chinese values.

Calls are rate-limited (`toolCooldownSec`, default 10s); suppressed calls return `{ ok: false, throttled: true }`.

## Platform support

| Platform | Notification | Chime (custom mp3) |
|----------|--------------|--------------------|
| Linux | `notify-send` | mpv → ffplay → pw-play → cvlc → paplay |
| macOS | `osascript display notification` | **afplay (built-in)** → mpv → ffplay → cvlc → mpg123 |
| Windows | **WinRT Toast** (no focus stealing; Popup fallback) | mpv → ffplay → mplayer → mpg123 → cvlc |

On Linux, the display session (`DISPLAY`/`WAYLAND_DISPLAY`) is discovered from
the actual session sockets instead of hardcoded defaults, so notifications work
under systemd user services too.

**The custom chime works on every platform.** The plugin's core idea is a
replaceable audio file (`lib/assets/prompt-tone.mp3`) — swap the file to change
the sound. On all three OSes it first auto-detects an available player and
plays the mp3; only when **no** player exists does it fall back to the platform
system sound (macOS `Glass` / Windows `SystemSounds`).

- **macOS**: `afplay` ships with the OS and plays mp3 natively, so the custom
  chime works with zero install.
- **Windows**: has no built-in mp3 player (PowerShell's `SoundPlayer` only
  plays `.wav`), so install any one of mpv / ffplay / mplayer / mpg123 / cvlc
  to enable the custom chime.

To change the sound without touching config, replace `lib/assets/prompt-tone.mp3`
(any mp3 works). To keep your own file elsewhere, use the `chimeFile` config.

Notifications are fire-and-forget (detached, unref'd) — a missing notifier never breaks the run it reports on. Every failure is logged via the plugin logger, so a silent no-op is diagnosable from dsh logs.

## Reliability

- **Self-check**: warns once if no harness events arrive within 5 minutes of an active session — an early signal that a dsh update changed its event API.
- **Profile safety**: if the active profile cannot be determined, persistence falls back to `'web'` and logs a warning.
- **Config persistence preserves comments**: edits go through a YAML AST, so your annotations in `cordis.patch.yml` survive `/notify-threshold`; writes are atomic (temp file + rename) with a best-effort lockfile.
- **Bounded memory**: per-session tracking state is capped and consumed at idle.

See [CHANGELOG.md](./CHANGELOG.md) for the full history.

## Development

```bash
npm install           # resolves schemastery + peers via package-lock.json
npm test              # node --test tests/*.test.mjs
npm run lint          # eslint lib tests
```

If peer deps aren't resolvable from a fresh clone, `bash scripts/smoke.sh` links them from a dsh install's node_modules automatically.

Install locally for testing (from a clone of the `agents-plugins` monorepo):

```bash
git clone git@github.com:lxp731/agents-plugins.git
cd agents-plugins/task-complete-notify-for-dsh
dsh plugin --profile web add link:.
```

> **Note for systemd-managed setups** (`dsh-service-control`): after any change
> to `lib/`, reload the plugin by restarting the service, e.g.
> `systemctl --user restart dsh-web.service`.

## Development notes (read before extending)

- **Cordis services must be injected.** `ctx.tools` and `ctx.commands` are
  **not** directly readable — accessing them without declaration throws
  `cannot get property "tools" without inject` and fails the whole plugin tree
  at boot. Always use `ctx.inject(['tools'], (sctx) => …)` / `ctx.inject(['commands'], …)`
  and register inside `sctx.effect(...)`.
- The harness's typed `session/event` / `agent/status` declarations live in the
  unpublished `@deepseek-ai/dsh-session` / `dsh-agent` packages, so event
  listeners register with a narrowed cast; payload shapes are pinned in
  `lib/notifier.js`.
- **Config persistence** uses the `yaml` package to read/merge/write the
  plugin's row in the profile user layer (`cordis.patch.yml`, via `lib/persist.js`).
  `DSH_HOME` already points at the `.dsh` data dir (default `~/.dsh`); the
  resolver must NOT append `.dsh` again when `DSH_HOME` is set.
- **Profile resolution is robust**: `resolveProfile()` picks the active profile
  from, in order, an explicit argument, the `DSH_PROFILE` env var, `--profile` in
  argv, then a `'web'` fallback. Never rely on argv alone.
- **`writeConfig` is crash-safe**: it refuses to clobber a `cordis.patch.yml`
  that isn't a valid top-level YAML array, and never overwrites an unparseable
  file with an empty one (that would wipe a real user config).
- The `notify` tool is built with `defineTool()` from `@deepseek-ai/dsh-tools`
  (a harness peer). `defineTool` requires `required: true` on mandatory
  parameters; omit `required` entirely for optional ones (a bare
  `required: false` is rejected).

## License

MIT
