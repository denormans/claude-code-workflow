#!/bin/bash
# Test script for session-return.sh
# Drives the hook against a PLUGIN_ROOT whose bin/dashboard is a stub that logs its argv and writes to
# both stdout and stderr; the hook must exit 0 and print nothing on stderr in every case, and print
# nothing on stdout except the board instruction for a board-launched session at startup.

set -uo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/session-return.sh"
PASS=0
FAIL=0
SKIP=0

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

# $1 = locale name. A missing locale falls back to the C charmap on both macOS and glibc, so it is
# installed only when its charmap differs from C's.
locale_installed() {
  [[ "$(LC_ALL="$1" locale charmap 2>/dev/null)" != "$(LC_ALL=C locale charmap)" ]]
}

# $1 = root path, $2 = stub exit code
make_root() {
  local root="$1" stub_exit="${2:-0}"
  mkdir -p "$root/hooks" "$root/bin"
  cp "$HOOK_SCRIPT" "$root/hooks/session-return.sh"
  chmod +x "$root/hooks/session-return.sh"
  printf '#!/bin/bash\necho "$@" >> "%s/calls.log"\necho "$1 $2 CLAUDE_CODE_SESSION_ID=${CLAUDE_CODE_SESSION_ID:-}" >> "%s/env.log"\necho stub-stdout\necho stub-stderr >&2\nexit %s\n' "$root" "$root" "$stub_exit" > "$root/bin/dashboard"
  chmod +x "$root/bin/dashboard"
}

OUT="$TMP_ROOT/hook.out"
ERR="$TMP_ROOT/hook.err"
BOARD_INSTRUCTION='This session was launched from the board. Never send your first response before invoking `workflow:board` with the Skill tool: the board is where this session posts its questions and approvals.'
BOARD_INSTRUCTION_EXPECTED="$TMP_ROOT/board-instruction.expected"
printf '%s\n' "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"$BOARD_INSTRUCTION\"}}" > "$BOARD_INSTRUCTION_EXPECTED"

# $1 = root, $2 = stdin JSON, rest = `env` arguments; leaves the hook's exit status in RC.
run_hook() {
  local root="$1" json="$2"
  shift 2
  printf '%s\n' "$json" | env -u AGENT_SESSION_LAUNCH -u AGENT_SESSION_TITLE "$@" "$root/hooks/session-return.sh" >"$OUT" 2>"$ERR"
  RC=$?
}

# $1 = label prefix: exit 0, nothing on stdout, nothing on stderr.
check_quiet() {
  check "$1: exits 0" "0" "$RC"
  [ ! -s "$OUT" ]
  check "$1: stdout is empty" "0" "$?"
  [ ! -s "$ERR" ]
  check "$1: stderr is empty" "0" "$?"
}

# $1 = label prefix: exit 0, nothing on stderr, and stdout is byte-for-byte the one-line SessionStart
# board instruction and a newline.
check_board_instruction() {
  check "$1: exits 0" "0" "$RC"
  [ ! -s "$ERR" ]
  check "$1: stderr is empty" "0" "$?"
  cmp -s "$BOARD_INSTRUCTION_EXPECTED" "$OUT"
  check "$1: stdout is exactly the SessionStart board instruction" "0" "$?"
}

calls() {
  cat "$1/calls.log" 2>/dev/null || true
}

env_calls() {
  cat "$1/env.log" 2>/dev/null || true
}

# --- Case 1: all three inputs present -> refresh-return invoked --------------
ROOT1="$TMP_ROOT/all"
make_root "$ROOT1"
run_hook "$ROOT1" '{"session_id":"S1"}' ITERM_SESSION_ID="w0t0p0:ABC" CLAUDE_PROJECT_DIR="/launch/dir"
check_quiet "all inputs"
check "all inputs: invokes refresh-return with session and cwd" \
  "session refresh-return --session S1 --cwd /launch/dir" "$(calls "$ROOT1")"

# --- Case 2: any one input missing -> not invoked ----------------------------
ROOT2="$TMP_ROOT/missing"
make_root "$ROOT2"
run_hook "$ROOT2" '{}' ITERM_SESSION_ID="w0t0p0:ABC" CLAUDE_PROJECT_DIR="/d"
check_quiet "no session id"
run_hook "$ROOT2" '{"session_id":"S1"}' -u ITERM_SESSION_ID CLAUDE_PROJECT_DIR="/d"
check_quiet "no iTerm id"
run_hook "$ROOT2" '{"session_id":"S1"}' -u CLAUDE_PROJECT_DIR ITERM_SESSION_ID="w0t0p0:ABC"
check_quiet "no project dir"
check "missing session id, iTerm id or project dir: never invoked" "" "$(calls "$ROOT2")"

