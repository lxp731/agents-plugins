---
name: spotify-linux
description: "Control Spotify on Linux via MPRIS DBus. Use when: launching Spotify from command line, playing/pausing/skipping tracks, searching songs and switching playback to a specific track, any Spotify playback control task on Linux."
allowed-tools:
  - Bash
  - WebSearch
---

# Spotify Linux Control

Control Spotify desktop client on Linux through MPRIS DBus — no browser automation, no simulated clicks.

## ⚠️ Scope and Warnings

This skill controls the **real Spotify client on the local desktop**. Every command takes effect immediately:

- `OpenUri` starts the track playing right away, at the current volume, and replaces the current playback context. Confirm the track/album/playlist URI matches what the user asked for before calling it.
- Playback state and volume changes are live — they alter what the user is currently hearing.
- Launching starts Spotify as a desktop background process: a systemd `--user` unit named `spotify-skill-launch`, visible via `systemctl --user status spotify-skill-launch` and stoppable with `scripts/launch_spotify.sh --stop`.
- The launcher only ever uses the invoking user's own graphical-session credentials, and refuses to run with elevated privileges.

Use this skill only on your own desktop session.

## Prerequisites

- Spotify desktop client installed. The launcher auto-detects any of these install methods:
  - native package providing a `spotify` executable (Arch/AUR, Debian/Ubuntu .deb)
  - `spotify-launcher` (the community launcher, common on Fedora)
  - Flatpak: `flatpak install com.spotify.Client`
  - Snap: `snap install spotify`
- An active X11 session (or Wayland with XWayland) for the invoking user
- `dbus-send` (bundled with DBus, always present); `rsync` is needed only for the logged-in browser search (§2a)
- `systemd --user` manager (present in every desktop session on systemd-based distributions)

## Quick Start

```bash
# Pause/Play toggle
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player.PlayPause

# Next/Previous
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player.Next
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player.Previous
```

## 1. Launch Spotify (Managed Background Process)

Use the bundled launcher — it resolves the session credentials and proxy settings safely and hands Spotify to the user's systemd manager, so the process is tracked and can be stopped cleanly. Its complete source ships at `scripts/launch_spotify.sh` in this package and is reproduced inline in the Appendix for auditability.

**Always call it by absolute path.** The script lives next to this `SKILL.md`; the agent's working directory is usually not the skill directory, and a relative `scripts/launch_spotify.sh` fails with "No such file or directory". Install paths also vary by environment, so locate the launcher instead of assuming a fixed path:

```bash
# Find the installed skill directory via the launcher (clawhub/Claude Code
# install skills in different places per environment):
SKILL_DIR="$(dirname "$(dirname "$(find "$HOME" -name launch_spotify.sh -path '*spotify*' 2>/dev/null | head -n1)")")"
if [ ! -x "$SKILL_DIR/scripts/launch_spotify.sh" ]; then
  SKILL_DIR="<replace with the directory holding this SKILL.md>"
fi
"$SKILL_DIR/scripts/launch_spotify.sh"             # start (or confirm it is already running)
"$SKILL_DIR/scripts/launch_spotify.sh" --check     # diagnose without launching anything
"$SKILL_DIR/scripts/launch_spotify.sh" --stop      # stop the managed instance
```

What the launcher does:

1. Uses `$DISPLAY` and `$XAUTHORITY` from the environment when present, after validating them.
2. Otherwise looks for credentials in the invoking user's own session only: `~/.Xauthority`, then Xauthority files under `$XDG_RUNTIME_DIR`, then the user's own Xwayland/Xorg processes. Every candidate must be a regular file owned by the invoking user with no group/other access, or it is rejected.
3. Resolves proxy settings from the calling environment, falling back to KDE's `~/.config/kioslaverc`, and forwards them into the unit. A `systemd --user` unit inherits the systemd user manager's environment, which has no proxy variables — so without this step Spotify would take the direct route instead of the session's configured one.
4. Launches Spotify as a transient `systemd-run --user` unit named `spotify-skill-launch` — independent of the agent process tree, visible in `systemctl --user`, stoppable on demand.
5. Waits for DBus registration (~5-8 seconds), then reports what the client actually holds, e.g.:

```
Spotify ready (took 3s, proxy: kioslaverc)
  state: Playing, track: 克卜勒
```

