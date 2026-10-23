#!/usr/bin/env bash
# Live verification for the DeepSeek Harness bundle.
#
# The offline suite cannot prove the runtime emits the event the plugin binds,
# nor that the injected message survives into a session. This script installs the
# bundle into a throwaway headless profile, runs one real prompt, and asserts the
# session log contains the injected bootstrap. It needs model credentials
# (DEEPSEEK_API_KEY or the harness credential store) and network access.
#
# Usage: bash tests/dsh/verify-live.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE="superpowers-verify-$$"
WORK="$(mktemp -d)"
CLEAN=1
LOG_DIR=""

cleanup() {
  if [ "$CLEAN" = 1 ]; then
    dsh plugin --profile "$PROFILE" remove superpowers >/dev/null 2>&1 || true
    rm -rf "${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"
    [ -z "$LOG_DIR" ] || rm -rf "$LOG_DIR"
  fi
  rm -rf "$WORK"
}
# Keep the profile (and its evidence) on any failure, not just the handled ones.
trap 'status=$?; [ "$status" -eq 0 ] || CLEAN=0; cleanup; exit "$status"' EXIT

echo "== creating profile $PROFILE"
dsh --profile "$PROFILE" --from-default-profile headless --dump-config >/dev/null

echo "== installing $REPO"
dsh plugin --profile "$PROFILE" add "$REPO" >/dev/null

echo "== running one session"
cd "$WORK"
dsh --profile "$PROFILE" --json "What are your superpowers? Answer in one sentence." > run.json 2> run.err || {
  echo "FAIL: the session did not run" >&2
  tail -5 run.err >&2 || true
  CLEAN=0
  echo "profile kept for inspection: ${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE" >&2
  exit 1
}

# The run names its own session; inspecting only that log keeps the check honest
# (another session in the same window may quote the marker).
session=$(jq -r 'select(.type == "session") | .sessionId' run.json 2>/dev/null | head -1)
if [ -z "$session" ] || [ "$session" = "null" ]; then
  echo "FAIL: the run did not report a session id" >&2
  CLEAN=0
  exit 1
fi

echo "== inspecting the session log for $session"
log=$(find "${DSH_HOME:-$HOME/.dsh}/sessions" -path "*/$session/session*.jsonl*" -type f 2>/dev/null | head -1)
if [ -z "$log" ]; then
  echo "FAIL: no persisted log for session $session" >&2
  CLEAN=0
  echo "profile kept for inspection: ${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE" >&2
  exit 1
fi

# Session logs are persisted as session.v<N>.jsonl.zstd (older runs: plain .jsonl).
read_log() {
  case "$1" in
    *.zstd)
      if ! command -v zstd >/dev/null 2>&1; then
        echo "FAIL: $1 is zstd-compressed but the zstd CLI is not installed" >&2
        exit 1
      fi
      zstd -dc "$1"
      ;;
    *) cat "$1" ;;
  esac
}

LOG_DIR="$(dirname "$log")"
body="$(read_log "$log")"
if ! grep -q '"kind":"superpowers"' <<<"$body" || ! grep -q 'EXTREMELY_IMPORTANT' <<<"$body"; then
  echo "FAIL: session $session was not bootstrapped" >&2
  CLEAN=0
  echo "profile kept for inspection: ${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE" >&2
  exit 1
fi

markers=$(grep -o 'EXTREMELY_IMPORTANT' <<<"$body" | wc -l)
echo "PASS: injected message found in $log ($markers markers)"
grep -o '"kind":"superpowers"' <<<"$body" | head -1
