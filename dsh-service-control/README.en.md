# dsh-service-control

Start/stop control for a DSH service: an HTTP API to start/stop/restart/check status, plus a standalone CLI `dshctl` (with shell completion). No Web UI panel.

Control logic lives **outside the dsh process** (`scripts/control.sh`); the plugin calls it through HTTP routes. Restart/stop are executed by detached delayed processes, so they never block the plugin process itself.

## Installation

```bash
# From npm (recommended)
dsh plugin --profile web add dsh-service-control

# Alternative: from the GitHub monorepo subdirectory
dsh plugin --profile web add github:lxp731/agents-plugins#path:/dsh-service-control

# Local development install (when debugging from the repo directory)
# dsh plugin --profile web add "file:."
```

Restart the `web` profile after installing (quit the current `dsh web` / `dsh --profile web` process and start it again).

> The plugin lives in the `dsh-service-control/` subdirectory of the `agents-plugins` monorepo, so installing from GitHub requires `#path:` to point at the subdirectory.

### Enabling the CLI and completions

The plugin ships a CLI, `dshctl`. Run setup once after installing: it links the command into `~/.local/bin/` and installs completions (zsh/bash/fish — the detected shell is chosen automatically). It is idempotent and never rewrites any shell rc file. **Open a new terminal** for completions to take effect:

```bash
dshctl setup
```

If you get `dshctl: command not found` (usually because `~/.local/bin` is not on your PATH), run setup with the in-package binary, or install globally:

```bash
~/.dsh/profiles/web/node_modules/.bin/dshctl setup   # in-package binary (profile install)
npm install -g dsh-service-control                   # global install (npm global bin is on PATH by default)
```

## Usage

### HTTP API

| Endpoint | Method | Description |
|---|---|---|
| `/dsh-health` | GET | Liveness probe |
| `/dsh-service/status` | GET | Status JSON `{ok, running, pid, port, url, profile, note}` (`port`/`url` are `null` when not detected) |
| `/dsh-service/start` | POST | Background start (opens a browser tab when ready) |
| `/dsh-service/stop` | POST | Graceful stop (SIGINT, run by a detached process) |
| `/dsh-service/restart` | POST | Delayed restart (detached process: sleeps 3s first, then restarts) |

### CLI

```bash
dshctl start|up                 # start (auto-opens browser when ready)
dshctl stop|down                # stop (systemctl stop; never auto-restarts)
dshctl restart|reload           # restart
dshctl status|ps                # status (shows [systemd state] when enabled)
dshctl open                     # open the service page in a browser
dshctl enable|on                # create systemd units (service + watchdog) + boot autostart
dshctl disable|off              # disable autostart, stop the watchdog, remove unit files
dshctl probe|h                  # probe /dsh-health (reachability + latency)
dshctl info|i                   # overview (profile/unit/pid/port/watchdog/version)
dshctl doctor|d                 # one-shot self-check
dshctl logs|l dsh|journal [-f]   # view the dsh log file or systemd journal (follow with -f)
dshctl diagnostics              # export a diagnostics bundle
dshctl config [get/set]         # view/set persisted config (e.g. DSH_WATCHDOG_FAIL_LIMIT)
dshctl setup                    # enable CLI + install completions
dshctl uninstall                # remove CLI link, completions, and systemd units
```

Supports `--profile <name>` (default `web`; legacy commands also accept the positional form, e.g. `dshctl stop web`).

## Boot autostart and self-healing (systemd user units)

`dshctl enable` writes two units and runs `systemctl --user enable` (both idempotent):

| Unit | Purpose |
|---|---|
| `dsh-<profile>.service` | Main service: `dsh --profile <profile> --no-open`, `Restart=always` + `RestartSec=2`, `KillSignal=SIGTERM`, `SuccessExitStatus=130`, `StartLimitIntervalSec=60` + `StartLimitBurst=5` |
| `dsh-<profile>-watchdog.service` | Watchdog: probes `/dsh-health` from outside the process every 3s; after 3 consecutive failures (~18s) it runs `systemctl --user restart` on the main service |

**systemd decides whether to restart — normal exits are never restarted:**

