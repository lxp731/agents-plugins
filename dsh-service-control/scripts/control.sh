#!/bin/bash
# ********************************************************************
# * dsh-service-control — process-outside control core
# * Single source of truth shared by: plugin host (lib/index.js),
# * standalone CLI (bin/dshctl.js), and the detached restart process.
# *
# * Usage: control.sh [--profile <name>] start|stop|restart|status
# * Default profile: web
# ********************************************************************

PROFILE="web"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile|-p) PROFILE="$2"; shift 2 ;;
    start|stop|restart|status|open) CMD="$1"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

CMD="${CMD:-status}"

# 环境变量可覆盖（便于测试）
DSH_BIN="${DSH_BIN:-dsh}"
LOG_FILE="${DSH_LOG:-/tmp/dsh-${PROFILE}.log}"
OPEN_CMD="${DSH_OPEN_CMD:-xdg-open}"

# 匹配该 profile 的 dsh 进程；[d] 技巧避免 pgrep 匹配到自身
PGREP_PAT="[d]sh --profile ${PROFILE}"

running_pid() {
  pgrep -f "$PGREP_PAT" 2>/dev/null | head -1
}

is_running() {
  [[ -n "$(running_pid)" ]]
}

# 通过进程 pid 找监听端口（比硬编码端口通用）
detect_port() {
  local pid; pid="$(running_pid)" || return 1
  local port
  port=$(ss -tlnp 2>/dev/null | awk -v p="$pid" '$6 ~ "pid=" p "," { split($4, a, ":"); print a[length(a)]; exit }')
  [[ -n "$port" ]] && { echo "$port"; return 0; }
  # fallback: lsof（ss 无权限显示 pid 时）
  port=$(lsof -Pan -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 { split($9, a, ":"); print a[length(a)]; exit }')
  [[ -n "$port" ]] && { echo "$port"; return 0; }
  return 1
}

start() {
  if is_running; then
    echo "{\"ok\":true,\"already\":true,\"pid\":$(running_pid)}"
    return 0
  fi
  nohup "$DSH_BIN" --profile "$PROFILE" --no-open >"$LOG_FILE" 2>&1 &
  local pid=$!
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    local port
    if port=$(detect_port) && [[ -n "$port" ]]; then
      echo "{\"ok\":true,\"already\":false,\"pid\":$pid,\"port\":$port,\"url\":\"http://127.0.0.1:$port\"}"
      return 0
    fi
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "{\"ok\":false,\"error\":\"timeout: dsh not ready in 30s\",\"log\":\"$LOG_FILE\"}"
    return 1
  fi
  echo "{\"ok\":false,\"error\":\"process exited during startup\",\"log\":\"$LOG_FILE\"}"
  return 1
}

stop() {
  if ! is_running; then
    echo "{\"ok\":true,\"already\":true,\"running\":false}"
    return 0
  fi
  # 优雅停止：SIGINT（dsh 应处理），随后 SIGTERM 兜底
  pkill -INT -f "$PGREP_PAT" 2>/dev/null
  for _ in $(seq 1 20); do
    is_running || { echo "{\"ok\":true,\"running\":false}"; return 0; }
    sleep 0.5
  done
  pkill -TERM -f "$PGREP_PAT" 2>/dev/null
  sleep 1
  if is_running; then
    echo "{\"ok\":false,\"error\":\"process did not stop after SIGTERM\"}"
    return 1
  fi
  echo "{\"ok\":true,\"running\":false}"
  return 0
}

restart() {
  stop >/dev/null 2>&1 || true
  start
}

status() {
  local pid; pid="$(running_pid)"
  if [[ -n "$pid" ]]; then
    local port; port="$(detect_port || true)"
    if [[ -n "$port" ]]; then
      echo "{\"running\":true,\"pid\":$pid,\"port\":$port,\"url\":\"http://127.0.0.1:$port\",\"profile\":\"$PROFILE\"}"
    else
      echo "{\"running\":true,\"pid\":$pid,\"port\":null,\"url\":null,\"profile\":\"$PROFILE\",\"note\":\"port not detected\"}"
    fi
  else
    echo "{\"running\":false,\"pid\":null,\"port\":null,\"url\":null,\"profile\":\"$PROFILE\"}"
  fi
}

open_browser() {
  if ! is_running; then
    echo "{\"ok\":false,\"error\":\"not running — start it first: dshctl start\"}"
    return 1
  fi
  local port; port="$(detect_port)" || {
    echo "{\"ok\":false,\"error\":\"service is running but port could not be detected\"}"
    return 1
  }
  local url="http://127.0.0.1:$port"
  if ! command -v "$OPEN_CMD" >/dev/null 2>&1; then
    echo "{\"ok\":false,\"error\":\"$OPEN_CMD not found; open $url manually\",\"url\":\"$url\"}"
    return 1
  fi
  # 后台打开，避免阻塞；浏览器启动失败不致命
  nohup "$OPEN_CMD" "$url" >/dev/null 2>&1 &
  echo "{\"ok\":true,\"url\":\"$url\"}"
}

case "$CMD" in
  start)   start ;;
  stop)    stop ;;
  restart) restart ;;
  status)  status ;;
  open)    open_browser ;;
esac
