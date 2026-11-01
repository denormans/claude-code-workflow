#!/bin/bash
# Test script for large-read-gate.sh

set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HOOK_DIR/large-read-gate.sh"
PASS=0
FAIL=0
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

READ_HINT='call Read again with offset and limit'
SHELL_HINT="print the lines you need (sed -n '<from>,<to>p', head or tail), or use Read with offset and limit"

refusal() {
  local path="$1" bytes="$2" limit="$3" hint="$4"
  cat <<EOF
Reading ${path} whole is refused by the large-read gate: it is ${bytes} bytes, over the ${limit}-byte
limit, and a file read whole in this session is re-sent on every later request until compaction.
Instead:
- Read only the part you need: ${hint}. Find the lines first with Grep -n (for a markdown
  file, Grep '^#' lists its headings).
- Search it with Grep if you need one answer from it.
- Hand the path and your question to the researcher agent (agents/researcher.md) and use its
  answer.
A ranged read of the lines you change is enough for Edit.
EOF
}

read_input() {
  local path="$1" extra="${2:-}"
  [[ -n "$extra" ]] || extra='{}'
  jq -n --arg path "$path" --argjson extra "$extra" \
    '{tool_name: "Read", tool_input: {file_path: $path}} * $extra'
}

shell_input() {
  local command="$1" extra="${2:-}"
  [[ -n "$extra" ]] || extra='{}'
  jq -n --arg command "$command" --arg cwd "$REPO" --argjson extra "$extra" \
    '{tool_name: "Bash", cwd: $cwd, tool_input: {command: $command}} * $extra'
}

# stdout and stderr are each compared byte for byte against a file: stdout must be empty, and
# stderr must be exactly the expected text followed by one newline (or empty when none is expected).
test_case() {
  local description="$1" expected_exit="$2" expected_stderr="$3" input="$4"
  shift 4
  local stdout_file="$WORK/actual.out" stderr_file="$WORK/actual.err" expected_file="$WORK/expected.err"
  local actual_exit=0 fail=0
  printf '%s' "$input" | env -u LARGE_READ_GATE_MAX_BYTES "$@" bash "$HOOK" >"$stdout_file" 2>"$stderr_file" ||
    actual_exit=$?
  if [[ -n "$expected_stderr" ]]; then
    printf '%s\n' "$expected_stderr" > "$expected_file"
  else
    : > "$expected_file"
  fi

  if [[ "$actual_exit" -ne "$expected_exit" ]]; then
    echo "FAIL: $description (expected exit $expected_exit, got $actual_exit)"
    fail=1
  fi
  if [[ -s "$stdout_file" ]]; then
    echo "FAIL: $description (expected empty stdout, got: $(cat "$stdout_file"))"
    fail=1
  fi
  if ! cmp -s "$stderr_file" "$expected_file"; then
    echo "FAIL: $description (stderr mismatch)"
    echo "  expected: $(od -c "$expected_file" | tail -n 3 | tr '\n' ' ')"
    echo "  actual:   $(od -c "$stderr_file" | tail -n 3 | tr '\n' ' ')"
    fail=1
  fi

  if [[ "$fail" -eq 1 ]]; then
    FAIL=$((FAIL + 1))
    return
  fi
  echo "PASS: $description"
  PASS=$((PASS + 1))
}

write_bytes() {
  local path="$1" count="$2"
  mkdir -p "$(dirname "$path")"
  head -c "$count" /dev/zero | tr '\0' 'a' > "$path"
}

echo "=== Large Read Gate Tests ==="

REPO="$WORK/repo"
BIG="$REPO/big.md"
AT_LIMIT="$REPO/at-limit.md"
BINARY="$REPO/blob.bin"
MISSING="$REPO/missing.md"
write_bytes "$BIG" 20001
write_bytes "$AT_LIMIT" 20000
{ printf 'a\0b'; head -c 20001 /dev/zero | tr '\0' 'a'; } > "$BINARY"
BIG_BYTES=20001
SUB_BIG="$REPO/docs/big.md"
write_bytes "$SUB_BIG" 20001

test_case "refuses a whole Read of a large file" \
  2 "$(refusal "$BIG" "$BIG_BYTES" 20000 "$READ_HINT")" "$(read_input "$BIG")"
