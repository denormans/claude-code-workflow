#!/bin/bash
# Test script for turn-failed.sh (FLOW-465)
# Drives the hook against a copied plugin root with a stubbed bin/mailbox.

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/turn-failed.sh"
PASS=0
FAIL=0

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

# $1 = root. The mailbox and dashboard stubs log their argv, and their stdin; the mailbox stub
# exits $MAILBOX_EXIT.
make_root() {
  local root="$1"
  mkdir -p "$root/hooks" "$root/bin"
  cp "$HOOK_SCRIPT" "$root/hooks/turn-failed.sh"
  chmod +x "$root/hooks/turn-failed.sh"
  cat > "$root/bin/mailbox" <<'STUB'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
printf 'mailbox %s\n' "$*" >> "$DIR/calls.log"
cat >> "$DIR/calls.log"
printf '\n' >> "$DIR/calls.log"
printf 'mailbox noise\n'
printf 'mailbox noise\n' >&2
exit "${MAILBOX_EXIT:-0}"
STUB
  cat > "$root/bin/dashboard" <<'STUB'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
printf 'dashboard %s\n' "$*" >> "$DIR/calls.log"
cat >> "$DIR/calls.log"
printf '\n' >> "$DIR/calls.log"
exit 0
STUB
  chmod +x "$root/bin/mailbox" "$root/bin/dashboard"
  : > "$root/calls.log"
}

calls_log() {
  cat "$1/calls.log" 2>/dev/null || printf ''
}

# Sets HOOK_EXIT, HOOK_OUT_FILE and HOOK_ERR_FILE; the channels stay in files so emptiness is read
# from raw bytes, not a $(…) capture.
run_hook() {
  local root="$1" payload="$2"
  HOOK_OUT_FILE="$root/hook.out"
  HOOK_ERR_FILE="$root/hook.err"
  HOOK_EXIT=0
  printf '%s' "$payload" | bash "$root/hooks/turn-failed.sh" >"$HOOK_OUT_FILE" 2>"$HOOK_ERR_FILE" ||
    HOOK_EXIT=$?
}

bytes() {
  wc -c <"$1" | tr -d ' '
}

echo "=== turn-failed Hook Tests ==="
echo

# --- 1: the payload is piped to `mailbox turn-failed` ---------------------------------------------
ROOT1="$TMP_ROOT/c1"
make_root "$ROOT1"
PAYLOAD='{"session_id":"s1","error":"server_error","last_assistant_message":"hi"}'
run_hook "$ROOT1" "$PAYLOAD"
check "1: exit 0" "0" "$HOOK_EXIT"
check "1: stdout and stderr are empty" "0:0" "$(bytes "$HOOK_OUT_FILE"):$(bytes "$HOOK_ERR_FILE")"
check "1: the payload is piped to the board's turn end, then to turn-failed, each with the session" \
  "dashboard session turn-end --outcome failed --session s1"$'\n'"$PAYLOAD"$'\n'"mailbox turn-failed --session s1"$'\n'"$PAYLOAD" \
  "$(calls_log "$ROOT1")"

# --- 2: a failing mailbox never changes the hook's result -----------------------------------------
ROOT2="$TMP_ROOT/c2"
make_root "$ROOT2"
MAILBOX_EXIT=1 run_hook "$ROOT2" "$PAYLOAD"
check "2: exit 0 when the mailbox exits 1" "0" "$HOOK_EXIT"
check "2: stdout and stderr are empty when the mailbox exits 1" "0:0" \
  "$(bytes "$HOOK_OUT_FILE"):$(bytes "$HOOK_ERR_FILE")"
check "2: the failing mailbox was called" "1" \
  "$(calls_log "$ROOT2" | grep -c '^mailbox turn-failed --session s1$')"

# --- 3: no session id -> no mailbox call ----------------------------------------------------------
ROOT3="$TMP_ROOT/c3"
make_root "$ROOT3"
run_hook "$ROOT3" '{"error":"server_error"}'
check "3: exit 0 with no session id" "0" "$HOOK_EXIT"
check "3: stdout and stderr are empty with no session id" "0:0" \
  "$(bytes "$HOOK_OUT_FILE"):$(bytes "$HOOK_ERR_FILE")"
check "3: no mailbox call with no session id" "" "$(calls_log "$ROOT3")"

# --- 4: only an in-process agent's failure is skipped ---------------------------------------------
ROOT4="$TMP_ROOT/c4"
make_root "$ROOT4"
run_hook "$ROOT4" '{"session_id":"s1","agent_id":"ae677bc6896a1469e","agent_type":"general-purpose","error":"server_error"}'
check "4: exit 0 for a subagent failure" "0" "$HOOK_EXIT"
check "4: no mailbox or dashboard call for a payload carrying an agent_id" "" "$(calls_log "$ROOT4")"
TEAMMATE='{"session_id":"s2","agent_type":"general-purpose","error":"server_error"}'
run_hook "$ROOT4" "$TEAMMATE"
check "4: a teammate payload with an agent_type and no agent_id records on the board and the mailbox" \
  "dashboard session turn-end --outcome failed --session s2"$'\n'"$TEAMMATE"$'\n'"mailbox turn-failed --session s2"$'\n'"$TEAMMATE" \
  "$(calls_log "$ROOT4")"
run_hook "$ROOT4" '{"session_id":"s3","agent_id":"","error":"server_error"}'
check "4: an empty agent_id records" "1" "$(calls_log "$ROOT4" | grep -c '^mailbox turn-failed --session s3$')"

echo
echo "Passed: $PASS  Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
