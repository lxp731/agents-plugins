#!/bin/bash
# ********************************************************************
# * dsh-service-control — process-outside control core
# * Single source of truth shared by: plugin host (lib/index.js),
# * standalone CLI (bin/dshctl.js), and the detached restart process.
# *
# * Usage: control.sh [--profile <name>] start|stop|restart|status|open|enable|disable|watchdog|probe|info|doctor|logs|config|diagnostics
# * Default profile: web
# ********************************************************************

PROFILE="web"
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile|-p) PROFILE="$2"; shift 2 ;;
    start|stop|restart|status|open|enable|disable|watchdog|probe|info|doctor|logs|config|diagnostics) CMD="$1"; shift; EXTRA_ARGS=("$@"); break ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

CMD="${CMD:-status}"

# 环境变量可覆盖（便于测试）
DSH_BIN="${DSH_BIN:-dsh}"
OPEN_CMD="${DSH_OPEN_CMD:-xdg-open}"

# 可持久化的配置键（dshctl config 可读写；仅白名单键会被 source/写入）
is_known_config_key() {
  case "$1" in
    DSH_WATCHDOG_INTERVAL|DSH_WATCHDOG_FAIL_LIMIT|DSH_WATCHDOG_PROBE_TIMEOUT|DSH_WATCHDOG_COOLDOWN|DSH_OPEN_CMD|DSH_BIN|DSH_LOG|DSH_LOG_DIR) return 0 ;;
    *) return 1 ;;
  esac
}

# 取键的当前有效值（env 优先，否则默认值）
config_value() {
  local k="$1" def="$2"
  local v; v="${!k:-}"
  [[ -n "$v" ]] && { echo "$v"; return; }
  echo "$def"
}

# 默认值查找
default_of() {
  case "$1" in
    DSH_WATCHDOG_INTERVAL) echo 3 ;;
    DSH_WATCHDOG_FAIL_LIMIT) echo 3 ;;
    DSH_WATCHDOG_PROBE_TIMEOUT) echo 3 ;;
    DSH_WATCHDOG_COOLDOWN) echo 15 ;;
    DSH_OPEN_CMD) echo xdg-open ;;
    DSH_BIN) echo dsh ;;
    DSH_LOG) echo "${LOG_DIR}/$(date +%Y%m%d)-dsh-${PROFILE}.log" ;;
    DSH_LOG_DIR) echo "" ;;
    *) echo "" ;;
  esac
}

# 输出已显式配置（非默认）的键为 unit 的 Environment 行，enable 时固化进 systemd
config_environment_lines() {
  local keys=(DSH_WATCHDOG_INTERVAL DSH_WATCHDOG_FAIL_LIMIT DSH_WATCHDOG_PROBE_TIMEOUT DSH_WATCHDOG_COOLDOWN DSH_OPEN_CMD DSH_LOG_DIR)
  local k cur def
  for k in "${keys[@]}"; do
    def="$(default_of "$k")"
    cur="$(config_value "$k" "$def")"
    [[ "$cur" != "$def" ]] && echo "Environment=\"${k}=${cur}\""
  done
}

