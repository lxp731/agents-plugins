#!/bin/bash
# ********************************************************************
# * dsh-service-control — process-outside control core
# * Single source of truth shared by: plugin host (lib/index.js),
# * standalone CLI (bin/dshctl.js), and the detached restart process.
# *
# * Usage: control.sh [--profile <name>] start|stop|restart|status|open|enable|disable|watchdog
# * Default profile: web
# ********************************************************************

PROFILE="web"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile|-p) PROFILE="$2"; shift 2 ;;
    start|stop|restart|status|open|enable|disable|watchdog) CMD="$1"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

CMD="${CMD:-status}"

# 环境变量可覆盖（便于测试）
DSH_BIN="${DSH_BIN:-dsh}"
LOG_FILE="${DSH_LOG:-/tmp/dsh-${PROFILE}.log}"
OPEN_CMD="${DSH_OPEN_CMD:-xdg-open}"

# 插件根目录（watchdog unit 的 ExecStart 需要绝对路径）
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 匹配该 profile 的 dsh 进程；[d] 技巧避免 pgrep 匹配到自身
PGREP_PAT="[d]sh --profile ${PROFILE}"

running_pid() {
  # 注意：pgrep | head 的管道退出码恒为 head 的（0），不能用 if running_pid 判断；
  # 这里用空输出判定并显式返回正确退出码。
  local p; p="$(pgrep -f "$PGREP_PAT" 2>/dev/null | head -1)"
  if [[ -n "$p" ]]; then
    echo "$p"
    return 0
  fi
  return 1
}

