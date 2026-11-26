#!/usr/bin/env bash
# StopFailure hook (FLOW-465): records a turn killed by an API, network or sleep error so the idle
# `mailbox check` can resume the session. Failures are swallowed; the hook always exits 0.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INPUT=$(cat)
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
  AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || AGENT_ID=""
else
  SESSION_ID=""
  AGENT_ID=""
fi

[[ -z "$SESSION_ID" ]] && exit 0

# An in-process subagent or teammate fires StopFailure under its parent's session_id and carries an
# agent_id; the parent's own turn did not fail. A pane-backed teammate is its own session with no
# agent_id, so it still records.
[[ -n "$AGENT_ID" ]] && exit 0

# The board shows the turn as failed. Swallowed like the record below.
printf '%s' "$INPUT" | "${PLUGIN_ROOT}/bin/dashboard" session turn-end --outcome failed --session "$SESSION_ID" >/dev/null 2>&1 || true

printf '%s' "$INPUT" | "${PLUGIN_ROOT}/bin/mailbox" turn-failed --session "$SESSION_ID" >/dev/null 2>&1 || true
exit 0