# 每-profile 配置文件（dshctl config set 写入；启动时 source，已知键才会生效）
CONF_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-service-control/${PROFILE}.conf"
if [[ -f "$CONF_FILE" ]]; then
  while IFS='=' read -r _ck _cv; do
    [[ -n "$_ck" && "$_ck" != \#* ]] && is_known_config_key "$_ck" && [[ -z "${!_ck:-}" ]] && export "$_ck=$_cv"
  done < "$CONF_FILE"
fi

# ── 日志目录：默认 $HOME/.dsh/logs/dsh（DSH_HOME 下、用户可写），DSH_LOG_DIR 可覆盖 ──
resolve_log_dir() {
  if [[ -n "${DSH_LOG_DIR:-}" ]]; then
    mkdir -p "$DSH_LOG_DIR" 2>/dev/null || true
    echo "$DSH_LOG_DIR"
    return
  fi
  local dir="${DSH_HOME:-$HOME/.dsh}/logs/dsh"
  mkdir -p "$dir" 2>/dev/null || true
  echo "$dir"
}
LOG_DIR="$(resolve_log_dir)"
# DSH_LOG 全路径覆盖；否则按日：LOG_DIR/YYYYMMDD-dsh-<profile>.log
LOG_FILE="${DSH_LOG:-${LOG_DIR}/$(date +%Y%m%d)-dsh-${PROFILE}.log}"

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

# 向 LOG_FILE 追加一条带时间戳的生命周期日志（raw 模式的标准服务日志）
log_event() {
  local msg="$1"
  {
    echo "[$(date '+%F %T')] dsh-service-control: $msg"
  } >> "$LOG_FILE" 2>/dev/null || true
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
    log_event "start requested (systemd unit $unit, state=$state)"
    if ! systemctl --user start "$unit" >/dev/null 2>&1; then
      log_event "start FAILED — systemctl --user start $unit failed"
      echo "{\"ok\":false,\"error\":\"systemctl --user start $unit failed — see: systemctl --user status $unit\"}"
      return 1
    fi
    for _ in $(seq 1 30); do
      local port; port="$(detect_port || true)"
      if [[ -n "$port" ]]; then
        log_event "started OK (systemd) — pid=$(current_pid) port=$port url=http://127.0.0.1:$port"
        echo "{\"ok\":true,\"already\":$already,\"pid\":$(current_pid),\"port\":$port,\"url\":\"http://127.0.0.1:$port\",\"opened\":$(open_and_report),\"unit\":\"$unit\"}"
        return 0
      fi
      sleep 1
    done
    log_event "start FAILED — timeout: dsh not ready in 30s (systemd $unit)"
    echo "{\"ok\":false,\"error\":\"timeout: dsh not ready in 30s\",\"unit\":\"$unit\"}"
    return 1
  fi
  # ── 未注册 systemd 的原始路径 ──
  local pid; pid="$(running_pid)"
  if [[ -n "$pid" ]]; then
    log_event "start requested but already running (pid $pid)"
    local port; port="$(detect_port || true)"
    if [[ -n "$port" ]]; then
      echo "{\"ok\":true,\"already\":true,\"pid\":$pid,\"port\":$port,\"url\":\"http://127.0.0.1:$port\",\"opened\":$(open_and_report)}"
    else
      echo "{\"ok\":true,\"already\":true,\"pid\":$pid,\"opened\":false}"
    fi
    return 0
  fi
  log_event "start requested (raw mode, no systemd) — $DSH_BIN --profile $PROFILE"
  nohup "$DSH_BIN" --profile "$PROFILE" --no-open >>"$LOG_FILE" 2>&1 &
  local pid=$!
  log_event "launched pid=$pid, waiting for port"
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    local port
    if port=$(detect_port) && [[ -n "$port" ]]; then
      log_event "started OK — pid=$pid port=$port url=http://127.0.0.1:$port"
      echo "{\"ok\":true,\"already\":false,\"pid\":$pid,\"port\":$port,\"url\":\"http://127.0.0.1:$port\",\"opened\":$(open_and_report)}"
      return 0
    fi
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    log_event "start FAILED — timeout: dsh not ready in 30s"
    echo "{\"ok\":false,\"error\":\"timeout: dsh not ready in 30s\",\"log\":\"$LOG_FILE\"}"
    return 1
  fi
  log_event "start FAILED — process exited during startup"
  echo "{\"ok\":false,\"error\":\"process exited during startup\",\"log\":\"$LOG_FILE\"}"
  return 1
}

stop() {
  if systemd_unit_exists; then
    local unit; unit="$(unit_name)"
    log_event "stop requested (systemd unit $unit)"
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
      log_event "stop FAILED — $unit still active"
      echo "{\"ok\":false,\"error\":\"failed to stop $unit (still active)\",\"unit\":\"$unit\"}"
      return 1
    fi
    log_event "stopped (systemd)"
    echo "{\"ok\":true,\"running\":false}"
    return 0
  fi
  # ── 原始路径 ──
  if ! is_running; then
    echo "{\"ok\":true,\"already\":true,\"running\":false}"
    return 0
  fi
  log_event "stop requested"
  # 优雅停止：SIGINT（dsh 应处理），随后 SIGTERM 兜底
  pkill -INT -f "$PGREP_PAT" 2>/dev/null
  for _ in $(seq 1 20); do
    is_running || { log_event "stopped"; echo "{\"ok\":true,\"running\":false}"; return 0; }
    sleep 0.5
  done
  pkill -TERM -f "$PGREP_PAT" 2>/dev/null
  sleep 1
  if is_running; then
    log_event "stop FAILED — process did not stop after SIGTERM"
    echo "{\"ok\":false,\"error\":\"process did not stop after SIGTERM\"}"
    return 1
  fi
  log_event "stopped"
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
  local cfg_env; cfg_env="$(config_environment_lines)"
  mkdir -p "$(dirname "$file")"

  # 主 unit：Restart=always —— 只要进程以任何方式退出（崩溃/异常信号/被
  # dsh-market 之类的 SIGTERM 杀掉/OOM），systemd 都会 10s 后自动拉起。
  # 显式 `systemctl stop`（dshctl stop / dshctl disable 都会走它）绝不重启，
  # 所以用户主动停止仍生效。KillSignal=SIGTERM 让 systemctl stop 走 dsh 的
  # 优雅关闭；SuccessExitStatus=130 兜底 SIGINT 路径。StartLimitBurst 防止
  # 崩溃死循环（60s 内重启 5 次后 systemd 放弃，unit 置 failed）。
  # 注：dsh-market 的 self-restart 检测不到 systemd 用户服务（ppid 是 user
  # manager 不是 1），会自己 raw 重启；Restart=always 让 systemd 成为权威，
  # 即使 dsh-market 的替代进程起不来（实测失败），systemd 仍能拉起服务。
  cat > "$file" <<EOF
# managed by dsh-service-control (dshctl enable)
[Unit]
Description=dsh service (profile ${PROFILE})
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
Environment="PATH=${env_path}"
${cfg_env}
ExecStart="${PLUGIN_ROOT}/scripts/dsh-run.sh" --profile ${PROFILE} --bin "${bin}" --logdir "${LOG_DIR}"
Restart=always
RestartSec=2
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
${cfg_env}
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

# ── probe：打 /dsh-health 探活，报告可达性与延迟 ──
probe() {
  local pid; pid="$(current_pid)"
  if [[ -z "$pid" ]]; then
    echo "{\"ok\":false,\"healthy\":false,\"error\":\"not running\",\"profile\":\"$PROFILE\"}"
    return 1
  fi
  local port; port="$(detect_port "$pid" || true)"
  if [[ -z "$port" ]]; then
    echo "{\"ok\":false,\"healthy\":false,\"pid\":$pid,\"error\":\"port not detected\",\"profile\":\"$PROFILE\"}"
    return 1
  fi
  local t0 t1 ms
  t0="$(date +%s%3N)"
  local body; body="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/dsh-health" 2>/dev/null)"
  local rc=$?
  t1="$(date +%s%3N)"
  ms=$((t1 - t0))
  if [[ $rc -eq 0 && "$body" == *'"ok":true'* ]]; then
    echo "{\"ok\":true,\"healthy\":true,\"pid\":$pid,\"port\":$port,\"latency_ms\":$ms,\"url\":\"http://127.0.0.1:$port\",\"profile\":\"$PROFILE\"}"
    return 0
  fi
  echo "{\"ok\":false,\"healthy\":false,\"pid\":$pid,\"port\":$port,\"latency_ms\":$ms,\"error\":\"/dsh-health unhealthy\",\"profile\":\"$PROFILE\"}"
  return 1
}

# ── info：概览 ──
info() {
  local unit wdunit sysd wdsysd pid port
  unit="$(unit_name 2>/dev/null)"
  wdunit="$(watchdog_unit_name 2>/dev/null)"
  sysd="inactive"; wdsysd="inactive"
  if command -v systemctl >/dev/null 2>&1; then
    sysd="$(systemctl --user is-active "$unit" 2>/dev/null | head -1)"; [[ -z "$sysd" ]] && sysd="inactive"
    wdsysd="$(systemctl --user is-active "$wdunit" 2>/dev/null | head -1)"; [[ -z "$wdsysd" ]] && wdsysd="inactive"
  fi
  pid="$(current_pid || true)"
  port="$(detect_port "$pid" || true)"
  echo "{\"ok\":true,\"profile\":\"$PROFILE\",\"plugin\":\"$(plugin_version)\",\"root\":\"$PLUGIN_ROOT\",\"dsh_bin\":\"$(dsh_bin_path || echo '')\",\"pid\":${pid:-null},\"port\":${port:-null},\"url\":\"http://127.0.0.1:${port:-0}\",\"log\":\"$LOG_FILE\",\"systemd\":\"$sysd\",\"unit\":\"$unit\",\"watchdog\":\"$wdsysd\",\"watchdog_unit\":\"$wdunit\"}"
}

plugin_version() {
  node -e "try{console.log(require('$PLUGIN_ROOT/package.json').version)}catch{console.log('?')}" 2>/dev/null || echo '?'
}

# ── doctor：一键自检（人读文本输出）──
doctor() {
  pass=0; fail=0
  ok() { echo "  ✓ $*"; pass=$((pass+1)); }
  bad() { echo "  ✗ $*"; fail=$((fail+1)); }
  warn() { echo "  ⚠ $*"; }
  echo "dsh-service-control doctor (profile $PROFILE)"
  echo "--------------------------------------------"
  # 1. systemd
  if command -v systemctl >/dev/null 2>&1; then
    ok "systemctl available"
    systemctl --user is-system-running >/dev/null 2>&1 && ok "systemd user manager running" || warn "systemd user manager not fully running (headless: loginctl enable-linger)"
  else
    bad "systemctl missing — cannot enable/self-heal"
  fi
  # 2. unit
  local unit wdunit; unit="$(unit_name)"; wdunit="$(watchdog_unit_name)"
  if [[ -f "$(unit_file_path)" ]]; then
    ok "unit $unit present"
    local st; st="$(systemctl --user is-enabled "$unit" 2>/dev/null)"; [[ "$st" == "enabled" ]] && ok "unit enabled (autostart)" || warn "unit not enabled ($st)"
  else
    warn "unit $unit not present — run 'dshctl enable'"
  fi
  # 3. process / port / health
  local pid port
  pid="$(current_pid || true)"
  port="$(detect_port "$pid" || true)"
  if [[ -n "$pid" ]]; then
    ok "process running (pid $pid)"
    if [[ -n "$port" ]]; then
      ok "listening on $port"
      if curl -fsS --max-time 3 "http://127.0.0.1:$port/dsh-health" >/dev/null 2>&1; then
        ok "/dsh-health responds"
      else
        bad "/dsh-health unresponsive (possible hang)"
      fi
    else
      warn "port not detected"
    fi
  else
    warn "process not running"
  fi
  # 4. PATH/node（systemd 环境 127 问题）
  if command -v node >/dev/null 2>&1; then
    ok "node in PATH ($(command -v node))"
  else
    bad "node not in PATH — systemd unit may exit 127"
  fi
  # 5. 野进程
  local np; np="$(pgrep -f "$PGREP_PAT" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$np" -gt "$([[ -n "$pid" ]] && echo 1 || echo 0)" ]]; then
    warn "multiple dsh processes detected ($np)"
  else
    ok "no stray processes"
  fi
  # 6. 看门狗
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active "$wdunit" >/dev/null 2>&1; then
    ok "watchdog $wdunit running"
  elif [[ -f "$(watchdog_unit_file_path)" ]]; then
    warn "watchdog unit present but not active"
  fi
  # 7. journal 错误
  if command -v journalctl >/dev/null 2>&1; then
    local errs; errs="$(journalctl --user -u "$unit" -n 200 --no-pager 2>/dev/null | grep -cE 'error|Error|ERR|fatal|FATAL' || true)"
    [[ "$errs" -gt 0 ]] && warn "$errs error lines in recent journal (unit $unit)" || ok "no recent errors in journal"
  fi
  echo "--------------------------------------------"
  echo "result: $pass ok, $fail failed"
  [[ "$fail" -eq 0 ]]
}