# --- Case 3: failing stub still exits 0 and stays silent ---------------------
ROOT3="$TMP_ROOT/failing"
make_root "$ROOT3" 7
run_hook "$ROOT3" '{"session_id":"S1"}' ITERM_SESSION_ID="w0t0p0:ABC" CLAUDE_PROJECT_DIR="/d"
check_quiet "failing dashboard"
check "failing dashboard: the stub was invoked" "session refresh-return --session S1 --cwd /d" "$(calls "$ROOT3")"

# --- Launch title: the launched session at startup -> launch-title, then refresh-return -----------
ROOT_L1="$TMP_ROOT/launch"
make_root "$ROOT_L1"
run_hook "$ROOT_L1" '{"session_id":"S1","source":"startup"}' \
  AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="Fix the login test" \
  ITERM_SESSION_ID="w0t0p0:ABC" CLAUDE_PROJECT_DIR="/launch/dir"
check_board_instruction "launched session"
check "launched session: launch-title first, then refresh-return" \
  "session launch-title --session S1 --title=Fix the login test
session refresh-return --session S1 --cwd /launch/dir" "$(calls "$ROOT_L1")"

# --- Launch title without iTerm: still opens the titled root ----------------------------------------
ROOT_L2="$TMP_ROOT/launch-no-iterm"
make_root "$ROOT_L2"
run_hook "$ROOT_L2" '{"session_id":"S1","source":"startup"}' \
  -u ITERM_SESSION_ID AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="T" CLAUDE_PROJECT_DIR="/d"
check_board_instruction "launched session outside iTerm"
check "launched session outside iTerm: launch-title only" \
  "session launch-title --session S1 --title=T" "$(calls "$ROOT_L2")"

# --- A flag-shaped title is one --title= token, never a flag of the verb -----------------------------
ROOT_L5="$TMP_ROOT/launch-flag-title"
make_root "$ROOT_L5"
run_hook "$ROOT_L5" '{"session_id":"S1","source":"startup"}' \
  -u ITERM_SESSION_ID AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="--help" CLAUDE_PROJECT_DIR="/d"
check_board_instruction "flag-shaped title"
check "flag-shaped title: passed as the single token --title=--help" \
  "session launch-title --session S1 --title=--help" "$(calls "$ROOT_L5")"

# --- launch-title runs scoped to the launched session; refresh-return keeps the inherited environment ---
ROOT_L8="$TMP_ROOT/launch-env-unset"
make_root "$ROOT_L8"
run_hook "$ROOT_L8" '{"session_id":"S1","source":"startup"}' \
  -u CLAUDE_CODE_SESSION_ID AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="T" \
  ITERM_SESSION_ID="w0t0p0:ABC" CLAUDE_PROJECT_DIR="/d"
check "launch-title sees the hook's session id when none is inherited; refresh-return sees none" \
  "session launch-title CLAUDE_CODE_SESSION_ID=S1
session refresh-return CLAUDE_CODE_SESSION_ID=" "$(env_calls "$ROOT_L8")"

ROOT_L9="$TMP_ROOT/launch-env-other"
make_root "$ROOT_L9"
run_hook "$ROOT_L9" '{"session_id":"S1","source":"startup"}' \
  CLAUDE_CODE_SESSION_ID="OTHER" AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="T" \
  ITERM_SESSION_ID="w0t0p0:ABC" CLAUDE_PROJECT_DIR="/d"
check "launch-title sees the hook's session id over an inherited one; refresh-return keeps it" \
  "session launch-title CLAUDE_CODE_SESSION_ID=S1
session refresh-return CLAUDE_CODE_SESSION_ID=OTHER" "$(env_calls "$ROOT_L9")"

ROOT_L10="$TMP_ROOT/launch-env-two-token"
make_root "$ROOT_L10"
run_hook "$ROOT_L10" '{"session_id":"S1","source":"startup"}' \
  CLAUDE_CODE_SESSION_ID="OTHER" AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="first
