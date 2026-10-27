#!/bin/bash
# PreToolUse guard (Read|Grep|Glob): the current-state researcher never sees what is planned (FLOW-449).
# It answers Architecture's questions about how the code works today, and its findings count as
# checked facts only if it could not read the plan they are checked against. So for that agent
# type — with or without an agent_id — a path with a docs/plans or .worktrees component anywhere in
# it (so every path, when the working directory is itself inside one), a path outside the session's
# working directory, a path with a .. component, a path under the user's ~/.claude (memory and
# transcripts), and a search whose root holds any of those are refused. A path is under ~/.claude
# when it is written that way, when it resolves there, or when any directory prefix of it, resolved
# through symlinks, is ~/.claude or the directory ~/.claude points to, whatever that prefix is
# called. Nothing else about ~/.claude is checked: the ~/.claude rule does not refuse a file
# elsewhere that a link inside ~/.claude points to when it is read by a path none of whose
# directory prefixes resolves to ~/.claude or its target. Every other agent passes untouched.

set -euo pipefail

GUARDED_AGENT="current-state-researcher"

main() {
  local input agent_type=""
  input=$(cat)
  if ! command -v jq >/dev/null 2>&1; then
    agent_type=$(agent_type_from_text "$input")
    if is_guarded_type "$agent_type"; then
      refuse "this call (jq is not available to check it)"
    fi
    exit 0
  fi
  if ! jq -e . >/dev/null 2>&1 <<<"$input"; then
    agent_type=$(agent_type_from_text "$input")
    if is_guarded_type "$agent_type" || [[ -z "$agent_type" && "$input" == *"$GUARDED_AGENT"* ]]; then
      refuse "this call (it could not be parsed)"
    fi
    exit 0
  fi

  agent_type=$(jq -r '.agent_type // empty' <<<"$input")
  if ! is_guarded_type "$agent_type"; then
    exit 0
  fi

  local tool cwd workspace
  tool=$(jq -r '.tool_name // empty' <<<"$input")
  cwd=$(jq -r '.cwd // empty' <<<"$input")
  workspace=$(cd "${cwd:-.}" 2>/dev/null && pwd -P) || refuse "the working directory ${cwd}"

  case "$tool" in
    Read)
      check_read "$workspace" "$(jq -r '.tool_input.file_path // empty' <<<"$input")"
      ;;
    Grep)
      check_search "$workspace" "$(jq -r '.tool_input.path // empty' <<<"$input")" \
        "$(jq -r '.tool_input.glob // empty' <<<"$input")"
      ;;
    Glob)
      check_search "$workspace" "$(jq -r '.tool_input.path // empty' <<<"$input")" \
        "$(jq -r '.tool_input.pattern // empty' <<<"$input")"
      ;;
    *)
      refuse "the ${tool:-unnamed} tool"
      ;;
  esac
  exit 0
}