# ── logs：查看/跟随日志，用户自选源 ──
#   dshctl logs dsh [-f]           dsh 日志文件（$LOG_FILE，含 dsh console + 生命周期事件）
#   dshctl logs journal [-f]       systemd journal（journalctl -u dsh-<profile>）
#   dshctl logs [-f]               （默认 dsh）
logs() {
  local src="dsh" follow=false
  local a0="${EXTRA_ARGS[0]:-}" a1="${EXTRA_ARGS[1]:-}"
  if [[ "$a0" == "dsh" || "$a0" == "journal" ]]; then
    src="$a0"
    [[ "$a1" == "-f" || "$a1" == "--follow" ]] && follow=true
  elif [[ "$a0" == "-f" || "$a0" == "--follow" ]]; then
    follow=true
  elif [[ -n "$a0" ]]; then
    echo "logs: unknown source '$a0' — use 'dsh' or 'journal'" >&2
    return 1
  fi
  if [[ "$src" == "journal" ]]; then
    if ! command -v journalctl >/dev/null 2>&1; then
      echo "logs: journalctl not available" >&2
      return 1
    fi
    local unit; unit="$(unit_name)"
    if $follow; then
      journalctl --user -u "$unit" -f
    else
      journalctl --user -u "$unit" -n 50 --no-pager
    fi
    return 0
  fi
  # dsh 日志文件
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "no log file yet: $LOG_FILE"
    return 0
  fi
  if $follow; then
    tail -f "$LOG_FILE"
  else
    tail -n 50 "$LOG_FILE"
  fi
}