second" \
  ITERM_SESSION_ID="w0t0p0:ABC" CLAUDE_PROJECT_DIR="/d"
check "two-token launch-title sees the hook's session id over an inherited one; refresh-return keeps it" \
  "session launch-title CLAUDE_CODE_SESSION_ID=S1
session refresh-return CLAUDE_CODE_SESSION_ID=OTHER" "$(env_calls "$ROOT_L10")"

# --- A multi-line or separator-bearing title goes as two tokens, so the parser still sees a value ------
LS="$(printf '\xe2\x80\xa8')"
PS="$(printf '\xe2\x80\xa9')"
ROOT_L6="$TMP_ROOT/launch-multiline-title"
make_root "$ROOT_L6"
run_hook "$ROOT_L6" '{"session_id":"S1","source":"startup"}' \
  -u ITERM_SESSION_ID AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="--help
more" CLAUDE_PROJECT_DIR="/d"
check_board_instruction "multi-line title"
check "multi-line title: separate --title token" \
  "session launch-title --session S1 --title --help
more" "$(calls "$ROOT_L6")"
for sep_locale in C en_US.UTF-8 ja_JP.eucJP ko_KR.eucKR; do
  for sep_case in "cr:$(printf 'a\rb')" "ls:a${LS}b" "ps:a${PS}b"; do
    sep_name="${sep_case%%:*}"
    sep_title="${sep_case#*:}"
    if [[ "$sep_locale" != "C" ]] && ! locale_installed "$sep_locale"; then
      echo "SKIP: $sep_name title under $sep_locale: locale not installed"
      SKIP=$((SKIP + 1))
      continue
    fi
    ROOT_SEP="$TMP_ROOT/launch-sep-$sep_name-$sep_locale"
    make_root "$ROOT_SEP"
    run_hook "$ROOT_SEP" '{"session_id":"S1","source":"startup"}' \
      -u ITERM_SESSION_ID LC_ALL="$sep_locale" AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="$sep_title" CLAUDE_PROJECT_DIR="/d"
    check "$sep_name title under $sep_locale: separate --title token" \
      "session launch-title --session S1 --title $sep_title" "$(calls "$ROOT_SEP")"
  done
done

# --- Untitled launch: no launch-title, but still told to load the board protocol -------------------
ROOT_L11="$TMP_ROOT/launch-untitled"
make_root "$ROOT_L11"
run_hook "$ROOT_L11" '{"session_id":"S1","source":"startup"}' \
  -u ITERM_SESSION_ID AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="" CLAUDE_PROJECT_DIR="/d"
check_board_instruction "untitled launch"
check "untitled launch: launch-title never invoked" "" "$(calls "$ROOT_L11")"

# --- Not claimed: child session, resume, no launch id ------------------------------------------------
ROOT_L3="$TMP_ROOT/launch-skipped"
make_root "$ROOT_L3"
run_hook "$ROOT_L3" '{"session_id":"CHILD","source":"startup"}' \
  -u ITERM_SESSION_ID AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="T" CLAUDE_PROJECT_DIR="/d"
check_quiet "child session"
run_hook "$ROOT_L3" '{"session_id":"S1","source":"resume"}' \
  -u ITERM_SESSION_ID AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="T" CLAUDE_PROJECT_DIR="/d"
check_quiet "resumed session"
run_hook "$ROOT_L3" '{"session_id":"S1","source":"startup"}' \
  -u AGENT_SESSION_LAUNCH -u ITERM_SESSION_ID AGENT_SESSION_TITLE="T" CLAUDE_PROJECT_DIR="/d"
check_quiet "no launch id"
check "child, resumed or unlaunched: launch-title never invoked" "" "$(calls "$ROOT_L3")"

# --- Launch title fails: still silent, refresh-return still runs ------------------------------------
ROOT_L4="$TMP_ROOT/launch-fails"
make_root "$ROOT_L4" 1
run_hook "$ROOT_L4" '{"session_id":"S1","source":"startup"}' \
  AGENT_SESSION_LAUNCH="S1" AGENT_SESSION_TITLE="T" ITERM_SESSION_ID="w0t0p0:ABC" CLAUDE_PROJECT_DIR="/d"
check_board_instruction "launch-title fails"
check "launch-title fails: refresh-return still runs" \
  "session launch-title --session S1 --title=T
session refresh-return --session S1 --cwd /d" "$(calls "$ROOT_L4")"

echo ""
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
