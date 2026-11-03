#!/bin/bash
# Test script for mailbox-watch.sh (FLOW-457)
# Drives the hook against a copied plugin root with stubbed bin/mailbox and bin/dashboard.

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/mailbox-watch.sh"
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

check_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected to contain: $needle"
    echo "  actual:               $haystack"
    FAIL=$((FAIL + 1))
  fi
}

check_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected NOT to contain: $needle"
    echo "  actual:                   $haystack"
    FAIL=$((FAIL + 1))
  fi
}

# $1 = root. The mailbox stub prints $GATE_OUTPUT and exits $GATE_EXIT; the dashboard stub logs its
# argv and stdin and exits $DASH_EXIT. Both append to $root/calls.log.
make_root() {
  local root="$1"
  mkdir -p "$root/hooks" "$root/bin"
  cp "$HOOK_SCRIPT" "$root/hooks/mailbox-watch.sh"
  chmod +x "$root/hooks/mailbox-watch.sh"
  cat > "$root/bin/mailbox" <<'STUB'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
printf 'mailbox %s\n' "$*" >> "$DIR/calls.log"
printf '%s\n' "${GATE_OUTPUT:-allow}"
exit "${GATE_EXIT:-0}"
STUB
  cat > "$root/bin/dashboard" <<'STUB'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
printf 'dashboard %s\n' "$*" >> "$DIR/calls.log"
cat >> "$DIR/calls.log"
printf '\n' >> "$DIR/calls.log"
printf 'dashboard noise\n'
printf 'dashboard noise\n' >&2
exit "${DASH_EXIT:-0}"
STUB
  chmod +x "$root/bin/mailbox" "$root/bin/dashboard"
  : > "$root/calls.log"
}

calls_log() {
  cat "$1/calls.log" 2>/dev/null || printf ''
}

# Runs the hook with the payload on stdin. Sets HOOK_EXIT, HOOK_OUT_FILE and HOOK_ERR_FILE; the
# channels stay in files so emptiness is read from raw bytes, not a $(…) capture.
run_hook() {
  local root="$1" payload="$2"
  HOOK_OUT_FILE="$root/hook.out"
  HOOK_ERR_FILE="$root/hook.err"
  HOOK_EXIT=0
  printf '%s' "$payload" | bash "$root/hooks/mailbox-watch.sh" >"$HOOK_OUT_FILE" 2>"$HOOK_ERR_FILE" ||
    HOOK_EXIT=$?
}

# Byte count of a channel file, so an exact-empty check is "0".
bytes() {
  wc -c <"$1" | tr -d ' '
}

TASKS='"background_tasks":[{"type":"shell","command":"pnpm test"}]'

echo "=== mailbox-watch Hook Tests ==="
echo

# --- 1: allowed stop records the wait with the payload piped --------------------------------------
ROOT1="$TMP_ROOT/c1"
make_root "$ROOT1"
GATE_OUTPUT=allow run_hook "$ROOT1" "{\"session_id\":\"s1\",$TASKS}"
check "1: exit 0 on an allowed stop" "0" "$HOOK_EXIT"
check "1: stdout is empty on an allowed stop" "0" "$(bytes "$HOOK_OUT_FILE")"
check "1: stderr is empty on an allowed stop" "0" "$(bytes "$HOOK_ERR_FILE")"
check "1: the gate is consulted, then the wait is recorded with the payload piped" \
  "mailbox stop-gate --session s1"$'\n'"dashboard session wait --session s1"$'\n'"{\"session_id\":\"s1\",$TASKS}" \
  "$(calls_log "$ROOT1")"

# --- 2: blocked stop does not record --------------------------------------------------------------
ROOT2="$TMP_ROOT/c2"
make_root "$ROOT2"
GATE_OUTPUT=$'block\nkeep going' run_hook "$ROOT2" "{\"session_id\":\"s2\",$TASKS}"
check "2: a blocked stop emits exactly the block decision" \
  $'{\n  "decision": "block",\n  "reason": "keep going"\n}' "$(cat "$HOOK_OUT_FILE")"
check "2: a blocked stop exits 0 with empty stderr" "0:0" "$HOOK_EXIT:$(bytes "$HOOK_ERR_FILE")"
check "2: a blocked stop consults the gate and records no wait" "mailbox stop-gate --session s2" \
  "$(calls_log "$ROOT2")"

# --- 3: stop_hook_active with a session records, without consulting the mailbox ------------------
ROOT3="$TMP_ROOT/c3"
make_root "$ROOT3"
GATE_OUTPUT=allow run_hook "$ROOT3" "{\"session_id\":\"s3\",\"stop_hook_active\":true,$TASKS}"
check "3: a stop_hook_active stop records the wait without consulting the gate" \
  "dashboard session wait --session s3"$'\n'"{\"session_id\":\"s3\",\"stop_hook_active\":true,$TASKS}" \
  "$(calls_log "$ROOT3")"

# --- 4: no session id -> no dashboard call, empty stdout ------------------------------------------
ROOT4="$TMP_ROOT/c4"
make_root "$ROOT4"
GATE_OUTPUT=allow run_hook "$ROOT4" "{$TASKS}"
check "4: exit 0 with no session id" "0" "$HOOK_EXIT"
check "4: stdout and stderr are empty with no session id" "0:0" "$(bytes "$HOOK_OUT_FILE"):$(bytes "$HOOK_ERR_FILE")"
check "4: no mailbox or dashboard call with no session id" "" "$(calls_log "$ROOT4")"

# --- 5: a failing dashboard never changes the hook's result ---------------------------------------
ROOT5="$TMP_ROOT/c5"
make_root "$ROOT5"
DASH_EXIT=1 GATE_OUTPUT=allow run_hook "$ROOT5" "{\"session_id\":\"s5\",$TASKS}"
check "5: exit 0 when the dashboard exits 1" "0" "$HOOK_EXIT"
check "5: stdout and stderr are empty when the dashboard exits 1" "0:0" "$(bytes "$HOOK_OUT_FILE"):$(bytes "$HOOK_ERR_FILE")"
check "5: the failing dashboard was called with the payload" \
  "mailbox stop-gate --session s5"$'\n'"dashboard session wait --session s5"$'\n'"{\"session_id\":\"s5\",$TASKS}" \
  "$(calls_log "$ROOT5")"

# --- 6: a failing stop-gate is treated as allow and records ---------------------------------------
ROOT6="$TMP_ROOT/c6"
make_root "$ROOT6"
GATE_EXIT=1 GATE_OUTPUT="" run_hook "$ROOT6" "{\"session_id\":\"s6\",$TASKS}"
check "6: exit 0 when the stop-gate fails" "0" "$HOOK_EXIT"
check "6: a failing stop-gate still records the wait" \
  "mailbox stop-gate --session s6"$'\n'"dashboard session wait --session s6"$'\n'"{\"session_id\":\"s6\",$TASKS}" \
  "$(calls_log "$ROOT6")"

echo
echo "Passed: $PASS  Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
