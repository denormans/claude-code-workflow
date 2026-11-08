#!/bin/bash
# SessionStart hook: open a board-launched session's root under its launch title, tell that session to
# load the board protocol before it replies, then re-point this
# session's board return link at the iTerm2 session it now runs in.
# The launch title runs first and in this same script: Claude Code runs every matching hook in parallel,
# and the root has to exist before refresh-return can link it.
# iTerm2 session ids are not guaranteed to survive an iTerm2 restart or a `claude --resume` in a new tab (FLOW-433).
# Fail open and silent: this must never block or spam session start. Its only output is the board
# instruction for a board-launched session at startup.

set -uo pipefail

INPUT=$(cat)
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
  SOURCE=$(echo "$INPUT" | jq -r '.source // empty' 2>/dev/null) || SOURCE=""
else
  SESSION_ID=""
  SOURCE=""
fi

if [[ -z "$SESSION_ID" ]]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# True when $1 holds a line terminator the CLI parser will not read in a `--flag=value` token. The
# subshell pins LC_ALL=C so the match is byte-wise in every locale and leaves the caller's untouched.
has_line_terminator() (
  LC_ALL=C
  nl=$'\n'
  cr=$'\r'
  ls="$(printf '\xe2\x80\xa8')"
  ps="$(printf '\xe2\x80\xa9')"
  case "$1" in
    *"$nl"* | *"$cr"* | *"$ls"* | *"$ps"*) return 0 ;;
  esac
  return 1
)

# Only the session the board launched claims its title: a child `claude` inherits both variables but
# starts with its own session_id.
if [[ "$SOURCE" == "startup" && "${AGENT_SESSION_LAUNCH:-}" == "$SESSION_ID" && -n "${AGENT_SESSION_TITLE:-}" ]]; then
  # A one-token `--title=value` is the only form that keeps a flag-shaped title from being read as a
  # flag, but the parser reads it only for a single-line value; any other title goes as two tokens.
  if has_line_terminator "$AGENT_SESSION_TITLE"; then
    CLAUDE_CODE_SESSION_ID="$SESSION_ID" "${PLUGIN_ROOT}/bin/dashboard" session launch-title --session "$SESSION_ID" --title "$AGENT_SESSION_TITLE" >/dev/null 2>&1 || true
  else
    CLAUDE_CODE_SESSION_ID="$SESSION_ID" "${PLUGIN_ROOT}/bin/dashboard" session launch-title --session "$SESSION_ID" "--title=$AGENT_SESSION_TITLE" >/dev/null 2>&1 || true
  fi
fi

# A board-launched session, titled or not, is told to load the board protocol before it replies: the
# board started it, so the board is where its questions and approvals go.
if [[ "$SOURCE" == "startup" && "${AGENT_SESSION_LAUNCH:-}" == "$SESSION_ID" ]]; then
  board_instruction="This session was launched from the board. Never send your first response before invoking \`workflow:board\` with the Skill tool: the board is where this session posts its questions and approvals."
  jq -cn --arg context "$board_instruction" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $context}}'
fi

if [[ -z "${ITERM_SESSION_ID:-}" || -z "${CLAUDE_PROJECT_DIR:-}" ]]; then
  exit 0
fi

"${PLUGIN_ROOT}/bin/dashboard" session refresh-return --session "$SESSION_ID" --cwd "$CLAUDE_PROJECT_DIR" >/dev/null 2>&1 || true
exit 0
