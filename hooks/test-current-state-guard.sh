#!/bin/bash
# Test script for current-state-guard.sh
# Builds a throwaway workspace holding a plan, a ticket worktree, a symlink into the plan
# directory and a memory file outside the workspace, then drives the hook with Read, Grep and
# Glob calls from the guarded agent and from others.

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/current-state-guard.sh"
GUARDED="current-state-researcher"
REFUSAL="The current-state researcher may not read"
PASS=0
FAIL=0

TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
WS="$TMP/ws"
FAKE_HOME="$TMP/home"
CALL_CWD="$WS"
mkdir -p "$WS/docs/plans" "$WS/repo/src" "$WS/repo/.worktrees/T-1-x" "$WS/repo/skills" "$WS/repo/clean" \
  "$TMP/memory" "$TMP/nojq" "$FAKE_HOME/.claude"
printf 'claude\n' >"$FAKE_HOME/.claude/CLAUDE.md"
LINKED_HOME="$TMP/linked-home"
mkdir -p "$LINKED_HOME/dotfiles/claude"
printf 'claude\n' >"$LINKED_HOME/dotfiles/claude/CLAUDE.md"
ln -s "$LINKED_HOME/dotfiles/claude" "$LINKED_HOME/.claude"
INNER_HOME="$TMP/inner-home"
mkdir -p "$INNER_HOME/.claude" "$INNER_HOME/dotfiles" "$INNER_HOME/data/projects/p1"
printf 'claude\n' >"$INNER_HOME/dotfiles/CLAUDE.md"
printf 'transcript\n' >"$INNER_HOME/data/projects/p1/t.jsonl"
ln -s "$INNER_HOME/dotfiles/CLAUDE.md" "$INNER_HOME/.claude/CLAUDE.md"
ln -s "$INNER_HOME/data/projects" "$INNER_HOME/.claude/projects"
ln -s "$TMP" "$TMP/alias"
DOT_HOME="$TMP/dot-home"
mkdir -p "$DOT_HOME/dotfiles/claude" "$DOT_HOME/elsewhere"
printf 'elsewhere\n' >"$DOT_HOME/elsewhere/C.md"
ln -s "$DOT_HOME/elsewhere/C.md" "$DOT_HOME/dotfiles/claude/CLAUDE.md"
ln -s "$DOT_HOME/dotfiles/claude" "$DOT_HOME/.claude"
NAMED_HOME="$TMP/named-home"
mkdir -p "$NAMED_HOME/.claude" "$NAMED_HOME/dotfiles" "$NAMED_HOME/src"
printf 'claude\n' >"$NAMED_HOME/dotfiles/CLAUDE.md"
ln -s "$NAMED_HOME/dotfiles/CLAUDE.md" "$NAMED_HOME/.claude/CLAUDE.md"
ln -s "$NAMED_HOME/.claude" "$NAMED_HOME/src/c"
mkdir -p "$WS/deep/a/b/c/d/e/docs/plans" "$WS/deep2/a/b/c/d/e/.worktrees/T-9-x"
printf 'plan\n' >"$WS/deep/a/b/c/d/e/docs/plans/q.md"
mkdir -p "$WS/repo/src/.claude"
printf 'settings\n' >"$WS/repo/src/.claude/settings.json"
ln -s "$WS" "$WS/repo/clean/up"
printf 'plan\n' >"$WS/docs/plans/2026-01-01-x-1-prd.md"
printf 'code\n' >"$WS/repo/src/a.ts"
printf 'wt\n' >"$WS/repo/.worktrees/T-1-x/f.ts"
printf 'skill\n' >"$WS/repo/skills/s.md"
printf 'memory\n' >"$TMP/memory/MEMORY.md"
ln -s "$WS/docs/plans/2026-01-01-x-1-prd.md" "$WS/repo/src/link.md"
ln -s "$(command -v cat)" "$TMP/nojq/cat"

call() {
  local tool="$1" agent="$2" tool_input="$3"
  jq -n --arg tool "$tool" --arg agent "$agent" --arg cwd "$CALL_CWD" --argjson input "$tool_input" \
    '{tool_name: $tool, cwd: $cwd, tool_input: $input}
     + (if $agent == "" then {} else {agent_type: $agent, agent_id: "a1"} end)'
}

read_call() {
  call Read "$2" "$(jq -n --arg p "$1" '{file_path: $p}')"
}

grep_call() {
  call Grep "$3" "$(jq -n --arg p "$1" --arg g "$2" \
    '{pattern: "x"} + (if $p == "" then {} else {path: $p} end) + (if $g == "" then {} else {glob: $g} end)')"
}