agent_type_from_text() {
  local text="$1" pattern='"agent_type"[[:space:]]*:[[:space:]]*"([^"]*)"'
  if [[ "$text" =~ $pattern ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

is_guarded_type() {
  [[ "$1" == "$GUARDED_AGENT" || "$1" == *":$GUARDED_AGENT" ]]
}

check_read() {
  local workspace="$1" path="$2"
  if [[ -z "$path" ]]; then
    refuse "a Read with no path"
  fi
  if path_is_guarded "$workspace" "$path"; then
    refuse "$path"
  fi
}

# A search is refused when its root is guarded, when its root holds a guarded directory, a symlink
# to a directory or a symlink to a guarded path at any depth, when its root is an
# ancestor of ~/.claude, or when its pattern climbs out of the root.
check_search() {
  local workspace="$1" path="$2" pattern="$3" root
  if [[ "$pattern" == *..* || "$pattern" == /* || "$pattern" == '~'* \
    || "$pattern" == *docs/plans* || "$pattern" == *.worktrees* ]]; then
    refuse "the pattern ${pattern}"
  fi
  if path_is_guarded "$workspace" "${path:-.}"; then
    refuse "${path:-the working directory}"
  fi
  root=$(resolve "$workspace" "${path:-.}")
  if holds_memory "$root"; then
    refuse "a search of ${path:-the working directory}"
  fi
  if [[ -d "$root" ]] && holds_guarded "$workspace" "$root"; then
    refuse "a search of ${path:-the working directory}"
  fi
}

path_is_guarded() {
  local workspace="$1" path="$2" resolved lexical
  if [[ "$path" == '~'* || "/$path/" == */../* ]]; then
    return 0
  fi
  lexical=$(lexical_path "$workspace" "$path")
  resolved=$(resolve "$workspace" "$path")
  if has_guarded_component "$resolved" || spelled_in_memory "$lexical" || is_memory_path "$resolved"; then
    return 0
  fi
  [[ "$resolved" != "$workspace" && "$resolved" != "$workspace"/* ]]
}

# The absolute path as written, with no symlink followed.
lexical_path() {
  local workspace="$1" path="$2" lexical="$2"
  if [[ "$path" != /* ]]; then
    lexical="$workspace/$path"
  fi
  while [[ "$lexical" == *//* || "$lexical" == */./* ]]; do
    lexical=${lexical//\/\//\/}
    lexical=${lexical//\/.\//\/}
  done
  printf '%s' "$lexical"
}

is_memory_path() {
  local candidate="$1" dir
  for dir in "$(home_claude)" "$(home_claude_resolved)"; do
    if [[ "$candidate" == "$dir" || "$candidate" == "$dir"/* ]]; then
      return 0
    fi
  done
  return 1
}

# True when the path as written names ~/.claude: it is under it as written, or some directory prefix
# of it, resolved through its symlinks, is ~/.claude or the directory ~/.claude points to.
spelled_in_memory() {
  local lexical="$1" part prefix="" physical memory resolved_memory
  local -a parts
  if is_memory_path "$lexical"; then
    return 0
  fi
  memory=$(home_claude)
  resolved_memory=$(home_claude_resolved)
  IFS=/ read -r -a parts <<<"$lexical"
  for part in "${parts[@]}"; do
    if [[ -z "$part" ]]; then
      continue
    fi
    prefix="$prefix/$part"
    physical=$(cd -- "$prefix" 2>/dev/null && pwd -P) || physical=""
    if [[ -n "$physical" && ("$physical" == "$memory" || "$physical" == "$resolved_memory") ]]; then
      return 0
    fi
  done
  return 1
}

holds_memory() {
  local root="$1" dir
  for dir in "$(home_claude)" "$(home_claude_resolved)"; do
    if [[ "$dir/" == "$root"/* ]]; then
      return 0
    fi
  done
  return 1
}

has_guarded_component() {
  [[ "$1/" == */docs/plans/* || "$1/" == */.worktrees/* ]]
}

home_claude() {
  if [[ -n "${HOME:-}" && -d "$HOME" ]]; then
    printf '%s/.claude' "$(cd "$HOME" && pwd -P)"
  else
    printf '/nonexistent-home/.claude'
  fi
}

home_claude_resolved() {
  local lexical
  lexical=$(home_claude)
  if [[ -e "$lexical" ]]; then
    realpath "$lexical"
  else
    printf '%s' "$lexical"
  fi
}

holds_guarded() {
  local workspace="$1" root="$2" entry
  while IFS= read -r entry; do
    if [[ ! -L "$entry" || -d "$entry" ]] || path_is_guarded "$workspace" "$entry"; then
      return 0
    fi
  done < <(find "$root" \( -name node_modules -o -name .git \) -prune \
    -o \( -ipath '*/docs/plans' -o -iname .worktrees -o -type l \) -print 2>/dev/null)
  return 1
}

# The physical path: the deepest existing ancestor resolved through its symlinks, with whatever
# does not exist yet appended as written.
resolve() {
  local workspace="$1" path="$2" head tail=""
  if [[ "$path" != /* ]]; then
    path="$workspace/$path"
  fi
  head="$path"
  while [[ ! -e "$head" && "$head" != "/" ]]; do
    tail="/$(basename "$head")$tail"
    head=$(dirname "$head")
  done
  printf '%s%s' "$(realpath "$head")" "$tail"
}

refuse() {
  cat >&2 <<EOF
The current-state researcher may not read ${1}: it is a plan, a ticket worktree, memory or
outside the working directory, or a search that would reach one. Search a narrower directory of
source code instead, and do not look for another route to the same place. If a question cannot be
answered without it, say so in your report.
EOF
  exit 2
}

main "$@"
