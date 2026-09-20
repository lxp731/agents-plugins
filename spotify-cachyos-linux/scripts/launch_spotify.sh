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
#   * Root execution is refused: an elevated process must not pick up or read
#     other users' graphical credentials.
#   * Spotify runs as a transient systemd --user unit (`spotify-skill-launch`),
#     independent of this process tree but visible in `systemctl --user` and
#     stoppable via `--stop`.
set -euo pipefail

UNIT="spotify-skill-launch"

fail() { echo "ERROR: $*" >&2; exit 1; }

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
[ "$(id -u)" -ne 0 ] || fail "refusing to run as root; launch from the desktop user's session"

# Session bus for the DBus checks (standard per-user socket when the env var
# is unset).
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
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
    cand=$(printf '%s\n' "$line" | grep -oE -- '-auth[ =]\S+' | head -n1 | sed -E 's/^-auth[ =]//')
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
  d=$(printf '%s\n' "$line" | grep -oE ':[0-9]+' | head -n1 | tr -d ':')
  [ -n "$d" ] && DISPLAY_VAL=":$d"
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
  if dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply \
    /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null | grep -q spotify; then
    echo "Spotify: already running (DBus registered)"
  else
    echo "Spotify: not running"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
# Already running?
if dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply \
  /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null | grep -q spotify; then
  echo "Spotify is already running (DBus registered)"
  exit 0
fi

# Hand Spotify to the user's systemd manager: it runs independently of this
# process tree, is visible via `systemctl --user status $UNIT`, and stops
# cleanly with `scripts/launch_spotify.sh --stop`.
if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -S "$XDG_RUNTIME_DIR/systemd/private" ]; then
  fail "systemd --user manager not reachable; launch from within your desktop session"
fi
if ! command -v systemd-run >/dev/null 2>&1; then
  fail "systemd-run not found"
fi

systemctl --user stop "$UNIT" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" 2>/dev/null || true
systemd-run --user --unit="$UNIT" --collect \
  --setenv="DISPLAY=$DISPLAY" --setenv="XAUTHORITY=$XAUTHORITY" \
  spotify || fail "failed to start Spotify via systemd --user"

# Wait for DBus registration (Spotify needs ~5-8 seconds)
for i in $(seq 1 15); do
  sleep 1
  if dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply \
    /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null | grep -q spotify; then
    echo "Spotify ready (took ${i}s)"
    exit 0
  fi
done

echo "WARNING: Spotify process running but DBus not registered after 15s" >&2
exit 1
