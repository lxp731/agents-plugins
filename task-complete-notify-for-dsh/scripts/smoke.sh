#!/usr/bin/env bash
# Smoke test: verify the plugin loads and its notifier logic works without a
# running dsh host. Runs the unit test suite. Requires the peer deps to be
# resolvable (from a dsh install) — see README "Development".
set -euo pipefail
cd "$(dirname "$0")/.."

# Resolve peer deps (@deepseek-ai/schemastery, @deepseek-ai/dsh-tools) from a
# dsh install if a local node_modules doesn't already have them.
if [ ! -d node_modules/@deepseek-ai/schemastery ]; then
  DSH_NM="${DSH_NM:-$HOME/.dsh/profiles/web/node_modules}"
  if [ -d "$DSH_NM/@deepseek-ai/schemastery" ] && [ -d "$DSH_NM/@deepseek-ai/dsh-tools" ]; then
    mkdir -p node_modules/@deepseek-ai
    ln -sfn "$DSH_NM/@deepseek-ai/schemastery" node_modules/@deepseek-ai/schemastery
    ln -sfn "$DSH_NM/@deepseek-ai/dsh-tools" node_modules/@deepseek-ai/dsh-tools
  else
    echo "error: peer deps not resolvable. Run inside a dsh profile node_modules tree." >&2
    exit 1
  fi
fi

node --test tests/*.test.mjs
