# dsh-service-control

Wings for the `dsh` command: manage the service's systemd lifecycle, persisted
config and runtime diagnostics through **`dsh --profile ctl`**. No separate CLI
(the legacy `dshctl` is gone).

## Mechanism

The `dsh` launcher parses only its own flags (`--profile`/`--patch`/`--dump-config`)
and hands **everything after them** to the booted app tree verbatim. This plugin
takes over those inner arguments (via `@deepseek-ai/dsh-cmdline`) inside a
dedicated lightweight **`ctl` profile** (dsh-base + plugin, no webserver/agent),
executes the command and requests process exit. Each invocation boots a
lightweight profile (~0.2-0.5s).

## Install

```bash
# create the ctl profile and install (ctl is the conventional control-plane name)
dsh plugin --profile ctl add dsh-service-control

# local development install
dsh plugin --profile ctl add "file:/path/to/agents-plugins/dsh-service-control"
```

> **Do not** install this plugin into the `web` profile — its command tree
> conflicts with the web app's own argument parsing. It only works in a
> webserver-less profile like `ctl`.

## Commands

```
dsh --profile ctl <namespace> <subcommand> [args]
```

| Namespace | Command | Purpose |
|---|---|---|
| **self** | `info\|i` | plugin info: version, hosting `dsh` version, target profile, service URL (with token when running) |
| | `update [--check]` | self-update: upgrades by install source (link install → git pull; snapshot/registry → reinstall hint) |
| **config** | `get [key]` | show config (all keys without an argument) |
| | `set <key> <value>` | set + persist config (whitelisted keys, numeric validation) |
| **svc** | `doctor\|d` | one-shot self-diagnostics |
| | `logs [-f]` | view the dsh log file |
| | `probe\|h` | probe health (`/dsh-health` or `/`; reachability + latency) |
| | `open` | open the Web panel only (with token URL); does **not** start the service — prints a notice when it is not running |
| **systemd** | `install [--env …]` | install units (service + watchdog) → systemd-managed, **no boot autostart**; `--env` carries environment variables |
| | `reinstall --env …` | append environment variables to the installed unit (keeps user edits; no auto-restart) |
| | `status\|ps` | running state (pid/port/url/systemd state) |
| | `start\|up` | start (`systemctl start`, opens browser when ready) |
| | `stop\|down` | stop (`systemctl stop`, never auto-restarts) |
| | `restart\|reload` | restart (`systemctl restart`, no browser) |
| | `enable\|on` | boot autostart (auto-installs units if missing) |
| | `disable\|off` | stop watchdog + disable autostart (**keeps unit files**) |
| | `uninstall\|remove` | remove unit files (revoke systemd management) |
| | `journal [-f]` | view the systemd journal |
| **completions** | `[bash\|zsh\|fish]` | print the script for the detected/specified shell |
| | `--shell <x>` | pick the shell |
| | `--write-state` | cache all shell scripts to `$DSH_HOME/completions/dsh.<ext>` |
| | `--write-state --install` | cache + place into shell default load dirs (no rc edits) |

**URL & launch token**: since dsh 0.1.2 the web surface mints a random launch
token per process start and the bare `http://127.0.0.1:<port>` returns 401.
The `url` reported by `start`/`restart`/`status` and the address `start` opens
carry the current launch token (read back from the log); health probes
(`probe`/watchdog) treat 401/404 as “process alive” (HTTP layer reachable) and
only count connection failure/timeout as unhealthy.

**systemd lifecycle layering**:

```
install        = managed: write units + register → crash self-heal / watchdog active, 【no autostart】
reinstall      = append env vars: keeps the whole unit file, only inserts/updates the --env keys
enable         = managed + boot autostart (auto-installs when units are missing)
disable        = stop watchdog + disable autostart (unit files kept, management stays)
uninstall/remove = revoke management: remove unit files
```

**`--env` environment variables** (`install` / `reinstall`, repeatable):

```bash
# explicit value
dsh --profile ctl systemd install --env OPENROUTER_API_KEY=sk-xxxxx567
# implicit: take the value from the current shell env (unset or empty → install fails)
dsh --profile ctl systemd install --env OPENROUTER_API_KEY
# multiple variables
dsh --profile ctl systemd install --env A=1 --env B=2
# append to an installed unit (keeps manual edits; keys already present are skipped with a notice)
dsh --profile ctl systemd reinstall --env OPENROUTER_API_KEY=sk-xxxxx567
```