Read that report. `state: Stopped, no track loaded` means the client registered but has nothing to play — it is signed out or still initializing, and **every MPRIS command will answer successfully while changing nothing**. Confirm sign-in/network and re-launch before issuing control commands.

## 2. Search and Play a Track

MPRIS has no search method. The workflow: web-search → extract Spotify track ID → `OpenUri`. If web search can't find the track (new releases are rarely indexed anywhere), fall back to §2a below.

```bash
# Step 1: Search the web for the track to get its Spotify URL
# Example search: "李白 李荣浩 spotify"
# Extract the track ID from URL like: https://open.spotify.com/track/0aLtafjN146xAdZeqYN8Ho

# Step 2: Call OpenUri with the spotify:track:<ID> URI
TRACK_ID="0aLtafjN146xAdZeqYN8Ho"
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 \
  org.mpris.MediaPlayer2.Player.OpenUri \
  string:"spotify:track:$TRACK_ID"
```

> ⚠️ **Immediate playback:** `OpenUri` makes Spotify load the track and start playing instantly, at the current volume, replacing the current playback context. Confirm the URI first — no additional `Play` call is needed.

URL types supported:
- `spotify:track:<id>` — single track
- `spotify:album:<id>` — full album
- `spotify:playlist:<id>` — playlist
- `spotify:artist:<id>` — artist page

### 2a. When Web Search Fails: Search with the User's Logged-in Browser

New releases and region-locked tracks are often missing from search engines and third-party indexes (MusicBrainz, Deezer, song.link lag months). The user's own browser usually has a saved Spotify login — render the Spotify search page with that session and read the track ID out of the results.

This flow needs a **Chromium-based browser with a saved open.spotify.com login** — Google Chrome, Chromium, or Brave all work.

> ⚠️ **User consent required:** this fallback copies the user's browser profile — saved logins, cookies, and session state — into a temp directory. Only run it when the user has explicitly asked for a track that web search cannot locate, and tell the user their browser session is being used. If they decline, ask them to paste the Spotify link instead.

```bash
# 1. Pick an installed Chromium-based browser that has a profile (Chrome, Chromium, Brave).
BROWSER_BIN="" ; PROFILE_SRC=""
for cand in "google-chrome-stable:$HOME/.config/google-chrome" \
            "chromium:$HOME/.config/chromium" \
            "brave-browser:$HOME/.config/BraveSoftware/Brave-Browser"; do
  bin=${cand%%:*}; prof=${cand#*:}
  if command -v "$bin" >/dev/null 2>&1 && [ -d "$prof/Default" ]; then
    BROWSER_BIN="$bin"; PROFILE_SRC="$prof"; break
  fi
done
[ -n "$BROWSER_BIN" ] || { echo "No Chromium-based browser profile found — ask the user to paste the Spotify link instead"; exit 1; }

# 2. Copy the profile (excluding caches) to a temp dir.
#    A copy avoids the running instance's singleton lock and keeps the original untouched.
mkdir -p /tmp/chrome-prof
cp "$PROFILE_SRC/Local State" /tmp/chrome-prof/
rsync -a --exclude='Cache' --exclude='Code Cache' --exclude='Service Worker' \
  --exclude='GPUCache' --exclude='blob_storage' --exclude='IndexedDB' \
  "$PROFILE_SRC/Default/" /tmp/chrome-prof/Default/

# 3. Render the search page with the logged-in session.
#    The URL query must be percent-encoded (e.g. 王菲 主角 → %E7%8E%8B%E8%8F%B2%20%E4%B8%BB%E8%A7%92).
"$BROWSER_BIN" --headless=new --user-data-dir=/tmp/chrome-prof \
  --no-first-run --no-default-browser-check --disable-gpu \
  --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36" \
  --virtual-time-budget=20000 --dump-dom \
  "https://open.spotify.com/search/<encoded-query>" > /tmp/spotify_dom.html

# 4. Extract candidate track links:
grep -oE 'href="/track/[A-Za-z0-9]+"' /tmp/spotify_dom.html
```

Verify the candidate before `OpenUri`: each search-result card carries its title in the entity image's `alt`/`aria-label` — the wording follows the user's UI language (e.g. Chinese: `播放 <artist> 的 <title>`, English: `Play <title> by <artist>`) — and its artist in a subtitle link `href="/artist/<id>"`. Confirm both match what the user asked for, then use `spotify:track:<id>` (the artist link is the artist URI).