test_case "refuses whatever the session's agent_type" \
  2 "$(refusal "$BIG" "$BIG_BYTES" 20000 "$READ_HINT")" "$(read_input "$BIG" '{"agent_type": "workflow:senior-engineer"}')"
test_case "allows a sub-agent" \
  0 "" "$(read_input "$BIG" '{"agent_id": "sub-1", "agent_type": "workflow:implementer"}')"
test_case "allows a Read with an offset" \
  0 "" "$(read_input "$BIG" '{"tool_input": {"offset": 100}}')"
test_case "allows a Read with a limit" \
  0 "" "$(read_input "$BIG" '{"tool_input": {"limit": 50}}')"
test_case "allows a file at the limit" \
  0 "" "$(read_input "$AT_LIMIT")"
test_case "allows a binary file" \
  0 "" "$(read_input "$BINARY")"
test_case "allows a missing file" \
  0 "" "$(read_input "$MISSING")"
test_case "allows input that is not JSON" \
  0 "" "not json"
test_case "a limit of 0 turns the gate off" \
  0 "" "$(read_input "$BIG")" LARGE_READ_GATE_MAX_BYTES=0
test_case "a lower limit refuses a smaller file" \
  2 "$(refusal "$AT_LIMIT" 20000 100 "$READ_HINT")" "$(read_input "$AT_LIMIT")" LARGE_READ_GATE_MAX_BYTES=100
test_case "a limit that is not a number falls back to the default" \
  2 "$(refusal "$BIG" "$BIG_BYTES" 20000 "$READ_HINT")" "$(read_input "$BIG")" LARGE_READ_GATE_MAX_BYTES=lots
test_case "a limit of more than 15 digits falls back to the default" \
  2 "$(refusal "$BIG" "$BIG_BYTES" 20000 "$READ_HINT")" "$(read_input "$BIG")" LARGE_READ_GATE_MAX_BYTES=99999999999999999999

ln -s big.md "$REPO/link-to-big.md"
ln -s at-limit.md "$REPO/link-to-small.md"
ln -s missing.md "$REPO/dangling.md"
test_case "refuses a Read through a symlink to a large file" \
  2 "$(refusal "$REPO/link-to-big.md" "$BIG_BYTES" 20000 "$READ_HINT")" "$(read_input "$REPO/link-to-big.md")"
test_case "allows a Read through a symlink to a small file" \
  0 "" "$(read_input "$REPO/link-to-small.md")"
test_case "allows a Read through a dangling symlink" \
  0 "" "$(read_input "$REPO/dangling.md")"

test_case "refuses cat of a large file" \
  2 "$(refusal "$BIG" "$BIG_BYTES" 20000 "$SHELL_HINT")" "$(shell_input "cat big.md")"
test_case "refuses cat with an option" \
  2 "$(refusal "$BIG" "$BIG_BYTES" 20000 "$SHELL_HINT")" "$(shell_input "cat -n big.md")"
test_case "refuses cat after cd into the file's directory" \
  2 "$(refusal "$SUB_BIG" "$BIG_BYTES" 20000 "$SHELL_HINT")" "$(shell_input "cd docs && cat big.md")"
test_case "refuses less of a large file by absolute path" \
  2 "$(refusal "$BIG" "$BIG_BYTES" 20000 "$SHELL_HINT")" "$(shell_input "less $BIG")"
test_case "refuses cat whose stderr only is redirected" \
  2 "$(refusal "$BIG" "$BIG_BYTES" 20000 "$SHELL_HINT")" "$(shell_input "cat big.md 2>/dev/null")"
test_case "refuses cat through a symlink to a large file" \
  2 "$(refusal "$REPO/link-to-big.md" "$BIG_BYTES" 20000 "$SHELL_HINT")" "$(shell_input "cat link-to-big.md")"
test_case "allows cat through a symlink to a small file" \
  0 "" "$(shell_input "cat link-to-small.md")"
test_case "allows cat through a dangling symlink" \
  0 "" "$(shell_input "cat dangling.md")"
test_case "allows a sub-agent's cat" \
  0 "" "$(shell_input "cat big.md" '{"agent_id": "sub-1"}')"
test_case "allows cat piped into head" \
  0 "" "$(shell_input "cat big.md | head -n 20")"
test_case "allows cat with stderr folded into a pipe" \
  0 "" "$(shell_input "cat big.md 2>&1 | head -n 20")"
