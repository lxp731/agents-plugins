---
name: spotify-linux
description: "Control Spotify on Linux via MPRIS DBus. Use when: launching Spotify from command line, playing/pausing/skipping tracks, searching songs and switching playback to a specific track, any Spotify playback control task on Linux."
---

# Spotify Linux Control

Control Spotify desktop client on Linux through MPRIS DBus — no browser automation, no simulated clicks.

## ⚠️ Scope and Warnings

This skill controls the **real Spotify client on the local desktop**. Every command takes effect immediately:

- `OpenUri` starts the track playing right away, at the current volume, and replaces the current playback context. Confirm the track/album/playlist URI matches what the user asked for before calling it.
- Playback state and volume changes are live — they alter what the user is currently hearing.
- Launching starts Spotify as a desktop background process: a systemd `--user` unit named `spotify-skill-launch`, visible via `systemctl --user status spotify-skill-launch` and stoppable with `scripts/launch_spotify.sh --stop`.
- The launcher only ever uses the invoking user's own graphical-session credentials, and refuses to run as root.

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

Use the bundled launcher — it resolves the session credentials and proxy settings safely and hands Spotify to the user's systemd manager, so the process is tracked and can be stopped cleanly.

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

Verify the candidate before `OpenUri`: each search-result card carries its title in the entity image's `alt`/`aria-label` — `播放 <artist> 的 <title>` on the Chinese UI, `Play <title> by <artist>` on the English UI — and its artist in a subtitle link `href="/artist/<id>"`. Confirm both match what the user asked for, then use `spotify:track:<id>` (the artist link is the artist URI).

```bash
# 5. ALWAYS delete the profile copy afterwards — it contains the user's login credentials
rm -rf /tmp/chrome-prof /tmp/spotify_dom.html
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