```bash
# 5. ALWAYS delete the profile copy afterwards — it contains the user's login credentials
rm -r -- /tmp/chrome-prof /tmp/spotify_dom.html
```

- Works while the user's browser session is active; the headless run uses the same machine, so the cookie encryption key resolves through the session keyring.
- A logged-out copy renders a login wall instead — the dumped DOM then contains no `/track/` links. If that happens, ask the user to log in on open.spotify.com first, or fall back to having them paste the link.
- No Chromium-based browser installed? Ask the user to paste the Spotify link directly.

## 3. Read Playback State

```bash
# Current play/pause status
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 \
  org.freedesktop.DBus.Properties.Get \
  string:org.mpris.MediaPlayer2.Player string:PlaybackStatus

# Current track metadata (title, artist, album, URL, art, etc.)
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 \
  org.freedesktop.DBus.Properties.Get \
  string:org.mpris.MediaPlayer2.Player string:Metadata
```

Key metadata fields in returned dict:
- `xesam:title` — track title
- `xesam:artist` — artist (array)
- `xesam:album` — album name
- `xesam:url` — Spotify web URL
- `mpris:trackid` — internal track ID path
- `mpris:artUrl` — album art URL

## 4. Volume Control

```bash
# Set volume (0.0 to 1.0)
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 \
  org.freedesktop.DBus.Properties.Set \
  string:org.mpris.MediaPlayer2.Player string:Volume \
  variant:double:0.5

# Read current volume
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 \
  org.freedesktop.DBus.Properties.Get \
  string:org.mpris.MediaPlayer2.Player string:Volume
```

## 5. Check If Spotify Is Running

```bash
# Quick: process check
pgrep -a spotify

# Reliable: DBus check (confirms fully initialized)
dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply \
  /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null | grep spotify
```

DBus check is preferred because it confirms the client is fully initialized and ready for commands; process check alone can give false positives when Spotify is still starting up.

## 6. Play Daily Recommendation Playlists

"今日推荐" / "每日推荐" maps to Spotify's Daily Mix series — personalized playlists updated daily. Other recommendation playlists include Discover Weekly and Release Radar.

```bash
# Daily Mix 1-6 (personalized, content varies per user/region)
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 \
  org.mpris.MediaPlayer2.Player.OpenUri \
  string:"spotify:playlist:37i9dQZF1E37SmkLuYDrmF"  # Daily Mix 1 (personalized — content differs per account)

# Discover Weekly (每周新发现)
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 \
  org.mpris.MediaPlayer2.Player.OpenUri \
  string:"spotify:playlist:37i9dQZEVXcJZyENOWUFo7"

# Release Radar (新歌雷达)
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 \
  org.mpris.MediaPlayer2.Player.OpenUri \
  string:"spotify:playlist:37i9dQZEVXbhM8yqJpzH4B"
```

Note: Daily Mix URIs with `37i9dQZF1E37` prefix are personalized — the same URI shows different content for each user. Content displayed in search results may differ from what the user hears.

## 7. Verify a Command Took Effect

MPRIS methods return success even when the client ignores them, so after a
playback command, read the state back:

```bash
# Playback status + current title, one shot
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 \
  org.freedesktop.DBus.Properties.Get \
  string:org.mpris.MediaPlayer2.Player string:PlaybackStatus
dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
  /org/mpris/MediaPlayer2 \
  org.freedesktop.DBus.Properties.Get \
  string:org.mpris.MediaPlayer2.Player string:Metadata
```

- After `Play`/`PlayPause`, `PlaybackStatus` must change.
- After `Next`, `xesam:title` must change.
- `Previous` restarts the current track when more than ~3s have elapsed and
  only then steps back on a second call — an unchanged title there is normal
  Spotify behaviour, not a failed command.
- If nothing changes at all, the client has no track loaded — see Troubleshooting.

