#!/bin/bash
# ********************************************************************
# * dsh-service-control — systemd ExecStart launcher
# * Resolves the per-day log file and `exec`s dsh in the foreground so
# * systemd still tracks the real dsh process (signals/exit are correct).
# * dsh's stdout/stderr are redirected into the daily log file.
# *
# * Usage: dsh-run.sh --profile <name> --bin <dsh-path> --logdir <dir>
# ********************************************************************
PROFILE="web"
BIN="dsh"
LOGDIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile|-p) PROFILE="$2"; shift 2 ;;
    --bin) BIN="$2"; shift 2 ;;
    --logdir) LOGDIR="$2"; shift 2 ;;
    *) echo "dsh-run: unknown argument: $1" >&2; exit 64 ;;
  esac
done

# 日志目录：DSH_LOG_DIR 环境 > 传入 --logdir > 默认 ~/.dsh/logs/dsh
if [[ -z "$LOGDIR" ]]; then
  LOGDIR="${DSH_LOG_DIR:-${DSH_HOME:-$HOME/.dsh}/logs/dsh}"
fi
mkdir -p "$LOGDIR" 2>/dev/null || true

LOG_FILE="${LOGDIR}/$(date +%Y%m%d)-dsh-${PROFILE}.log"

exec "$BIN" --profile "$PROFILE" --no-open >> "$LOG_FILE" 2>&1