# ── config：查看/设置持久化配置 ──
config() {
  local sub="${EXTRA_ARGS[0]:-}"
  case "$sub" in
    ""|list|get) config_show "${EXTRA_ARGS[1]:-}" ;;
    set) config_set "${EXTRA_ARGS[1]:-}" "${EXTRA_ARGS[2]:-}" ;;
    *) echo "{\"ok\":false,\"error\":\"unknown config subcommand: $sub\"}"; return 1 ;;
  esac
}

config_show() {
  local key="$1"
  if [[ -n "$key" ]]; then
    if ! is_known_config_key "$key"; then echo "{\"ok\":false,\"error\":\"unknown key: $key\"}"; return 1; fi
    echo "{\"ok\":true,\"key\":\"$key\",\"value\":\"$(config_value "$key" "$(default_of "$key")")\"}"
    return 0
  fi
  local keys=(DSH_WATCHDOG_INTERVAL DSH_WATCHDOG_FAIL_LIMIT DSH_WATCHDOG_PROBE_TIMEOUT DSH_WATCHDOG_COOLDOWN DSH_OPEN_CMD DSH_BIN DSH_LOG)
  local out="" k v
  for k in "${keys[@]}"; do
    v="$(config_value "$k" "$(default_of "$k")")"
    out+="\"$k\":\"$v\","
  done
  out="${out%,}"
  echo "{\"ok\":true,\"profile\":\"$PROFILE\",\"file\":\"$CONF_FILE\",\"config\":{$out}}"
}

