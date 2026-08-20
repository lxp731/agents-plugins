#!/bin/bash
# ********************************************************************
# * dsh-service-control — smoke test (official recommended flow)
# *
# * Mounts the plugin into an isolated test profile (never touches the
# * real web profile), asserts the bundle row appears in the composed
# * config, boots dsh, probes /dsh-health, then cleans up.
# *
# * The plugin injects the webServer service, so the official
# * @deepseek-ai/dsh-host-webserver is installed alongside and its
# * config (loopback + OS-assigned port) is supplied via a --patch
# * overlay. The version range matters: `latest` still points at the
# * 0.0.1-rc.1 line, whose service is named `httpServer`, not
# * `webServer` — pinning ^0.1.0-rc.8 matches what dsh itself ships.
# *
# * Usage: bash scripts/smoke.sh
# * Skips with a warning if the `dsh` CLI is not available.
# ********************************************************************

set -euo pipefail

PROFILE="dsh-service-control-test"
OVERLAY="$(mktemp /tmp/dsh-smoke-overlay-XXXXXX.yml)"
BOOT_PID=""

cleanup() {
  kill "$BOOT_PID" 2>/dev/null || true
  wait "$BOOT_PID" 2>/dev/null || true
  rm -f "$OVERLAY" "/tmp/dsh-smoke-${PROFILE}.log"
  rm -rf "${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"
}
trap cleanup EXIT

if ! command -v dsh >/dev/null 2>&1; then
  echo "⚠  dsh CLI not found — skipping smoke test"
  exit 0
fi

here="$(cd "$(dirname "$0")/.." && pwd)"

cat > "$OVERLAY" <<YAML
- insert:
    - id: dsh-host-webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: 127.0.0.1
        port: 0
YAML

echo "── 1/4 install plugins into isolated profile: ${PROFILE}"
dsh plugin --profile "$PROFILE" add "file:${here}" >/dev/null
dsh plugin --profile "$PROFILE" add "@deepseek-ai/dsh-host-webserver@^0.1.0-rc.8" >/dev/null

echo "── 2/4 assert bundle row in composed config"
if ! dsh --profile "$PROFILE" --patch "$OVERLAY" --dump-config 2>/dev/null | grep -q "dsh-service-control"; then
  echo "✗  plugin row missing from profile ${PROFILE} config"
  exit 1
fi
echo "✓  bundle row present"

echo "── 3/4 boot dsh and probe /dsh-health"
dsh --profile "$PROFILE" --patch "$OVERLAY" --no-open >"/tmp/dsh-smoke-${PROFILE}.log" 2>&1 &
BOOT_PID=$!

for _ in $(seq 1 30); do
  if ! kill -0 "$BOOT_PID" 2>/dev/null; then
    echo "✗  dsh exited during boot; see /tmp/dsh-smoke-${PROFILE}.log"
    exit 1
  fi
  PORT=$(ss -tlnp 2>/dev/null | awk -v p="$BOOT_PID" '$6 ~ "pid=" p "," { split($4, a, ":"); print a[length(a)]; exit }' || true)
  [[ -n "${PORT:-}" ]] && break
  sleep 1
done

if [[ -z "${PORT:-}" ]]; then
  echo "✗  dsh did not open a port in 30s; see /tmp/dsh-smoke-${PROFILE}.log"
  exit 1
fi

HEALTH=$(curl -s "http://127.0.0.1:${PORT}/dsh-health" || true)
if [[ "$HEALTH" != *'"ok":true'* ]]; then
  echo "✗  /dsh-health returned: ${HEALTH:-<empty>}"
  exit 1
fi
echo "✓  /dsh-health ok on port ${PORT}"

echo "── 4/4 cleanup"
echo "✓  smoke test passed"