# 当前 dsh 进程 pid：systemd 托管时用 unit 的 MainPID（其 cmdline 可能是
# `node .../lib/bin.js`，pgrep 匹配不到），否则回退 pgrep。
# 注意：systemd MainPID 不可用（unit inactive/failed）时，可能仍有 systemd
# 之外的进程在跑（enable 之前用 dshctl start / 手动 dsh 启动）——必须回退
# pgrep，否则 stop/status 会漏掉这些野进程（表现为“停不掉”）。
current_pid() {
  if systemd_unit_exists; then
    local pid; pid="$(systemd_main_pid)"
    if [[ -n "$pid" && "$pid" != "0" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
    local raw; raw="$(running_pid)"
    if [[ -n "$raw" ]]; then
      echo "$raw"
      return 0
    fi
    return 1
  fi
  running_pid
}

is_running() {
  [[ -n "$(current_pid)" ]]
}

# 通过进程 pid 找监听端口（比硬编码端口通用）
detect_port() {
  local pid="${1:-}"
  [[ -z "$pid" ]] && pid="$(current_pid || true)"
  [[ -n "$pid" ]] || return 1
  local port
  port=$(ss -tlnp 2>/dev/null | awk -v p="$pid" '$6 ~ "pid=" p "," { split($4, a, ":"); print a[length(a)]; exit }')
  [[ -n "$port" ]] && { echo "$port"; return 0; }
  # fallback: lsof（ss 无权限显示 pid 时）
  port=$(lsof -Pan -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 { split($9, a, ":"); print a[length(a)]; exit }')
  [[ -n "$port" ]] && { echo "$port"; return 0; }
  return 1
}

start() {
  # systemd 路径：已 enable（unit 文件存在）时走 systemctl，保证生命周期一致
  if systemd_unit_exists; then
    local unit; unit="$(unit_name)"
    local state; state="$(systemctl --user is-active "$unit" 2>/dev/null | head -1)"
    # 若 unit 非 active 但已有进程在跑（enable 前的 raw 进程），不要重复
    # systemctl start（会抢端口 / 双实例），提示先 stop 再 start 迁入托管。
    if [[ "$state" != "active" ]]; then
      local raw; raw="$(running_pid)"
      if [[ -n "$raw" ]]; then
        local rport; rport="$(detect_port "$raw" || true)"
        local rj="null"; [[ -n "$rport" ]] && rj="$rport"
        echo "{\"ok\":true,\"already\":true,\"pid\":$raw,\"port\":$rj,\"url\":\"http://127.0.0.1:$rport\",\"opened\":$(open_and_report),\"unit\":\"$unit\",\"note\":\"running outside systemd — stop it (dshctl stop) then start again to adopt under systemd\"}"
        return 0
      fi
    fi
    local already=false
    [[ "$state" == "active" ]] && already=true
    if ! systemctl --user start "$unit" >/dev/null 2>&1; then
      echo "{\"ok\":false,\"error\":\"systemctl --user start $unit failed — see: systemctl --user status $unit\"}"
      return 1
    fi
    for _ in $(seq 1 30); do
      local port; port="$(detect_port || true)"
      if [[ -n "$port" ]]; then
        echo "{\"ok\":true,\"already\":$already,\"pid\":$(current_pid),\"port\":$port,\"url\":\"http://127.0.0.1:$port\",\"opened\":$(open_and_report),\"unit\":\"$unit\"}"
        return 0
      fi
      sleep 1
    done
    echo "{\"ok\":false,\"error\":\"timeout: dsh not ready in 30s\",\"unit\":\"$unit\"}"
    return 1
  fi
  # ── 未注册 systemd 的原始路径 ──
  local pid; pid="$(running_pid)"
  if [[ -n "$pid" ]]; then
    local port; port="$(detect_port || true)"
    if [[ -n "$port" ]]; then
      echo "{\"ok\":true,\"already\":true,\"pid\":$pid,\"port\":$port,\"url\":\"http://127.0.0.1:$port\",\"opened\":$(open_and_report)}"
    else
      echo "{\"ok\":true,\"already\":true,\"pid\":$pid,\"opened\":false}"
    fi
    return 0
  fi
  nohup "$DSH_BIN" --profile "$PROFILE" --no-open >"$LOG_FILE" 2>&1 &
  local pid=$!
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    local port
    if port=$(detect_port) && [[ -n "$port" ]]; then
      echo "{\"ok\":true,\"already\":false,\"pid\":$pid,\"port\":$port,\"url\":\"http://127.0.0.1:$port\",\"opened\":$(open_and_report)}"
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
  if systemd_unit_exists; then
    local unit; unit="$(unit_name)"
    # systemctl stop 是显式停止：即使 unit 配了 Restart=on-failure 也绝不重启
    systemctl --user stop "$unit" >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do
      systemctl --user is-active "$unit" >/dev/null 2>&1 || break
      sleep 0.5
    done
    # 兜底清 systemd 之外的 raw 进程（enable 前用 dshctl start / 手动 dsh
    # 启动，systemctl stop 不碰它们）：优雅 SIGINT → 轮询 → SIGTERM 兜底。
    # 全部用命令替换取值，避免 pid 泄漏到 stdout 弄坏 JSON。
    local rp
    rp="$(running_pid)"
    if [[ -n "$rp" ]]; then
      pkill -INT -f "$PGREP_PAT" 2>/dev/null
      for _ in $(seq 1 20); do
        rp="$(running_pid)"
        [[ -n "$rp" ]] || break
        sleep 0.5
      done
      if [[ -n "$rp" ]]; then
        pkill -TERM -f "$PGREP_PAT" 2>/dev/null
        sleep 1
      fi
    fi
    rp="$(running_pid)"
    if systemctl --user is-active "$unit" >/dev/null 2>&1 || [[ -n "$rp" ]]; then
      echo "{\"ok\":false,\"error\":\"failed to stop $unit (still active)\",\"unit\":\"$unit\"}"
      return 1
    fi
    echo "{\"ok\":true,\"running\":false}"
    return 0
  fi
  # ── 原始路径 ──
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
  if systemd_unit_exists; then
    local unit; unit="$(unit_name)"
    if ! systemctl --user restart "$unit" >/dev/null 2>&1; then
      echo "{\"ok\":false,\"error\":\"systemctl --user restart $unit failed — see: systemctl --user status $unit\"}"
      return 1
    fi
    for _ in $(seq 1 30); do
      local port; port="$(detect_port || true)"
      if [[ -n "$port" ]]; then
        echo "{\"ok\":true,\"already\":false,\"pid\":$(current_pid),\"port\":$port,\"url\":\"http://127.0.0.1:$port\",\"opened\":$(open_and_report),\"unit\":\"$unit\"}"
        return 0
      fi
      sleep 1
    done
    echo "{\"ok\":false,\"error\":\"timeout: dsh not ready after restart in 30s\",\"unit\":\"$unit\"}"
    return 1
  fi
  stop >/dev/null 2>&1 || true
  start
}

status() {
  if systemd_unit_exists; then
    local unit; unit="$(unit_name)"
    local state; state="$(systemctl --user is-active "$unit" 2>/dev/null | head -1)"
    [[ -z "$state" ]] && state="inactive"
    local pid; pid="$(current_pid)"
    if [[ -n "$pid" ]]; then
      local port; port="$(detect_port || true)"
      local extra=""; [[ "$state" != "active" ]] && extra="running outside systemd"
      if [[ -n "$port" ]]; then
        local nj=""; [[ -n "$extra" ]] && nj=",\"note\":\"$extra\""
        echo "{\"running\":true,\"pid\":$pid,\"port\":$port,\"url\":\"http://127.0.0.1:$port\",\"profile\":\"$PROFILE\",\"unit\":\"$unit\",\"systemd\":\"$state\"$nj}"
      else
        local note="port not detected"
        [[ -n "$extra" ]] && note="$extra (port not detected)"
        echo "{\"running\":true,\"pid\":$pid,\"port\":null,\"url\":null,\"profile\":\"$PROFILE\",\"unit\":\"$unit\",\"systemd\":\"$state\",\"note\":\"$note\"}"
      fi
    else
      echo "{\"running\":false,\"pid\":null,\"port\":null,\"url\":null,\"profile\":\"$PROFILE\",\"unit\":\"$unit\",\"systemd\":\"$state\"}"
    fi
    return 0
  fi
  # ── 原始路径 ──
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

# 打开浏览器并输出 true/false（best-effort，失败不致命）
open_and_report() {
  local out
  if out="$(open_browser 2>/dev/null)" && [[ "$out" == *'"ok":true'* ]]; then
    echo true
  else
    echo false
  fi
}

# ── systemd user units（dshctl enable / disable）──

# profile 合法化后的单元名片段（unit 名只允许 [a-zA-Z0-9_.-]）
profile_slug() {
  printf '%s' "$PROFILE" | LC_ALL=C tr -c 'a-zA-Z0-9_.-' '-'
}

# 主服务 unit：dsh-<profile>.service
unit_name() {
  printf 'dsh-%s.service' "$(profile_slug)"
}

unit_file_path() {
  printf '%s/%s' "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user" "$(unit_name)"
}

# 看门狗 unit：dsh-<profile>-watchdog.service
watchdog_unit_name() {
  printf 'dsh-%s-watchdog.service' "$(profile_slug)"
}

watchdog_unit_file_path() {
  printf '%s/%s' "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user" "$(watchdog_unit_name)"
}

# 是否已通过 dshctl enable 注册为 systemd 用户服务（unit 文件存在）
systemd_unit_exists() {
  command -v systemctl >/dev/null 2>&1 && [[ -f "$(unit_file_path)" ]]
}

systemd_main_pid() {
  systemctl --user show -p MainPID --value "$(unit_name)" 2>/dev/null
}

# 解析 dsh 可执行文件绝对路径（systemd ExecStart 必须是绝对路径）
dsh_bin_path() {
  local bin="${DSH_BIN:-dsh}"
  if [[ "$bin" == */* ]]; then
    [[ -x "$bin" ]] && { echo "$bin"; return 0; }
    return 1
  fi
  command -v "$bin" 2>/dev/null && return 0
  return 1
}

enable_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo '{"ok":false,"error":"systemctl not found — systemd user services unavailable"}'
    return 1
  fi
  local bin; bin="$(dsh_bin_path)"
  if [[ -z "$bin" ]]; then
    echo "{\"ok\":false,\"error\":\"dsh binary not found (DSH_BIN=${DSH_BIN:-dsh} not resolvable in PATH); cannot write unit files\"}"
    return 1
  fi
  local unit; unit="$(unit_name)"
  local watchdog_unit; watchdog_unit="$(watchdog_unit_name)"
  local file; file="$(unit_file_path)"
  local watchdog_file; watchdog_file="$(watchdog_unit_file_path)"
  # systemd user manager 的 PATH 不含 shell 的 PATH（如 nvm 的 node），
  # 必须把当前 PATH 固化进 unit，否则 `#!/usr/bin/env node` 会 127 退出
  local env_path="${PATH:-/usr/local/bin:/usr/bin:/bin}"
  mkdir -p "$(dirname "$file")"

  # 主 unit：Restart=on-failure —— 正常退出（exit 0 / SIGTERM/SIGINT）不重启；
  # 异常退出（非零退出码/崩溃信号/OOM）10s 后自动拉起。KillSignal=SIGTERM：
  # dsh 对 SIGTERM 以退出码 0 优雅关闭（systemctl stop 后 unit 为 inactive
  # 而非 failed）；SuccessExitStatus=130 兜底 SIGINT 路径（128+2，视为干净）。
  cat > "$file" <<EOF
# managed by dsh-service-control (dshctl enable)
[Unit]
Description=dsh service (profile ${PROFILE})
After=network.target

[Service]
Type=simple
Environment="PATH=${env_path}"
ExecStart="${bin}" --profile ${PROFILE} --no-open
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
SuccessExitStatus=130
TimeoutStopSec=15

[Install]
WantedBy=default.target
EOF

  # 看门狗 unit：进程外探测 /dsh-health，仅当 unit active 但 HTTP 无响应
  # （卡死）时重启主服务；正常 stop 后 unit 为 inactive，绝不会被误重启。
  cat > "$watchdog_file" <<EOF
# managed by dsh-service-control (dshctl enable)
[Unit]
Description=dsh watchdog (profile ${PROFILE})
After=${unit}

[Service]
Type=simple
Environment="PATH=${env_path}"
ExecStart="${PLUGIN_ROOT}/scripts/control.sh" --profile ${PROFILE} watchdog
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

  if ! systemctl --user daemon-reload >/dev/null 2>&1; then
    echo "{\"ok\":false,\"error\":\"systemctl --user daemon-reload failed — is the systemd user manager running? (headless: loginctl enable-linger)\",\"file\":\"$file\"}"
    return 1
  fi
  if ! systemctl --user enable "$unit" "$watchdog_unit" >/dev/null 2>&1; then
    echo "{\"ok\":false,\"error\":\"systemctl --user enable failed — see: systemctl --user status $unit\",\"file\":\"$file\"}"
    return 1
  fi
  local note=""
  # 提示：存在 systemd 之外运行的 dsh（MainPID 为 0）时需要迁入托管
  local main_pid; main_pid="$(systemctl --user show -p MainPID --value "$unit" 2>/dev/null)"
  if [[ -n "$(running_pid)" && ( -z "$main_pid" || "$main_pid" == "0" ) ]]; then
    note="dsh is currently running outside systemd — stop it (dshctl stop) then start again (dshctl start) to move it under systemd"
  fi
  if [[ -n "$note" ]]; then
    echo "{\"ok\":true,\"enabled\":true,\"unit\":\"$unit\",\"watchdog\":\"$watchdog_unit\",\"file\":\"$file\",\"note\":\"$note\"}"
  else
    echo "{\"ok\":true,\"enabled\":true,\"unit\":\"$unit\",\"watchdog\":\"$watchdog_unit\",\"file\":\"$file\"}"
  fi
}

disable_service() {
  local unit; unit="$(unit_name)"
  local watchdog_unit; watchdog_unit="$(watchdog_unit_name)"
  local file; file="$(unit_file_path)"
  local watchdog_file; watchdog_file="$(watchdog_unit_file_path)"
  local was_enabled=false
  local note=""
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user is-enabled "$unit" >/dev/null 2>&1 && was_enabled=true
    # 先停掉 watchdog，避免它在禁用过程中去重启主服务
    systemctl --user stop "$watchdog_unit" >/dev/null 2>&1 || true
    systemctl --user disable "$unit" "$watchdog_unit" >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  else
    note="systemctl not found — removed unit files only"
  fi
  for f in "$file" "$watchdog_file"; do
    if [[ -f "$f" ]]; then
      was_enabled=true
      rm -f "$f"
    fi
  done
  if [[ -n "$note" ]]; then
    echo "{\"ok\":true,\"disabled\":$was_enabled,\"unit\":\"$unit\",\"watchdog\":\"$watchdog_unit\",\"note\":\"$note\"}"
  else
    echo "{\"ok\":true,\"disabled\":$was_enabled,\"unit\":\"$unit\",\"watchdog\":\"$watchdog_unit\"}"
  fi
}

# ── 看门狗（systemd 独立 unit 运行，进程外）──
# 崩溃重启由主 unit 的 Restart=on-failure 负责；这里只管"卡死"：
# systemd 认为 active 但 /dsh-health 连续无响应 → systemctl restart。
watchdog_loop() {
  local unit; unit="$(unit_name)"
  local interval="${DSH_WATCHDOG_INTERVAL:-3}"
  local fail_limit="${DSH_WATCHDOG_FAIL_LIMIT:-3}"
  local probe_timeout="${DSH_WATCHDOG_PROBE_TIMEOUT:-3}"
  local cooldown="${DSH_WATCHDOG_COOLDOWN:-15}"
  watchdog_log() { echo "[dsh-service-control] watchdog($PROFILE): $*"; }
  if ! command -v curl >/dev/null 2>&1; then
    watchdog_log "curl not found — cannot probe /dsh-health; exiting"
    exit 1
  fi
  local fails=0
  watchdog_log "started (unit=$unit interval=${interval}s fail-limit=$fail_limit)"
  while true; do
    if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active "$unit" >/dev/null 2>&1; then
      local port; port="$(detect_port || true)"
      if [[ -n "$port" ]] && curl -fsS --max-time "$probe_timeout" "http://127.0.0.1:$port/dsh-health" >/dev/null 2>&1; then
        fails=0
      else
        fails=$((fails + 1))
        watchdog_log "probe failed ($fails/$fail_limit): port=${port:-?} unhealthy"
        if (( fails >= fail_limit )); then
          local est; est="$(awk -v a="$fail_limit" -v i="$interval" -v t="$probe_timeout" 'BEGIN{printf "%d", a*(i+t)}')"
          watchdog_log "unresponsive ~${est}s — restarting $unit"
          systemctl --user restart "$unit" >/dev/null 2>&1 || watchdog_log "restart command failed"
          fails=0
          sleep "$cooldown"
        fi
      fi
    else
      # systemd 自管状态（inactive/failed/activating）：崩溃重启归 Restart=on-failure，不干预
      fails=0
    fi
    sleep "$interval"
  done
}

case "$CMD" in
  start)    start ;;
  stop)     stop ;;
  restart)  restart ;;
  status)   status ;;
  open)     open_browser ;;
  enable)   enable_service ;;
  disable)  disable_service ;;
  watchdog) watchdog_loop ;;
esac