## 8. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `scripts/launch_spotify.sh: No such file or directory` | The path is relative to the skill directory, not the agent's cwd — and install paths vary by environment. Locate the launcher with the find-based `SKILL_DIR` in §1 instead of assuming a fixed path. |
| Commands return success but nothing happens | The client has no track loaded (signed out or still initializing). Run `--check`; if it reports `no track loaded`, run `--stop` then launch again and re-read the state before sending more commands. |
| Music stops when the agent session restarts | Spotify was started as a plain child of the agent, so it lives in the agent's cgroup and is killed with it. Use the launcher: its systemd `--user` unit is independent of the agent. |
| `WARNING: Spotify process running but DBus not registered after 15s` | The client failed to start. Check `systemctl --user status spotify-skill-launch` and `journalctl --user -u spotify-skill-launch`. |
| `--check` reports `cannot reach accounts.spotify.com` | No track loaded: no working network route (proxy missing or down) — fix connectivity before launching. Track loaded and playing: probe false negative (the probe is a heuristic), ignore it — `--check` says so explicitly in that case. |
| Web search finds no Spotify link for the track | New release not yet indexed by search engines or third-party sources. Use the logged-in browser search (§2a). |

## Common DBus Destinations

| Action       | Method                                                  |
| ------------ | ------------------------------------------------------- |
| Play         | `org.mpris.MediaPlayer2.Player.Play`                   |
| Pause        | `org.mpris.MediaPlayer2.Player.Pause`                  |
| PlayPause    | `org.mpris.MediaPlayer2.Player.PlayPause`              |
| Next         | `org.mpris.MediaPlayer2.Player.Next`                   |
| Previous     | `org.mpris.MediaPlayer2.Player.Previous`               |
| Stop         | `org.mpris.MediaPlayer2.Player.Stop`                   |
| Seek         | `org.mpris.MediaPlayer2.Player.Seek` (int64:offset-us) |
| OpenUri      | `org.mpris.MediaPlayer2.Player.OpenUri` (string:uri)   |
| SetPosition  | `org.mpris.MediaPlayer2.Player.SetPosition` (trackId,position) |

## Appendix: Launcher Source (Audit Reference)

The complete source of the launcher referenced in §1, reproduced inline so that reviewers and security scanners can inspect it without opening the file. The canonical copy ships at `scripts/launch_spotify.sh`; when the two differ, the file in this package is authoritative.