- Normal exit (exit code 0 / Ctrl+C's SIGINT / SIGTERM / `dshctl stop` / `systemctl stop`) → **no restart** (systemd treats SIGINT/SIGTERM/exit 0 as clean exits; an explicit `systemctl stop` never triggers a restart).
- Abnormal exit (non-zero exit code, crash signals such as SIGSEGV/SIGABRT/SIGKILL, OOM killer) → **auto-restarted after a few seconds**.
- Hang (process alive but `/dsh-health` unresponsive) → the watchdog restarts it after ~18s; a normally stopped service leaves the unit `inactive`, which the watchdog never touches.

Once enabled, `dshctl start/stop/restart/status` automatically go through `systemctl --user` (keeping lifecycle consistent and avoiding fights between manual `pkill` and systemd auto-restart). When not enabled, plain process control is used. `dshctl disable` stops the watchdog first, then disables autostart and removes both unit files.

- Logs (two kinds):
  - **File log** (dsh console + plugin lifecycle events): `$HOME/.dsh/logs/dsh/YYYYMMDD-dsh-<profile>.log` (rotated daily; `dshctl config set DSH_LOG_DIR <dir>` changes the directory, `DSH_LOG` sets a full path) → `dshctl logs dsh`.
  - **systemd journal**: `journalctl --user -u dsh-<profile>`, `journalctl --user -u dsh-<profile>-watchdog` → `dshctl logs journalctl`.
- Environments without systemd (containers, WSL without systemd enabled) report an error; for boot autostart without a graphical session, run `loginctl enable-linger` first.
- If dsh is running outside systemd when you `enable`, you'll be told to `dshctl stop` then `dshctl start` to migrate it under systemd management.

## Configuration

The plugin Config supports `profile`: which profile to control. It defaults to the `--profile` argument used to launch dsh (otherwise `web`). Override that line by id in the profile's `cordis.patch.yml` or a `--patch` overlay (`config` is a whole-object replacement):

```yaml
- id: dsh-service-control
  config:
    profile: tui
```

Persistent tunables (env vars also work; `dshctl config set` writes them per-profile to `$XDG_CONFIG_HOME/dsh-service-control/<profile>.conf`):

| Key | Default | Description |
|---|---|---|
| `DSH_WATCHDOG_INTERVAL` | `3` | Watchdog probe interval (seconds) |
| `DSH_WATCHDOG_FAIL_LIMIT` | `3` | Consecutive failed probes before restart |
| `DSH_WATCHDOG_PROBE_TIMEOUT` | `3` | Per-probe HTTP timeout (seconds) |
| `DSH_WATCHDOG_COOLDOWN` | `15` | Cooldown after a watchdog-triggered restart (seconds) |
| `DSH_OPEN_CMD` | `xdg-open` | Browser opener used by start/open |
| `DSH_BIN` | `dsh` | dsh binary used for raw (non-systemd) start |
| `DSH_LOG` | per-day file | Full log file path override |
| `DSH_LOG_DIR` | `$HOME/.dsh/logs/dsh` | Log directory override |

## Testing

```bash
npm test        # unit tests: plugin shape / Config / inject / patch line
npm run smoke   # smoke test: installs into an isolated profile → asserts combined config → starts → probes /dsh-health (auto-skips when the dsh CLI is missing)
```

## Uninstall

```bash
dshctl uninstall             # ① remove CLI link + completions + systemd boot-autostart units
dsh plugin --profile web remove dsh-service-control   # ② remove the plugin itself (repeat per profile)
Restart the web profile      # ③ quit the current dsh web process and start again
```

`dshctl uninstall` scans `~/.config/systemd/user/`, auto-detects and removes units created by `dshctl enable` (`dsh-<profile>.service`, matched by this plugin's template signature; only our own files are removed — same-named units not created by the plugin are kept): it runs `systemctl --user disable` first, then deletes the files and `daemon-reload`s.

Possible residue: the legacy `/tmp/dsh-web.log` (new logs live in `~/.dsh/logs/dsh/`).

> Crash auto-recovery requires an out-of-process mechanism (a plugin cannot save itself when its process dies) — a systemd user service is recommended.
