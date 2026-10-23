#!/usr/bin/env bash
# Runs the DeepSeek Harness (DSH) bundle tests: offline, no dsh process needed.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --test "${DIR}/test-plugin.mjs"