Variables are written as `Environment="KEY=value"` into the `[Service]` section of
the main unit (`$` is kept verbatim; `%`, quotes and backslashes are escaped per
systemd syntax). Note: environment variables of a unit are visible to same-user
D-Bus clients, so they are not suitable for highly sensitive secrets; the
implicit `--env KEY` form keeps the value out of shell history and the process
command line. `reinstall` only runs `daemon-reload` and **does not restart** —
new variables take effect on the next `dsh --profile ctl systemd restart`.

> Note: `plugin` is a parser-level alias of `self` (the original design name;
> supported by the commander tree and unit tests). However, the dsh launcher has
> a built-in `plugin` subcommand (forwarding to pnpm) that intercepts any call
> whose first positional argument is `plugin` (neither `--profile=ctl plugin` nor
> the `--` separator can bypass it), so use `self` in your shell.

**`self update` semantics** (by install source):

| Install source | Detection | update behavior |
|---|---|---|
| `link:` (dev install; node_modules entry is a symlink) | source dir inside a git repo | `git fetch` + `--ff-only` merge; refuses when local is ahead (protects local changes); auto-falls back to `ls-remote` when no upstream is configured |
| `file:` snapshot / npm registry | non-git, non-link | prints a hint to re-run `pnpm add dsh-service-control@latest` in the ctl profile dir |

`--check` only preflights (reports install source and local/remote diff) without
updating; since every dsh invocation is a fresh process, the update takes effect
on the next call.

## Target profile

`ctl` is the control plane; the **managed service profile defaults to `web`**.
Override it in the ctl profile's `cordis.patch.yml`:

```yaml
- id: dsh-service-control
  config:
    profile: tui
```

## Completions (placed into each shell's default load dirs — no rc edits)

```bash
dsh --profile ctl completions --install          # install all three shells
dsh --profile ctl completions --install bash     # install bash only
dsh --profile ctl completions bash               # print the script only (no install)
dsh --profile ctl completions --write-state      # cache to $DSH_HOME/completions (optional)
```

`--install` places the generated scripts into each shell's **default auto-load
directory** and **never edits the user's .zshrc / .bashrc / fish config**:

| shell | install path | auto-load condition |
|---|---|---|
| bash | `~/.local/share/bash-completion/completions/dsh` | bash-completion installed (default on mainstream distros) |
| zsh | `~/.zsh/completions/_dsh` | `~/.zsh/completions` in `$fpath` (included by oh-my-zsh & co.) |
| fish | `~/.config/fish/completions/dsh.fish` | natively auto-loaded by fish |

The scripts complete the `dsh` command itself (`--profile ctl` + the full command
tree) plus each subcommand's options: `self update --check`, `-f/--follow` for
`svc logs` / `systemd journal`, and `--shell <bash|zsh|fish> / --write-state /
--install` for `completions`. Both `--profile ctl` and the `--profile=ctl`
equals form are recognized; `--shell` values work in space and equals forms.

## Config keys (`config set` whitelist)

| Key | Default | Purpose |
|---|---|---|
| `DSH_WATCHDOG_INTERVAL` | `3` | watchdog probe interval (s) |
| `DSH_WATCHDOG_FAIL_LIMIT` | `3` | consecutive failures before restart |
| `DSH_WATCHDOG_PROBE_TIMEOUT` | `3` | per-probe HTTP timeout (s) |
| `DSH_WATCHDOG_COOLDOWN` | `15` | cooldown after a watchdog restart (s) |
| `DSH_OPEN_CMD` | `xdg-open` | browser opener |
| `DSH_BIN` | `dsh` | dsh binary (baked into the unit) |
| `DSH_LOG` | per-day file | log file path |
| `DSH_LOG_DIR` | `~/.dsh/logs/dsh` | log directory |

## Platform & dependencies

- Linux primary: `bash`, `systemctl` (optional — autostart commands error without it), `pgrep`/`pkill`, `ss` or `lsof`, `curl`.
- macOS partially supported (`ss`→`lsof`, `probe` latency falls back to `node`, browser falls back to `open`); systemd commands unavailable.
- Windows requires WSL.
- Dependencies: `@deepseek-ai/dsh-cmdline`, `commander`, `@deepseek-ai/schemastery` (Node ≥ 18).

## Testing

```bash
npm test        # unit: command-tree parsing (aliases/flags/exit), completion generation,
                # control.sh systemd layering (install/enable/disable/uninstall), plugin shape
npm run smoke   # smoke: isolated profile install → composed-config assert → cmdline self info / systemd status
```

## Uninstall

```bash
dsh plugin --profile ctl remove dsh-service-control   # remove the plugin itself
rm -rf ~/.dsh/profiles/ctl                            # (optional) drop the control profile
dsh --profile ctl systemd uninstall                   # (optional) revoke systemd management first
```