# Stdout sent to stderr still lands in the session's context.
test_case "refuses cat whose stdout is sent to stderr" \
  2 "$(refusal "$BIG" "$BIG_BYTES" 20000 "$SHELL_HINT")" "$(shell_input "cat big.md >&2")"
test_case "allows cat sent to a file" \
  0 "" "$(shell_input "cat big.md > copy.md")"
test_case "allows cat with both streams sent to a file" \
  0 "" "$(shell_input "cat big.md &>copy.md")"
test_case "allows cat of two files" \
  0 "" "$(shell_input "cat big.md at-limit.md")"
test_case "refuses a printer after an assignment, with the operand's ~ expanded" \
  2 "$(refusal "$BIG" "$BIG_BYTES" 20000 "$SHELL_HINT")" "$(shell_input 'LC_ALL=C cat ~/big.md')" HOME="$REPO"
test_case "allows cat of an operand holding a variable expansion" \
  0 "" "$(shell_input 'cat $REPO/big.md')"
test_case "allows cat of a glob" \
  0 "" "$(shell_input "cat *.md")"
test_case "allows cat reading stdin from a file" \
  0 "" "$(shell_input "cat < big.md")"
test_case "allows a printer inside another command's substitution" \
  0 "" "$(shell_input 'echo $(cat big.md)')"
test_case "allows head of a large file" \
  0 "" "$(shell_input "head -n 50 big.md")"
test_case "allows sed -n of a large file" \
  0 "" "$(shell_input "sed -n '1,40p' big.md")"
test_case "allows a ranged bat" \
  0 "" "$(shell_input "bat -r 1:40 big.md")"
test_case "allows a printer given an option that takes a value" \
  0 "" "$(shell_input "bat -l md big.md")"
test_case "allows a printer run through a wrapper" \
  0 "" "$(shell_input "sudo cat big.md")"
test_case "allows cat captured into a variable" \
  0 "" "$(shell_input 'body=$(cat big.md)')"
test_case "allows a command that only mentions cat" \
  0 "" "$(shell_input "echo cat big.md")"
test_case "allows cat of a small file" \
  0 "" "$(shell_input "cat at-limit.md")"
test_case "allows a command that cannot be tokenized" \
  0 "" "$(shell_input "cat 'big.md")"

STANDARDS="$WORK/launch/.claude/review-standards.md"
OTHER_CLAUDE_FILE="$WORK/launch/.claude/other.md"
write_bytes "$STANDARDS" 20001
write_bytes "$OTHER_CLAUDE_FILE" 20001
test_case "allows the user's review standards file" \
  0 "" "$(read_input "$STANDARDS")"
LINKED_STANDARDS="$WORK/linked-launch/.claude/review-standards.md"
write_bytes "$WORK/real-claude/review-standards.md" 30000
mkdir -p "$WORK/linked-launch"
ln -s "$WORK/real-claude" "$WORK/linked-launch/.claude"
test_case "allows the review standards file behind a symlinked .claude directory" \
  0 "" "$(read_input "$LINKED_STANDARDS")"
test_case "refuses another file in the same .claude directory" \
  2 "$(refusal "$OTHER_CLAUDE_FILE" "$BIG_BYTES" 20000 "$READ_HINT")" "$(read_input "$OTHER_CLAUDE_FILE")"

# The plugin's own instruction text: the hook resolves its plugin root from its own location, so a
# copy under a temporary plugin root stands in for the installed one.
PLUGIN="$WORK/plugin"
mkdir -p "$PLUGIN/hooks"
cp "$HOOK" "$PLUGIN/hooks/large-read-gate.sh"
write_bytes "$PLUGIN/skills/demo/references/big.md" 20001
write_bytes "$PLUGIN/docs/big.md" 20001
INSTALLED_HOOK="$HOOK"
HOOK="$PLUGIN/hooks/large-read-gate.sh"
test_case "allows the plugin's own skill text" \
  0 "" "$(read_input "$PLUGIN/skills/demo/references/big.md")"
test_case "refuses the plugin's other files" \
  2 "$(refusal "$PLUGIN/docs/big.md" "$BIG_BYTES" 20000 "$READ_HINT")" "$(read_input "$PLUGIN/docs/big.md")"
HOOK="$INSTALLED_HOOK"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