glob_call() {
  call Glob "$3" "$(jq -n --arg p "$1" --arg g "$2" '{pattern: $g} + (if $p == "" then {} else {path: $p} end)')"
}

expect() {
  local description="$1" want="$2" input="$3" path_override="${4:-}" test_home="${5:-$FAKE_HOME}" actual=0
  if [[ -n "${CASE_FILTER:-}" && "$description" != *"$CASE_FILTER"* ]]; then
    return 0
  fi
  if [[ -n "$path_override" ]]; then
    printf '%s' "$input" | HOME="$test_home" PATH="$path_override" "$BASH" "$HOOK_SCRIPT" >"$TMP/out" 2>"$TMP/err" || actual=$?
  else
    printf '%s' "$input" | HOME="$test_home" bash "$HOOK_SCRIPT" >"$TMP/out" 2>"$TMP/err" || actual=$?
  fi
  local got=allowed
  if [[ "$actual" -eq 2 ]] && grep -q -F "$REFUSAL" "$TMP/err"; then
    got=refused
  elif [[ "$actual" -ne 0 || -s "$TMP/err" ]]; then
    got="exit $actual: $(cat "$TMP/err")"
  fi
  if [[ -s "$TMP/out" ]]; then
    got="$got (unexpected stdout)"
  fi
  if [[ "$got" == "$want" ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (want $want, got $got)"
    FAIL=$((FAIL + 1))
  fi
}

# --- Refused: plans, ticket worktrees, memory, outside paths ------------------
expect "Read of a plan by relative path" refused "$(read_call docs/plans/2026-01-01-x-1-prd.md "$GUARDED")"
expect "Read of a plan by absolute path" refused "$(read_call "$WS/docs/plans/2026-01-01-x-1-prd.md" "$GUARDED")"
expect "Read inside a ticket worktree" refused "$(read_call repo/.worktrees/T-1-x/f.ts "$GUARDED")"
expect "Read through a symlink into the plans" refused "$(read_call repo/src/link.md "$GUARDED")"
expect "Read through .. into the plans" refused "$(read_call repo/src/../../docs/plans/2026-01-01-x-1-prd.md "$GUARDED")"
expect "Read of memory outside the workspace" refused "$(read_call "$TMP/memory/MEMORY.md" "$GUARDED")"
expect "Read of a home-relative path" refused "$(read_call '~/.claude/CLAUDE.md' "$GUARDED")"
expect "Read with no path" refused "$(read_call '' "$GUARDED")"
expect "bare Grep from a workspace holding plans" refused "$(grep_call '' '' "$GUARDED")"
expect "Grep of a repo holding ticket worktrees" refused "$(grep_call repo '' "$GUARDED")"
expect "Grep of a directory holding a symlink into the plans" refused "$(grep_call repo/src '' "$GUARDED")"
expect "Grep with a glob naming the plans" refused "$(grep_call repo/skills '**/docs/plans/**' "$GUARDED")"
expect "Glob pattern climbing out with .." refused "$(glob_call repo/skills '../**' "$GUARDED")"
expect "Glob pattern from an absolute root" refused "$(glob_call repo/skills '/**/*.md' "$GUARDED")"
expect "Glob of the ticket worktrees" refused "$(glob_call repo/.worktrees '**/*' "$GUARDED")"
expect "namespaced agent type is guarded too" refused "$(read_call docs/plans/2026-01-01-x-1-prd.md "workflow:$GUARDED")"
expect "no agent_id: still guarded" refused "$(read_call docs/plans/2026-01-01-x-1-prd.md "$GUARDED" | jq -c 'del(.agent_id)')"
expect "no jq, guarded agent: fails closed" refused "$(read_call repo/src/a.ts "$GUARDED")" "$TMP/nojq"
expect "unparsable input naming the agent: fails closed" refused "{\"agent_type\":\"$GUARDED\""
expect "Read of a missing path climbing out with .." refused "$(read_call repo/nosuch/../../../memory/MEMORY.md "$GUARDED")"
expect "Grep of a directory holding a symlink to a directory" refused "$(grep_call repo/clean '' "$GUARDED")"
expect "Read under the home .claude directory" refused "$(CALL_CWD="$FAKE_HOME"; read_call .claude/CLAUDE.md "$GUARDED")"
expect "Grep from a home working directory" refused "$(CALL_CWD="$FAKE_HOME"; grep_call '' '' "$GUARDED")"
expect "Read from a working directory inside a ticket worktree" refused "$(CALL_CWD="$WS/repo/.worktrees/T-1-x"; read_call f.ts "$GUARDED")"
expect "Read from a docs working directory reaching plans" refused "$(CALL_CWD="$WS/docs"; read_call plans/2026-01-01-x-1-prd.md "$GUARDED")"
expect "Read through a linked home .claude" refused "$(CALL_CWD="$LINKED_HOME"; read_call .claude/CLAUDE.md "$GUARDED")" "" "$LINKED_HOME"
expect "Read of the target of a linked home .claude" refused "$(CALL_CWD="$LINKED_HOME"; read_call dotfiles/claude/CLAUDE.md "$GUARDED")" "" "$LINKED_HOME"
expect "Grep of the directory holding a linked home .claude" refused "$(CALL_CWD="$LINKED_HOME"; grep_call dotfiles '' "$GUARDED")" "" "$LINKED_HOME"
expect "Read of a linked file inside the home .claude" refused "$(CALL_CWD="$INNER_HOME"; read_call .claude/CLAUDE.md "$GUARDED")" "" "$INNER_HOME"
expect "Read of a linked subdirectory inside the home .claude" refused "$(CALL_CWD="$INNER_HOME"; read_call .claude/projects/p1/t.jsonl "$GUARDED")" "" "$INNER_HOME"
expect "Read of a path with a .. component staying inside" refused "$(CALL_CWD="$WS/repo"; read_call src/../src/a.ts "$GUARDED")"
expect "Read via a symlinked home ancestor" refused "$(CALL_CWD="$INNER_HOME"; read_call "$TMP/alias/inner-home/.claude/CLAUDE.md" "$GUARDED")" "" "$INNER_HOME"
expect "memory via symlinked home ancestor, home given aliased" refused "$(CALL_CWD="$INNER_HOME"; read_call "$INNER_HOME/.claude/CLAUDE.md" "$GUARDED")" "" "$TMP/alias/inner-home"
expect "Grep of a linked subdirectory via a symlinked home ancestor" refused "$(CALL_CWD="$INNER_HOME"; grep_call "$TMP/alias/inner-home/.claude/projects" '' "$GUARDED")" "" "$INNER_HOME"
expect "linked .claude target spelled through a symlinked ancestor" refused "$(CALL_CWD="$DOT_HOME"; read_call "$TMP/alias/dot-home/dotfiles/claude/CLAUDE.md" "$GUARDED")" "" "$DOT_HOME"
expect "path through a link to .claude under another name" refused "$(CALL_CWD="$NAMED_HOME"; read_call src/c/CLAUDE.md "$GUARDED")" "" "$NAMED_HOME"
expect "Grep of a root holding docs/plans deeper than four levels" refused "$(grep_call deep '' "$GUARDED")"
expect "Grep of a root holding .worktrees deeper than four levels" refused "$(grep_call deep2 '' "$GUARDED")"
expect "no jq, unparsable input naming the agent type: fails closed" refused "{\"agent_type\":\"workflow:$GUARDED\"" "$TMP/nojq"

# --- Allowed: source code, and every other agent -------------------------------
expect "Read of source code" allowed "$(read_call repo/src/a.ts "$GUARDED")"
expect "Read of a file that does not exist yet" allowed "$(read_call repo/src/missing.ts "$GUARDED")"
expect "Grep of a clean subdirectory" allowed "$(grep_call repo/skills '*.md' "$GUARDED")"
expect "Glob of a clean subdirectory" allowed "$(glob_call repo/skills '**/*.md' "$GUARDED")"
expect "the ordinary researcher reads plans" allowed "$(read_call docs/plans/2026-01-01-x-1-prd.md workflow:researcher)"
expect "the main session reads plans" allowed "$(read_call docs/plans/2026-01-01-x-1-prd.md '')"
expect "Read of the target of a link inside the home .claude" allowed "$(CALL_CWD="$INNER_HOME"; read_call dotfiles/CLAUDE.md "$GUARDED")" "" "$INNER_HOME"
expect "Read of a repo's own .claude directory" allowed "$(read_call repo/src/.claude/settings.json "$GUARDED")"
expect "no jq, other agent: allowed" allowed "$(read_call docs/plans/2026-01-01-x-1-prd.md workflow:researcher)" "$TMP/nojq"
expect "no jq, main session reads the agent's own file" allowed "$(read_call repo/src/a.ts '' | jq -c '.tool_input.file_path = "agents/current-state-researcher.md"')" "$TMP/nojq"

if [[ -n "${CASE_FILTER:-}" && $((PASS + FAIL)) -eq 0 ]]; then
  echo "FAIL: no case matches CASE_FILTER=$CASE_FILTER"
  exit 1
fi
echo
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
