#!/bin/bash
# ********************************************************************
# * dsh-service-control — process-outside control core
# * Single source of truth shared by the runner (lib/index.js) and the
# * detached watchdog process.
# *
# * Usage: control.sh [--profile <name>] start|stop|restart|status|install|reinstall|enable|disable|uninstall|watchdog|probe|doctor|logs|config
# * install/reinstall 支持 --env <KEY[=VALUE]>：显式传值，或只写 KEY 从当前环境取值
# * Default profile: web
# ********************************************************************

PROFILE="web"
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile|-p) PROFILE="$2"; shift 2 ;;
    start|stop|restart|status|install|reinstall|enable|disable|uninstall|watchdog|probe|doctor|logs|config) CMD="$1"; shift; EXTRA_ARGS=("$@"); break ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

CMD="${CMD:-status}"

# profile 只允许安全字符集：它会被拼进 pgrep 正则、JSON、conf/日志路径与 unit 名
if [[ ! "$PROFILE" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
  echo "invalid profile: $PROFILE (allowed: [a-zA-Z0-9_.-]+)" >&2
  exit 64
fi

# 环境变量可覆盖（便于测试）
DSH_BIN="${DSH_BIN:-dsh}"
# 浏览器打开命令：默认 xdg-open（Linux）；macOS 无 xdg-open 时回退到 open
if [[ -z "${DSH_OPEN_CMD:-}" ]]; then
  if command -v xdg-open >/dev/null 2>&1; then
    OPEN_CMD=xdg-open
  elif command -v open >/dev/null 2>&1; then
    OPEN_CMD=open
  else
    OPEN_CMD=xdg-open
  fi
else
  OPEN_CMD="$DSH_OPEN_CMD"
fi

# 可持久化的配置键（（dsh --profile ctl config 可读写；仅白名单键会被 source/写入））
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

# 每-profile 配置文件（（dsh --profile ctl config set 写入；启动时 source，已知键才会生效）
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

# 匹配该 profile 的 dsh 进程；[d] 技巧避免 pgrep 匹配到自身。
# profile 已校验为 [a-zA-Z0-9_.-]+，其中只有 `.` 是正则元字符，转义为 [.]
# 字面量；结尾用 ( |$) 锚定，避免 `web` 误匹配 `web-extra` 等前缀进程。
PROFILE_PAT="${PROFILE//./[.]}"
PGREP_PAT="[d]sh --profile ${PROFILE_PAT}( |\$)"

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
# 之外的进程在跑（（install 之前用 dsh --profile ctl systemd start 或手动 dsh 启动）——必须回退
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
  # systemd 托管路径：必须先 `dsh --profile ctl systemd install`
  if ! systemd_unit_exists; then
    echo '{"ok":false,"error":"not installed — run: dsh --profile ctl systemd install first"}'
    return 1
  fi
  local unit; unit="$(unit_name)"
  local state; state="$(systemctl --user is-active "$unit" 2>/dev/null | head -1)"
  # 若 unit 非 active 但已有进程在跑（install 前的野进程），不要重复
  # systemctl start（会抢端口 / 双实例），提示先 stop 再 start 迁入托管。
  if [[ "$state" != "active" ]]; then
    local raw; raw="$(running_pid)"
    if [[ -n "$raw" ]]; then
      local rport; rport="$(detect_port "$raw" || true)"
      local rj="null"; [[ -n "$rport" ]] && rj="$rport"
      echo "{\"ok\":true,\"already\":true,\"pid\":$raw,\"port\":$rj,\"url\":\"http://127.0.0.1:$rport\",\"opened\":$(open_and_report),\"unit\":\"$unit\",\"note\":\"running outside systemd — stop it (dsh --profile ctl systemd stop) then start again to adopt under systemd\"}"
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
}

stop() {
  if ! systemd_unit_exists; then
    echo '{"ok":false,"error":"not installed — run: dsh --profile ctl systemd install first"}'
    return 1
  fi
  local unit; unit="$(unit_name)"
  log_event "stop requested (systemd unit $unit)"
  # systemctl stop 是显式停止：即使 unit 配了 Restart=on-failure 也绝不重启
  systemctl --user stop "$unit" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    systemctl --user is-active "$unit" >/dev/null 2>&1 || break
    sleep 0.5
  done
  # 兜底清 systemd 之外的野进程（install 前手动 dsh 启动的）：优雅 SIGINT →
  # 轮询 → SIGTERM 兜底。全部用命令替换取值，避免 pid 泄漏到 stdout 弄坏 JSON。
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
}

restart() {
  if ! systemd_unit_exists; then
    echo '{"ok":false,"error":"not installed — run: dsh --profile ctl systemd install first"}'
    return 1
  fi
  local unit; unit="$(unit_name)"
  if ! systemctl --user restart "$unit" >/dev/null 2>&1; then
    echo "{\"ok\":false,\"error\":\"systemctl --user restart $unit failed — see: systemctl --user status $unit\"}"
    return 1
  fi
  for _ in $(seq 1 30); do
    local port; port="$(detect_port || true)"
    if [[ -n "$port" ]]; then
      # 重启就绪后不开浏览器（已定）
      echo "{\"ok\":true,\"already\":false,\"pid\":$(current_pid),\"port\":$port,\"url\":\"http://127.0.0.1:$port\",\"opened\":false,\"unit\":\"$unit\"}"
      return 0
    fi
    sleep 1
  done
  echo "{\"ok\":false,\"error\":\"timeout: dsh not ready after restart in 30s\",\"unit\":\"$unit\"}"
  return 1
}

status() {
  if ! systemd_unit_exists; then
    echo "{\"installed\":false,\"running\":false,\"pid\":null,\"port\":null,\"url\":null,\"profile\":\"$PROFILE\",\"note\":\"not installed — run: dsh --profile ctl systemd install\"}"
    return 0
  fi
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
}

open_browser() {
  if ! is_running; then
    echo "{\"ok\":false,\"error\":\"not running — start it first: dsh --profile ctl systemd start\"}"
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

# ── systemd user units（install / enable / disable / uninstall）──

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

# 是否已安装 systemd unit（unit 文件存在 = 已托管）
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

# 写两个 unit 文件并 daemon-reload（install 与 enable 共用）。
# 失败时向 stdout 输出 JSON 错误并返回 1；成功时不输出任何内容。
write_units() {
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
  # --env 用户环境变量（install 携带；enable 无 --env 时为空）。解析失败已输出 JSON 错误
  if ! parse_env_specs; then return 1; fi
  local env_lines="" spec key val line
  for spec in "${ENV_SPECS[@]}"; do
    key="${spec%%=*}"; val="${spec#*=}"
    line="$(env_line "$key" "$val")"
    env_lines+="${line}"$'\n'
  done
  mkdir -p "$(dirname "$file")"

  # 主 unit：Restart=on-failure —— 崩溃/非零退出/异常信号（SIGSEGV/SIGABRT/
  # SIGKILL/OOM）由 systemd 2s 后自动拉起；正常退出（exit 0、Ctrl+C 的
  # SIGINT → SuccessExitStatus=130、SIGTERM、显式 `systemctl stop`）绝不
  # 重启。StartLimitBurst 防止崩溃死循环（60s 内重启 5 次后 systemd 放弃，
  # unit 置 failed）。进程活着但 /dsh-health 无响应的"卡死"由看门狗 unit 处理。
  cat > "$file" <<EOF
# managed by dsh-service-control (dsh --profile ctl systemd install)
[Unit]
Description=dsh service (profile ${PROFILE})
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
Environment="PATH=${env_path}"
${cfg_env}
${env_lines}
ExecStart="${PLUGIN_ROOT}/scripts/dsh-run.sh" --profile ${PROFILE} --bin "${bin}" --logdir "${LOG_DIR}"
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
SuccessExitStatus=130
TimeoutStopSec=15

[Install]
WantedBy=default.target
EOF

  # 看门狗 unit：进程外健康探测（/dsh-health 或 /），仅当 unit active 但
  # HTTP 无响应（卡死）时重启主服务；正常 stop 后 unit 为 inactive，
  # 绝不会被误重启。
  cat > "$watchdog_file" <<EOF
# managed by dsh-service-control (dsh --profile ctl systemd install)
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
  return 0
}

# ── --env 环境变量（install / reinstall 共用）──

# 解析 EXTRA_ARGS 中的 --env 规格，产出全局 ENV_SPECS=(KEY=VALUE ...)。
# 显式 KEY=VALUE 直接用（值可含 =）；隐式 KEY 从当前环境取值，未设置或为空
# 视为未找到 → 安装失败。失败时向 stdout 输出 JSON 错误并返回 1；成功时无输出。
parse_env_specs() {
  ENV_SPECS=()
  local i=0 n=${#EXTRA_ARGS[@]} spec key val
  while [[ $i -lt $n ]]; do
    local a="${EXTRA_ARGS[$i]}"
    if [[ "$a" == "--env" ]]; then
      i=$((i + 1))
      spec="${EXTRA_ARGS[$i]:-}"
    elif [[ "$a" == --env=* ]]; then
      spec="${a#--env=}"
    else
      echo "{\"ok\":false,\"error\":\"unknown argument: $a (install/reinstall only accept --env)\"}"
      return 1
    fi
    if [[ -z "$spec" ]]; then
      echo '{"ok":false,"error":"--env requires KEY or KEY=VALUE"}'
      return 1
    fi
    key="${spec%%=*}"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "{\"ok\":false,\"error\":\"invalid environment variable name: $key\"}"
      return 1
    fi
    if [[ "$spec" == *=* ]]; then
      val="${spec#*=}"
    else
      val="${!key:-}"
      if [[ -z "$val" ]]; then
        echo "{\"ok\":false,\"error\":\"environment variable $key not found (unset or empty) — export it in your shell, or pass $key=<value> explicitly\"}"
        return 1
      fi
    fi
    ENV_SPECS+=("$key=$val")
    i=$((i + 1))
  done
  return 0
}

# 生成一行 Environment="KEY=<转义后值>"。
# 转义规则（systemd.syntax(7)）：$ 在 Environment= 中无特殊含义、原样保留；
# % 是 specifier、需写 %%；引号/反斜杠按 C 风格转义（\\、\"）；换行/制表转义。
env_line() {
  local key="$1" val="$2"
  val="${val//\\/\\\\}"
  val="${val//\"/\\\"}"
  val="${val//%/%%}"
  val="${val//$'\n'/\\n}"
  val="${val//$'\t'/\\t}"
  printf 'Environment="%s=%s"' "$key" "$val"
}

# install = 托管：写 unit（服务 + 看门狗）并注册，立即启动看门狗；不开机自启
install_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo '{"ok":false,"error":"systemctl not found — systemd user services unavailable"}'
    return 1
  fi
  local unit; unit="$(unit_name)"
  local watchdog_unit; watchdog_unit="$(watchdog_unit_name)"
  if ! write_units; then return 1; fi
  # 托管：看门狗本次会话立即生效（开机自启归 enable）
  systemctl --user start "$watchdog_unit" >/dev/null 2>&1 || true
  local note=""
  # 提示：存在 systemd 之外运行的 dsh（MainPID 为 0）时需要迁入托管
  local main_pid; main_pid="$(systemctl --user show -p MainPID --value "$unit" 2>/dev/null)"
  if [[ -n "$(running_pid)" && ( -z "$main_pid" || "$main_pid" == "0" ) ]]; then
    note="dsh is currently running outside systemd — stop it (dsh --profile ctl systemd stop) then start again to move it under systemd"
  fi
  local njs=""; [[ -n "$note" ]] && njs=",\"note\":\"$note\""
  echo "{\"ok\":true,\"installed\":true,\"unit\":\"$unit\",\"watchdog\":\"$watchdog_unit\",\"file\":\"$(unit_file_path)\"$njs}"
  return 0
}

# reinstall = 向已安装的主 unit 追加环境变量，保留用户对 unit 文件的全部修改（不整体重写）。
# 新键插入 [Service] 段末尾；同键已存在则跳过并提示。完成后 daemon-reload；
# 不自动重启（环境变量下次 restart 才生效，命令末尾给出提示）。
reinstall_service() {
  local file; file="$(unit_file_path)"
  if [[ ! -f "$file" ]]; then
    echo '{"ok":false,"error":"not installed — run: dsh --profile ctl systemd install first"}'
    return 1
  fi
  if ! parse_env_specs; then return 1; fi
  if [[ ${#ENV_SPECS[@]} -eq 0 ]]; then
    echo '{"ok":false,"error":"reinstall requires at least one --env KEY or --env KEY=VALUE"}'
    return 1
  fi
  # unit 文件必须是标准结构：没有 [Service] 段时拒绝改动，避免写坏
  if ! grep -q '^[[:space:]]*\[Service\]' "$file"; then
    echo '{"ok":false,"error":"unit file has no [Service] section — refusing to modify it","file":"'$file'"}'
    return 1
  fi
  # [Service] 段最后一行行号（新 Environment 行插到这里之后）。
  # 注意：awk 的 exit 会继续执行 END 块，故用 insvc 置零代替 exit，避免输出两行
  local last_svc
  last_svc="$(awk '
    /^[[:space:]]*\[/ {
      sec = $0; sub(/^[[:space:]]*\[/, "", sec); sub(/\].*/, "", sec)
      if (sec == "Service") { insvc = 1; next }
      if (insvc) { print NR - 1; insvc = 0 }
    }
    END { if (insvc) print NR }
  ' "$file")"
  if [[ ! "$last_svc" =~ ^[0-9]+$ ]]; then
    echo '{"ok":false,"error":"cannot locate the [Service] section boundary in unit file","file":"'$file'"}'
    return 1
  fi
  # [Service] 段内已存在的 Environment= 键（匹配带引号与不带引号两种写法）
  local existing
  existing="$(awk '
    /^[[:space:]]*\[/ {
      sec = $0; sub(/^[[:space:]]*\[/, "", sec); sub(/\].*/, "", sec)
      next
    }
    sec == "Service" && /^[[:space:]]*Environment=/ {
      if (match($0, /^[[:space:]]*Environment=["]?([A-Za-z_][A-Za-z0-9_]*)=/, m)) print m[1]
    }
  ' "$file")"
  local -A seen=()
  local k
  for k in $existing; do seen[$k]=1; done
  # 本次要写入的行（跳过已存在的键）
  local spec key val line insert=""
  local -a added=() skipped=()
  for spec in "${ENV_SPECS[@]}"; do
    key="${spec%%=*}"; val="${spec#*=}"
    if [[ -n "${seen[$key]:-}" ]]; then
      skipped+=("$key")
      continue
    fi
    line="$(env_line "$key" "$val")"
    insert+="${line}"$'\n'
    added+=("$key")
  done
  # 原子写：保留原文件权限
  local mode; mode="$(stat -c %a "$file" 2>/dev/null || echo 644)"
  local tmp; tmp="$(mktemp)"
  head -n "$last_svc" "$file" > "$tmp"
  printf '%s' "$insert" >> "$tmp"
  tail -n +$((last_svc + 1)) "$file" >> "$tmp"
  chmod "$mode" "$tmp"
  mv "$tmp" "$file"
  # daemon-reload 让 systemd 重新读 unit；失败不致命（unit 可能有其它手改问题），仅提示
  local reload_note=""
  if command -v systemctl >/dev/null 2>&1 && ! systemctl --user daemon-reload >/dev/null 2>&1; then
    reload_note="daemon-reload failed — check the unit file: systemctl --user status $(unit_name)"
  fi
  # 输出 JSON：added / skipped / 生效提示
  local added_json="[" skipped_json="[" u=""
  for k in "${added[@]}"; do added_json+="${u}\"$k\""; u=","; done
  added_json+="]"
  u=""
  for k in "${skipped[@]}"; do skipped_json+="${u}\"$k\""; u=","; done
  skipped_json+="]"
  local note="environment applies on next restart — run: dsh --profile ctl systemd restart"
  [[ -n "$reload_note" ]] && note="$reload_note"
  [[ ${#skipped[@]} -gt 0 ]] && note="$note (skipped (already set): ${skipped[*]})"
  echo "{\"ok\":true,\"reinstalled\":true,\"unit\":\"$(unit_name)\",\"file\":\"$file\",\"env\":{\"added\":$added_json,\"skipped\":$skipped_json},\"note\":\"$note\"}"
  return 0
}

# enable = 托管 + 开机自启（无 unit 时自动先安装；复用 write_units 避免重复输出 JSON）
enable_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo '{"ok":false,"error":"systemctl not found — systemd user services unavailable"}'
    return 1
  fi
  if ! systemd_unit_exists; then
    write_units || return 1
  fi
  local unit; unit="$(unit_name)"
  local watchdog_unit; watchdog_unit="$(watchdog_unit_name)"
  if ! systemctl --user enable "$unit" "$watchdog_unit" >/dev/null 2>&1; then
    echo "{\"ok\":false,\"error\":\"systemctl --user enable failed — see: systemctl --user status $unit\",\"file\":\"$(unit_file_path)\"}"
    return 1
  fi
  # 确保看门狗当前也在运行
  systemctl --user start "$watchdog_unit" >/dev/null 2>&1 || true
  echo "{\"ok\":true,\"enabled\":true,\"unit\":\"$unit\",\"watchdog\":\"$watchdog_unit\",\"file\":\"$(unit_file_path)\"}"
  return 0
}

# disable = 停看门狗 + 取消自启（保留 unit 文件，托管仍生效）
disable_service() {
  local unit; unit="$(unit_name)"
  local watchdog_unit; watchdog_unit="$(watchdog_unit_name)"
  local was_enabled=false
  local note=""
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user is-enabled "$unit" >/dev/null 2>&1 && was_enabled=true
    # 先停看门狗，避免它在禁用过程中去重启主服务
    systemctl --user stop "$watchdog_unit" >/dev/null 2>&1 || true
    systemctl --user disable "$unit" "$watchdog_unit" >/dev/null 2>&1 || true
    # 保留 unit 文件：删除归 uninstall
  else
    note="systemctl not found — nothing to disable"
  fi
  if [[ -n "$note" ]]; then
    echo "{\"ok\":true,\"disabled\":$was_enabled,\"unit\":\"$unit\",\"watchdog\":\"$watchdog_unit\",\"note\":\"$note\"}"
  else
    echo "{\"ok\":true,\"disabled\":$was_enabled,\"unit\":\"$unit\",\"watchdog\":\"$watchdog_unit\"}"
  fi
}

# uninstall = 撤销托管：停服务与看门狗 + 取消自启 + 删除 unit 文件
uninstall_service() {
  local unit; unit="$(unit_name)"
  local watchdog_unit; watchdog_unit="$(watchdog_unit_name)"
  local file; file="$(unit_file_path)"
  local watchdog_file; watchdog_file="$(watchdog_unit_file_path)"
  local removed=false
  local note=""
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop "$watchdog_unit" >/dev/null 2>&1 || true
    systemctl --user stop "$unit" >/dev/null 2>&1 || true
    systemctl --user disable "$unit" "$watchdog_unit" >/dev/null 2>&1 || true
  else
    note="systemctl not found — removed unit files only"
  fi
  for f in "$file" "$watchdog_file"; do
    if [[ -f "$f" ]]; then
      rm -f "$f"
      removed=true
    fi
  done
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  if [[ -n "$note" ]]; then
    echo "{\"ok\":true,\"removed\":$removed,\"unit\":\"$unit\",\"watchdog\":\"$watchdog_unit\",\"note\":\"$note\"}"
  else
    echo "{\"ok\":true,\"removed\":$removed,\"unit\":\"$unit\",\"watchdog\":\"$watchdog_unit\"}"
  fi
}

# ── 看门狗（systemd 独立 unit 运行，进程外）──
# 崩溃重启由主 unit 的 Restart=on-failure 负责；这里只管"卡死"：
# systemd 认为 active 但健康探测连续无响应 → systemctl restart。
#
# 健康探测：dsh 0.1.x 没有 /dsh-health 端点（插件 v3 起也不再自挂该路由），
# 先试 /dsh-health（未来平台提供时自动生效），否则回退探测 web 根路径 /。
probe_healthy() {
  local port="$1" timeout="$2"
  curl -fsS --max-time "$timeout" "http://127.0.0.1:$port/dsh-health" >/dev/null 2>&1 && return 0
  curl -fsS --max-time "$timeout" "http://127.0.0.1:$port/" >/dev/null 2>&1
}

watchdog_loop() {
  local unit; unit="$(unit_name)"
  local interval="${DSH_WATCHDOG_INTERVAL:-3}"
  local fail_limit="${DSH_WATCHDOG_FAIL_LIMIT:-3}"
  local probe_timeout="${DSH_WATCHDOG_PROBE_TIMEOUT:-3}"
  local cooldown="${DSH_WATCHDOG_COOLDOWN:-15}"
  watchdog_log() { echo "[dsh-service-control] watchdog($PROFILE): $*"; }
  if ! command -v curl >/dev/null 2>&1; then
    watchdog_log "curl not found — cannot probe health; exiting"
    exit 1
  fi
  # 数值校验：非法配置（0/负数/非数字）会让 sleep/算术异常，直接退出并提示
  local _n
  for _n in "$interval" "$probe_timeout" "$cooldown"; do
    if ! [[ "$_n" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      watchdog_log "invalid numeric config: '$_n' (DSH_WATCHDOG_INTERVAL/PROBE_TIMEOUT/COOLDOWN must be positive numbers)"
      exit 1
    fi
  done
  if ! [[ "$fail_limit" =~ ^[1-9][0-9]*$ ]]; then
    watchdog_log "invalid DSH_WATCHDOG_FAIL_LIMIT: '$fail_limit' (must be a positive integer)"
    exit 1
  fi
  local fails=0
  watchdog_log "started (unit=$unit interval=${interval}s fail-limit=$fail_limit)"
  while true; do
    if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active "$unit" >/dev/null 2>&1; then
      local port; port="$(detect_port || true)"
      if [[ -n "$port" ]] && probe_healthy "$port" "$probe_timeout"; then
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

# 毫秒时间戳：GNU date 支持 %3N；macOS/BSD date 不支持（会输出字面量而非
# 报错），此时回退到 node（dsh 运行环境必有 node）。
ms_now() {
  local v; v="$(date +%s%3N 2>/dev/null)"
  if [[ "$v" =~ ^[0-9]+$ ]]; then
    echo "$v"
  else
    node -p 'Date.now()' 2>/dev/null || echo 0
  fi
}

# ── probe：健康探活（/dsh-health 优先，回退 /），报告可达性与延迟 ──
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
  local t0 t1 ms body rc
  # 首选专用健康端点（body 需含 "ok":true）；dsh 0.1.x 无此端点时回退 web 根路径
  t0="$(ms_now)"
  body="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/dsh-health" 2>/dev/null)"
  rc=$?
  t1="$(ms_now)"; ms=$((t1 - t0))
  if [[ $rc -eq 0 && "$body" == *'"ok":true'* ]]; then
    echo "{\"ok\":true,\"healthy\":true,\"pid\":$pid,\"port\":$port,\"latency_ms\":$ms,\"url\":\"http://127.0.0.1:$port\",\"probe\":\"/dsh-health\",\"profile\":\"$PROFILE\"}"
    return 0
  fi
  t0="$(ms_now)"
  curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null
  rc=$?
  t1="$(ms_now)"; ms=$((t1 - t0))
  if [[ $rc -eq 0 ]]; then
    echo "{\"ok\":true,\"healthy\":true,\"pid\":$pid,\"port\":$port,\"latency_ms\":$ms,\"url\":\"http://127.0.0.1:$port\",\"probe\":\"/\",\"profile\":\"$PROFILE\"}"
    return 0
  fi
  echo "{\"ok\":false,\"healthy\":false,\"pid\":$pid,\"port\":$port,\"latency_ms\":$ms,\"error\":\"unresponsive (no /dsh-health and no /)\",\"profile\":\"$PROFILE\"}"
  return 1
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
    warn "unit $unit not present — run 'dsh --profile ctl systemd install'"
  fi
  # 3. process / port / health
  local pid port
  pid="$(current_pid || true)"
  port="$(detect_port "$pid" || true)"
  if [[ -n "$pid" ]]; then
    ok "process running (pid $pid)"
    if [[ -n "$port" ]]; then
      ok "listening on $port"
      if probe_healthy "$port" 3; then
        ok "health probe responds (/dsh-health or /)"
      else
        bad "health probe unresponsive (possible hang)"
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
  # 8. unit 里固化的 dsh 二进制是否仍存在（dsh 升级/换路径后 unit 会失效）
  if [[ -f "$(unit_file_path)" ]]; then
    local baked; baked="$(sed -n 's/.*--bin "\([^"]*\)".*/\1/p' "$(unit_file_path)" 2>/dev/null | head -1)"
    if [[ -n "$baked" ]]; then
      if [[ -x "$baked" ]]; then
        ok "unit dsh binary exists ($baked)"
      else
        bad "unit dsh binary MISSING: $baked — re-run 'dsh --profile ctl systemd install' to refresh the unit"
      fi
    fi
  fi
  echo "--------------------------------------------"
  echo "result: $pass ok, $fail failed"
  [[ "$fail" -eq 0 ]]
}

# ── logs：查看/跟随日志，用户自选源 ──
#   control.sh logs dsh [-f]           dsh 日志文件（$LOG_FILE，含 dsh console + 生命周期事件）
#   control.sh logs journal [-f]       systemd journal（journalctl -u dsh-<profile>）
#   control.sh logs [-f]               （默认 dsh）
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
    # 跨午夜场景：运行中的进程仍写其启动日的文件，今日文件可能还没创建——
    # 给出最近一份日志的路径，避免用户误以为日志丢失。
    local prev; prev="$(ls -t "${LOG_DIR}"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-dsh-${PROFILE}.log 2>/dev/null | head -1)"
    if [[ -n "$prev" ]]; then
      echo "no log for today yet: $LOG_FILE"
      echo "most recent log (a running process may still be writing here): $prev"
    else
      echo "no log file yet: $LOG_FILE"
    fi
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
  # 看门狗数值键做范围校验，避免非法值写盘后让 watchdog 循环异常
  case "$key" in
    DSH_WATCHDOG_INTERVAL|DSH_WATCHDOG_PROBE_TIMEOUT|DSH_WATCHDOG_COOLDOWN)
      if ! [[ "$val" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
        echo "{\"ok\":false,\"error\":\"$key must be a positive number, got: $val\"}"
        return 1
      fi ;;
    DSH_WATCHDOG_FAIL_LIMIT)
      if ! [[ "$val" =~ ^[1-9][0-9]*$ ]]; then
        echo "{\"ok\":false,\"error\":\"$key must be a positive integer, got: $val\"}"
        return 1
      fi ;;
  esac
  mkdir -p "$(dirname "$CONF_FILE")"
  touch "$CONF_FILE"
  local tmp; tmp="$(mktemp)"
  grep -v "^${key}=" "$CONF_FILE" > "$tmp" 2>/dev/null || true
  echo "${key}=${val}" >> "$tmp"
  mv "$tmp" "$CONF_FILE"
  echo "{\"ok\":true,\"key\":\"$key\",\"value\":\"$val\",\"file\":\"$CONF_FILE\"}"
}

case "$CMD" in
  start)     start ;;
  stop)      stop ;;
  restart)   restart ;;
  status)    status ;;
  install)   install_service ;;
  reinstall) reinstall_service ;;
  enable)    enable_service ;;
  disable)   disable_service ;;
  uninstall) uninstall_service ;;
  watchdog)  watchdog_loop ;;
  probe)     probe ;;
  doctor)    doctor ;;
  logs)      logs ;;
  config)    config ;;
esac
