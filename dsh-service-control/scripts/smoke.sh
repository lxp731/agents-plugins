#!/bin/bash
# ********************************************************************
# * dsh-service-control — smoke test (official recommended flow, v3)
# *
# * Installs the plugin into an isolated test profile (never touches the
# * real web profile), asserts the bundle rows appear in the composed
# * config, boots `dsh --profile <test> self info` and `systemd status`
# * through the cmdline channel, then cleans up.
# *
# * Usage: bash scripts/smoke.sh
# * Skips with a warning if the `dsh` CLI is not available.
# ********************************************************************

set -euo pipefail

PROFILE="dsh-service-control-test"

cleanup() {
  rm -rf "${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"
}
trap cleanup EXIT

if ! command -v dsh >/dev/null 2>&1; then
  echo "⚠  dsh CLI not found — skipping smoke test"
  exit 0
fi

here="$(cd "$(dirname "$0")/.." && pwd)"

echo "── 1/4 install plugin into isolated profile: ${PROFILE}"
dsh plugin --profile "$PROFILE" add "file:${here}" >/dev/null

echo "── 2/4 assert bundle rows in composed config"
if ! dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q "dsh-service-control"; then
  echo "✗  plugin row missing from profile ${PROFILE} config"
  exit 1
fi
echo "✓  bundle rows present"

echo "── 3/4 cmdline channel: self info"
INFO="$(dsh --profile "$PROFILE" self info 2>&1)"
if [[ "$INFO" != *"name:      dsh-service-control"* ]]; then
  echo "✗  self info returned: $INFO"
  exit 1
fi
echo "✓  self info ok"

echo "── 4/4 cmdline channel: systemd status"
STATUS="$(dsh --profile "$PROFILE" systemd status 2>&1)"
if [[ "$STATUS" != *"not installed"* && "$STATUS" != *"running"* && "$STATUS" != *"not running"* ]]; then
  echo "✗  systemd status returned: $STATUS"
  exit 1
fi
echo "✓  systemd status ok"

echo "✓  smoke test passed"
