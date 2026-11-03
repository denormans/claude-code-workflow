#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INPUT=$(cat)
# Guarded (FLOW-183): under `set -e`, an unguarded assignment from a failing/missing jq would
# abort the script before the empty-guard below gets a chance to fail open.
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
  STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null) || STOP_ACTIVE="false"
else
  SESSION_ID=""
  STOP_ACTIVE="false"
fi

# Records the background work this turn ended on, so the board shows the session waiting rather than
# working (FLOW-457). Only on an allowed stop: a blocked stop continues the turn. A turn-start clear
# only clears a wait recorded before that turn started, so it never erases this record; failures are
# swallowed so a stop never fails.
record_wait() {
  printf '%s' "$INPUT" | "${PLUGIN_ROOT}/bin/dashboard" session wait --session "$SESSION_ID" >/dev/null 2>&1 || true
}

[[ -z "$SESSION_ID" ]] && exit 0

# Loop guard: if we're already resuming from a Stop hook, let the session stop.
if [[ "$STOP_ACTIVE" == "true" ]]; then
  record_wait
  exit 0
fi

if ! GATE=$("${PLUGIN_ROOT}/bin/mailbox" stop-gate --session "$SESSION_ID" 2>/dev/null); then
  GATE='allow'
fi
DECISION=${GATE%%$'\n'*}
if [[ "$DECISION" != "block" ]]; then
  record_wait
  exit 0
fi
REASON=${GATE#*$'\n'}

jq -n --arg r "$REASON" '{decision:"block", reason:$r}'
exit 0