```bash
#!/usr/bin/env bash
# Start or stop the Spotify desktop client inside the invoking user's own
# graphical session.
#
# Usage:
#   scripts/launch_spotify.sh            start Spotify as a systemd --user unit
#   scripts/launch_spotify.sh --stop     stop the managed Spotify instance
#   scripts/launch_spotify.sh --check    resolve and validate session credentials
#                                        without launching anything
#
# Security model:
#   * Only the invoking user's own session credentials are ever used.
#   * Every Xauthority candidate must be a regular file owned by the invoking
#     user with no group/other access, or it is rejected.
#   * Elevated execution is refused: a privileged process must not pick up or
#     read other users' graphical credentials.
#   * Spotify runs as a transient systemd --user unit (`spotify-skill-launch`),
#     independent of this process tree but visible in `systemctl --user` and
#     stoppable via `--stop`.
#
# Network model (important behind a proxy):
#   A systemd user unit inherits the systemd user manager's environment, which
#   usually has NO http_proxy/https_proxy — unlike a shell started from the
#   desktop session. Spotify then cannot reach its servers, sits at the sign-in
#   page, and answers every MPRIS command with success while doing nothing.
#   This script resolves proxy settings from, in order:
#     1) the caller's environment (http_proxy / https_proxy / ftp_proxy /
#        all_proxy / no_proxy, upper- or lower-case), then
#     2) KDE's proxy configuration (~/.config/kioslaverc, manual proxy only),
#   and forwards them into the unit. It also probes reachability before
#   launching and reports whether the running client actually has content
#   loaded, so a signed-out client is visible instead of silently inert.
set -euo pipefail

UNIT="spotify-skill-launch"
KIOSLAVERC="${HOME:-/home/$USER}/.config/kioslaverc"

fail() { echo "ERROR: $*" >&2; exit 1; }
warn() { echo "WARNING: $*" >&2; }

# ---------------------------------------------------------------------------
# Stop
# ---------------------------------------------------------------------------
if [ "${1:-start}" = "--stop" ]; then
  if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/systemd/private" ] \
    && systemctl --user --quiet is-active "$UNIT" 2>/dev/null; then
    systemctl --user stop "$UNIT"
    echo "Spotify stopped (systemd unit: $UNIT)"
    exit 0
  fi
  if command -v pkill >/dev/null 2>&1 && pgrep -x spotify >/dev/null 2>&1; then
    pkill -x spotify
    echo "Spotify stopped"
  else
    echo "Spotify is not running"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Common prerequisites
# ---------------------------------------------------------------------------
[ "$(id -u)" -ne 0 ] || fail "refusing to run with elevated privileges; launch from the desktop user's session"

# Session bus for the DBus checks (standard per-user socket when the env var
# is unset).
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

# Resolve the Spotify executable: native packages and spotify-launcher first,
# then Flatpak and Snap. Every install method registers the same DBus name
# (org.mpris.MediaPlayer2.spotify), so the MPRIS commands in the skill work
# regardless of how Spotify was installed.
SPOTIFY_CMD=()
if command -v spotify >/dev/null 2>&1; then
  SPOTIFY_CMD=(spotify)
elif command -v spotify-launcher >/dev/null 2>&1; then
  SPOTIFY_CMD=(spotify-launcher)
elif command -v flatpak >/dev/null 2>&1 \
  && flatpak list --app 2>/dev/null | grep -q 'com.spotify.Client'; then
  SPOTIFY_CMD=(flatpak run com.spotify.Client)
elif command -v snap >/dev/null 2>&1 && snap list 2>/dev/null | grep -q '^spotify'; then
  SPOTIFY_CMD=(snap run spotify)
fi

# valid_auth <path>: print the canonical path if (and only if) it is a regular
# file owned by the invoking user and not accessible by group/other.
valid_auth() {
  local f="$1" resolved mode uid
  resolved=$(readlink -f -- "$f") || return 1
  [ -f "$resolved" ] || return 1
  uid=$(stat -c '%u' -- "$resolved") || return 1
  [ "$uid" = "$(id -u)" ] || return 1
  mode=$(stat -c '%a' -- "$resolved") || return 1
  [ $((8#$mode & 077)) -eq 0 ] || return 1
  printf '%s\n' "$resolved"
}

# ---------------------------------------------------------------------------
# Proxy resolution
#
# A systemd user unit inherits the user manager's environment, which normally
# carries no proxy variables (a desktop shell exports those). A client started
# without them takes the direct route instead of the session's configured one —
# on networks where direct access to Spotify is unreliable or blocked, the
# client then stalls before signing in and every MPRIS command answers
# successfully while doing nothing. Forwarding the session's proxy settings
# keeps Spotify on the route the rest of the desktop already uses.
# ---------------------------------------------------------------------------

# kde_proxy <Key>: print a [Proxy Settings] value from KDE's kioslaverc.
kde_proxy() {
  [ -f "$KIOSLAVERC" ] || return 0
  awk -v key="$1" '
    /^\[/ { insec = ($0 == "[Proxy Settings]"); next }
    insec && index($0, key "=") == 1 { sub(/^[^=]*=/, ""); print; exit }
  ' "$KIOSLAVERC" 2>/dev/null
}

# normalize_proxy <value>: KDE stores "host port" pairs; turn them into a URL.
normalize_proxy() {
  local v="$1" host port
  case "$v" in
    *" "*)
      host=${v%% *}
      port=${v##* }
      case "$host" in *"://"*) ;; *) host="http://$host" ;; esac
      printf '%s:%s\n' "$host" "$port"
      ;;
    *"://"*) printf '%s\n' "$v" ;;
    *) printf 'http://%s\n' "$v" ;;
  esac
}

PROXY_SOURCE=""

# 1) The caller's environment (either case) takes precedence. Note: the
#    variables are read, never pre-initialised — assigning them here would
#    shadow the inherited values.
for name in http_proxy https_proxy ftp_proxy all_proxy no_proxy; do
  upper=$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')
  eval "val=\${$name:-}"
  [ -z "$val" ] && eval "val=\${$upper:-}"
  if [ -n "$val" ]; then
    printf -v "$name" '%s' "$val"
    PROXY_SOURCE="environment"
  fi
done

# 2) KDE's configured manual proxy fills whatever the environment left unset.
#    socksProxy is deliberately not mapped to all_proxy: exporting a SOCKS
#    proxy for every protocol makes HTTP clients (e.g. the reachability probe)
#    take a route the Spotify client itself never uses.
kde_used=0
if [ "$(kde_proxy ProxyType)" = "1" ]; then
  for pair in "http_proxy:httpProxy" "https_proxy:httpsProxy" "ftp_proxy:ftpProxy"; do
    var=${pair%%:*}; key=${pair##*:}
    eval "cur=\${$var:-}"
    [ -n "$cur" ] && continue
    val=$(kde_proxy "$key")
    [ -n "$val" ] && { printf -v "$var" '%s' "$(normalize_proxy "$val")"; kde_used=1; }
  done
  if [ -z "${no_proxy:-}" ]; then
    val=$(kde_proxy NoProxyFor)
    [ -n "$val" ] && { no_proxy="$val"; kde_used=1; }
  fi
  if [ -z "${https_proxy:-}" ] && [ -n "${http_proxy:-}" ]; then
    https_proxy=$http_proxy
  fi
  [ "$kde_used" = 1 ] && PROXY_SOURCE="${PROXY_SOURCE:+$PROXY_SOURCE+}kioslaverc"
fi

for name in http_proxy https_proxy ftp_proxy all_proxy no_proxy; do
  eval "val=\${$name:-}"
  [ -n "$val" ] && export "$name=$val"
done

# check_network: can we reach Spotify's sign-in host with the current settings?
# The probe is deliberately heuristic: curl's network path (TLS stack, proxy
# policy group, timeouts) can differ from the Spotify client's own, so a
# failure here is a hint, not a diagnosis — the client's loaded-track state is
# the authoritative signal. Two attempts: the request as-configured (proxy env
# variables and no_proxy apply), then, when a proxy is set, the same request
# forced through that proxy with no_proxy ignored.
NET_OK="unknown"
check_network() {
  command -v curl >/dev/null 2>&1 || { NET_OK="unknown"; return 0; }
  local code px
  local args=(-sS --connect-timeout 5 -m 12 -o /dev/null -w '%{http_code}')
  # 1) As configured: the same environment variables the Spotify unit inherits.
  code=$(curl "${args[@]}" https://accounts.spotify.com/ 2>/dev/null) || code=""
  case "$code" in
    ""|000) ;;
    *) NET_OK="yes"; return 0 ;;   # any HTTP reply means the host is reachable
  esac
  # 2) With a proxy configured, retry forcing the request through it. This
  #    covers setups where the as-configured path is flaky for curl but the
  #    client (which always honors the proxy variables) gets through.
  px="${https_proxy:-${HTTPS_PROXY:-${http_proxy:-${HTTP_PROXY:-}}}}"
  if [ -n "$px" ]; then
    code=$(curl "${args[@]}" --noproxy "" -x "$px" https://accounts.spotify.com/ 2>/dev/null) || code=""
    case "$code" in
      ""|000) ;;
      *) NET_OK="yes"; return 0 ;;
    esac
  fi
  NET_OK="no"
}

# ---------------------------------------------------------------------------
# Client state helpers
# ---------------------------------------------------------------------------

# mpris_prop <Property>: raw reply for a Player property.
mpris_prop() {
  dbus-send --print-reply --dest=org.mpris.MediaPlayer2.spotify \
    /org/mpris/MediaPlayer2 org.freedesktop.DBus.Properties.Get \
    string:org.mpris.MediaPlayer2.Player "string:$1" 2>/dev/null
}

spotify_registered() {
  dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply \
    /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null | grep -q spotify
}

# spotify_state: print "<PlaybackStatus>|<xesam:title>|<mpris:trackid>".
# An empty trackid means the client has no track loaded — freshly started,
# signed out, or still initializing. Such a client answers every MPRIS command
# with success while changing nothing, which is easy to mistake for a working
# client, so the launcher reports this state instead of a bare "ready".
spotify_state() {
  local st ti tid meta
  # Each substitution is guarded: under `set -e` a grep with no match would
  # otherwise abort the script — precisely in the "no track loaded" case this
  # function exists to report.
  st=$(mpris_prop PlaybackStatus | tail -1 | grep -oE '"(Playing|Paused|Stopped)"' | tr -d '"') || true
  meta=$(mpris_prop Metadata) || true
  ti=$(printf '%s\n' "$meta" | grep -A1 '"xesam:title"' | tail -1 | sed -n 's/.*string "\(.*\)"$/\1/p') || true
  tid=$(printf '%s\n' "$meta" | grep -A1 '"mpris:trackid"' | tail -1 | sed -n 's/.*string "\(.*\)"$/\1/p') || true
  printf '%s|%s|%s\n' "${st:-unknown}" "$ti" "$tid"
}

# describe_running: print a health line for the registered client.
describe_running() {
  local state st ti tid
  state=$(spotify_state)
  IFS='|' read -r st ti tid <<<"$state"
  if [ -z "$tid" ]; then
    echo "  state: $st, no track loaded — the client may be signed out or still initializing."
    [ "$NET_OK" = "no" ] && echo "  network: cannot reach accounts.spotify.com — check the proxy settings."
    echo "  MPRIS commands will answer but have no effect. If this persists, run"
    echo "  '$0 --stop' and launch again once connectivity works."
  else
    echo "  state: $st, track: ${ti:-unknown}"
  fi
}

# ---------------------------------------------------------------------------
# Session credential resolution (invoking user only)
# ---------------------------------------------------------------------------
AUTH=""

# 1) Caller's environment. If XAUTHORITY is set it must validate; otherwise
#    fail rather than silently substituting another session's credentials.
if [ -n "${XAUTHORITY:-}" ]; then
  AUTH=$(valid_auth "$XAUTHORITY") \
    || fail "XAUTHORITY=$XAUTHORITY is not a regular file owned by you without group/other access"
fi

# 2) Standard per-user locations.
if [ -z "$AUTH" ] && [ -f "$HOME/.Xauthority" ]; then
  AUTH=$(valid_auth "$HOME/.Xauthority") || true
fi
if [ -z "$AUTH" ] && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  for cand in "$XDG_RUNTIME_DIR"/xauth_*; do
    [ -f "$cand" ] || continue
    AUTH=$(valid_auth "$cand") || AUTH=""
    [ -n "$AUTH" ] && break
  done
fi

# 3) Last resort: the invoking user's own X server processes. Other users'
#    processes are never scanned, and the discovered file still has to pass
#    the ownership/permission validation above.
if [ -z "$AUTH" ]; then
  line=$(ps -u "$(id -u)" -o args= 2>/dev/null \
    | grep -E -- '[X]wayland|[X]org' \
    | grep -E -- '-auth[ =]\S+' | head -n1 || true)
  if [ -n "$line" ]; then
    cand=$(printf '%s\n' "$line" | grep -oE -- '-auth[ =]\S+' | head -n1 | sed -E 's/^-auth[ =]//') || true
    if [ -n "$cand" ]; then
      AUTH=$(valid_auth "$cand") || AUTH=""
    fi
  fi
fi

[ -n "$AUTH" ] || fail "no usable Xauthority file for your session; set DISPLAY/XAUTHORITY or run from within your desktop session"
export XAUTHORITY="$AUTH"

# Display: caller's env first (validated against a live X11 socket), then the
# display of the matched X server process, then the invoking user's own X11
# sockets.
DISPLAY_VAL=""
if [ -n "${DISPLAY:-}" ]; then
  DISPLAY_VAL="$DISPLAY"
elif [ -n "${line:-}" ]; then
  d=$(printf '%s\n' "$line" | grep -oE ':[0-9]+' | head -n1 | tr -d ':') || true
  [ -n "${d:-}" ] && DISPLAY_VAL=":$d"
fi
if [ -z "$DISPLAY_VAL" ]; then
  for sock in /tmp/.X11-unix/X*; do
    [ -S "$sock" ] || continue
    [ "$(stat -c '%u' -- "$sock" 2>/dev/null)" = "$(id -u)" ] || continue
    DISPLAY_VAL=":${sock##*X}"
    break
  done
fi
[ -n "$DISPLAY_VAL" ] || fail "could not determine your graphical display; set DISPLAY explicitly"

# Validate the display: must name a live local X11 socket.
dnum=$(printf '%s\n' "$DISPLAY_VAL" | grep -oE '[0-9]+$' || true)
[ -n "$dnum" ] || fail "unsupported DISPLAY value: $DISPLAY_VAL"
[ -S "/tmp/.X11-unix/X$dnum" ] \
  || fail "DISPLAY=$DISPLAY_VAL: no X11 socket /tmp/.X11-unix/X$dnum; is the graphical session active?"
export DISPLAY="$DISPLAY_VAL"

# ---------------------------------------------------------------------------
# Check mode: report what would be used, without launching anything
# ---------------------------------------------------------------------------
if [ "${1:-start}" = "--check" ]; then
  echo "DISPLAY=$DISPLAY"
  echo "XAUTHORITY=$XAUTHORITY"
  if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/systemd/private" ]; then
    echo "systemd --user manager: available"
  else
    echo "systemd --user manager: unavailable"
  fi
  if [ ${#SPOTIFY_CMD[@]} -gt 0 ]; then
    echo "Spotify executable: ${SPOTIFY_CMD[*]}"
  else
    echo "Spotify executable: NOT FOUND — install the client first (see SKILL.md prerequisites)"
  fi
  case "$PROXY_SOURCE" in
    "") echo "proxy: none configured — direct connection only" ;;
    environment) echo "proxy: from the calling environment" ;;
    kioslaverc) echo "proxy: from $KIOSLAVERC" ;;
    *) echo "proxy: from the calling environment + $KIOSLAVERC" ;;
  esac
  [ -n "${http_proxy:-}" ] && echo "  http_proxy=${http_proxy}"
  [ -n "${https_proxy:-}" ] && echo "  https_proxy=${https_proxy}"
  [ -n "${no_proxy:-}" ] && echo "  no_proxy=${no_proxy}"
  # Client state first: when a track is loaded, the client demonstrably has
  # connectivity, so a failed probe below is a probe limitation, not an outage.
  if spotify_registered; then
    echo "Spotify: already running (DBus registered)"
    describe_running
  else
    echo "Spotify: not running"
  fi
  check_network
  case "$NET_OK" in
    yes) echo "network: accounts.spotify.com reachable" ;;
    no)
      if spotify_registered && [ -n "$(spotify_state | cut -d'|' -f3)" ]; then
        echo "network: probe failed, but the running client has a track loaded — probe false negative, connectivity is fine"
      else
        echo "network: cannot reach accounts.spotify.com — Spotify may start but stay at the sign-in page (proxy needed?)"
      fi
      ;;
    *) echo "network: not checked (curl unavailable)" ;;
  esac
  exit 0
fi

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
check_network

# Already running?
if spotify_registered; then
  echo "Spotify is already running (DBus registered)"
  describe_running
  exit 0
fi

[ "$NET_OK" != "no" ] \
  || warn "network probe could not reach accounts.spotify.com; Spotify may start but stay at the sign-in page"

# Hand Spotify to the user's systemd manager: it runs independently of this
# process tree, is visible via `systemctl --user status $UNIT`, and stops
# cleanly with `scripts/launch_spotify.sh --stop`.
if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -S "$XDG_RUNTIME_DIR/systemd/private" ]; then
  fail "systemd --user manager not reachable; launch from within your desktop session"
fi
if ! command -v systemd-run >/dev/null 2>&1; then
  fail "systemd-run not found"
fi

# Forward the resolved proxy settings into the unit: the systemd user manager's
# own environment usually has none, and a client without them cannot sign in.
env_args=(--setenv="DISPLAY=$DISPLAY" --setenv="XAUTHORITY=$XAUTHORITY")
for name in http_proxy https_proxy ftp_proxy all_proxy no_proxy; do
  eval "val=\${$name:-}"
  if [ -n "$val" ]; then
    env_args+=(--setenv="$name=$val")
    env_args+=(--setenv="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')=$val")
  fi
done

if [ ${#SPOTIFY_CMD[@]} -eq 0 ]; then
  fail "Spotify is not installed. Install the client first, e.g.:
  Arch/CachyOS: pacman -S spotify          (or spotify-launcher)
  Fedora:       flatpak install com.spotify.Client
  Ubuntu:       spotify-client .deb from spotify.com   (or snap install spotify)"
fi

systemctl --user stop "$UNIT" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" 2>/dev/null || true
systemd-run --user --unit="$UNIT" --collect "${env_args[@]}" \
  "${SPOTIFY_CMD[@]}" || fail "failed to start Spotify via systemd --user"

# Wait for DBus registration (Spotify needs ~5-8 seconds)
for i in $(seq 1 15); do
  sleep 1
  if spotify_registered; then
    echo "Spotify ready (took ${i}s, proxy: ${PROXY_SOURCE:-none})"
    # Give the client a moment to finish signing in, then report what it holds.
    sleep 3
    describe_running
    exit 0
  fi
done

warn "Spotify process running but DBus not registered after 15s"
exit 1
```