config_set() {
  local key="$1" val="$2"
  if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || ! is_known_config_key "$key" || [[ -z "$val" ]]; then
    echo "{\"ok\":false,\"error\":\"invalid key or value: $key=$val\"}"
    return 1
  fi
  mkdir -p "$(dirname "$CONF_FILE")"
  touch "$CONF_FILE"
  local tmp; tmp="$(mktemp)"
  grep -v "^${key}=" "$CONF_FILE" > "$tmp" 2>/dev/null || true
  echo "${key}=${val}" >> "$tmp"
  mv "$tmp" "$CONF_FILE"
  echo "{\"ok\":true,\"key\":\"$key\",\"value\":\"$val\",\"file\":\"$CONF_FILE\"}"
}

# ── diagnostics：导出诊断包 ──
diagnostics() {
  local base; base="$(mktemp -d)/dshctl-diag-${PROFILE}"
  mkdir -p "$base"
  {
    echo "dsh-service-control diagnostics (profile $PROFILE)"
    echo "generated: $(date -Is 2>/dev/null || date)"
    echo "plugin: $(plugin_version)"
    echo "root: $PLUGIN_ROOT"
    echo
    echo "===== status ===="
    status
    echo
    echo "===== probe ===="
    probe || true
    echo
    echo "===== config ===="
    config_show || true
  } > "$base/report.txt" 2>&1
  [[ -f "$(unit_file_path)" ]] && cp "$(unit_file_path)" "$base/$(basename "$(unit_file_path)")" 2>/dev/null
  [[ -f "$(watchdog_unit_file_path)" ]] && cp "$(watchdog_unit_file_path)" "$base/$(basename "$(watchdog_unit_file_path)")" 2>/dev/null
  command -v journalctl >/dev/null 2>&1 && journalctl --user -u "$(unit_name)" -n 100 --no-pager > "$base/journal.txt" 2>/dev/null
  local out outname
  outname="dshctl-diagnostics-${PROFILE}-$(date +%Y%m%d-%H%M%S)"
  if command -v tar >/dev/null 2>&1; then
    out="${HOME}/${outname}.tar.gz"
    tar -czf "$out" -C "$(dirname "$base")" "$(basename "$base")" 2>/dev/null
    echo "{\"ok\":true,\"bundle\":\"$out\"}"
  else
    echo "{\"ok\":true,\"dir\":\"$base\"}"
  fi
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
  probe)    probe ;;
  info)     info ;;
  doctor)   doctor ;;
  logs)     logs ;;
  config)   config ;;
  diagnostics) diagnostics ;;
esac
