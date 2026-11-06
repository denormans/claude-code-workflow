#!/bin/bash
# Test script for tools/agent-session-handler
# Part 1 drives find-live-session.py against a temporary sessions dir (needs python3).
# Part 2 compiles handler.applescript, loads it as a script and drives parseAgentURL, the part of the
# applet that needs no iTerm2 or GUI (needs osascript). Each part skips cleanly when its tool is absent.
# HANDLER_SCRIPT overrides the AppleScript source.

set -uo pipefail

HANDLER_DIR="$(cd "$(dirname "$0")/.." && pwd)/tools/agent-session-handler"
HANDLER_SCRIPT="${HANDLER_SCRIPT:-$HANDLER_DIR/handler.applescript}"
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

CAP_OUT="$TMP_ROOT/cap.out"
CAP_ERR="$TMP_ROOT/cap.err"
CAP_EXP="$TMP_ROOT/cap.expected"

# Runs "$@" with stdout and stderr in files and its exit status in CAP_RC.
capture() {
  "$@" >"$CAP_OUT" 2>"$CAP_ERR"
  CAP_RC=$?
}

# The command exits 0 and writes nothing, on either stream.
expect_silent() {
  local label="$1"
  shift
  capture "$@"
  check "$label: exits 0" "0" "$CAP_RC"
  [ ! -s "$CAP_OUT" ]
  check "$label: stdout is empty" "0" "$?"
  [ ! -s "$CAP_ERR" ]
  check "$label: stderr is empty" "0" "$?"
}

# The command exits 0, stdout is exactly "<expected>\n", and stderr is empty.
expect_line() {
  local label="$1" expected="$2"
  shift 2
  capture "$@"
  check "$label: exits 0" "0" "$CAP_RC"
  printf '%s\n' "$expected" > "$CAP_EXP"
  cmp -s "$CAP_OUT" "$CAP_EXP"
  check "$label: stdout is exactly the expected line" "0" "$?"
  [ ! -s "$CAP_ERR" ]
  check "$label: stderr is empty" "0" "$?"
}

# The command exits 0, stdout is exactly "<pid>\t<tty>\n" for the pid given, and stderr is empty.
expect_found() {
  local label="$1" expected_pid="$2"
  shift 2
  capture "$@"
  check "$label: exits 0" "0" "$CAP_RC"
  [[ "$(cat "$CAP_OUT")" =~ ^${expected_pid}$'\t'[^$'\t'$'\n']*$ ]]
  check "$label: stdout is the pid and one tty column" "0" "$?"
  [ "$(wc -l < "$CAP_OUT" | tr -d ' ')" = "1" ]
  check "$label: stdout is one line" "0" "$?"
  [ ! -s "$CAP_ERR" ]
  check "$label: stderr is empty" "0" "$?"
}

# The command exits with <rc>, writes nothing to stdout, and writes exactly "<message>\n" to stderr.
expect_failure() {
  local label="$1" expected_rc="$2" message="$3"
  shift 3
  capture "$@"
  check "$label: exits $expected_rc" "$expected_rc" "$CAP_RC"
  [ ! -s "$CAP_OUT" ]
  check "$label: stdout is empty" "0" "$?"
  printf '%s\n' "$message" > "$CAP_EXP"
  cmp -s "$CAP_ERR" "$CAP_EXP"
  check "$label: stderr is exactly the reason" "0" "$?"
}

# --- Part 1: find-live-session.py ---------------------------------------------
if command -v python3 >/dev/null 2>&1; then
  SESSIONS="$TMP_ROOT/sessions"
  mkdir -p "$SESSIONS"
  sleep 0 &
  DEAD_PID=$!
  wait "$DEAD_PID"
  printf '{"pid": %s, "sessionId": "live-id"}' "$$" > "$SESSIONS/$$.json"
  printf '{"pid": %s, "sessionId": "dead-id"}' "$DEAD_PID" > "$SESSIONS/$DEAD_PID.json"
  GARBAGE="$TMP_ROOT/garbage"
  NOPID="$TMP_ROOT/no-pid"
  NONOBJECT="$TMP_ROOT/non-object"
  mkdir -p "$GARBAGE" "$NOPID" "$NONOBJECT"
  printf 'not json' > "$GARBAGE/garbage.json"
  printf '{"sessionId": "no-pid-id"}' > "$NOPID/no-pid.json"
  printf '[1, 2]' > "$NONOBJECT/array.json"
  printf '{"pid": %s}' "$$" > "$NONOBJECT/b-no-session-id.json"
  printf '{"pid": %s, "sessionId": "live-id"}' "$$" > "$NONOBJECT/c-live.json"

  if [ -x /usr/bin/python3 ]; then
    PYTHON3=/usr/bin/python3
  else
    PYTHON3="$(command -v python3)"
  fi
  find_live() {
    PATH="${FIND_PATH:-$PATH}" AGENT_SESSION_SESSIONS_DIR="${2:-$SESSIONS}" "$PYTHON3" -I "$HANDLER_DIR/find-live-session.py" "$1"
  }

  expect_found "live pid" "$$" find_live live-id
  expect_silent "dead pid: nothing found" find_live dead-id
  expect_silent "unknown session id: nothing found" find_live other-id
  expect_silent "missing sessions dir: nothing found" find_live live-id "$TMP_ROOT/absent"
  expect_failure "a file naming the session without a pid is unknown" 2 "$NOPID/no-pid.json names the session without a usable pid" find_live no-pid-id "$NOPID"
  expect_failure "a file that is not valid JSON is unknown" 2 "$GARBAGE/garbage.json is not valid JSON" find_live live-id "$GARBAGE"
  expect_found "valid JSON that is not a record of the session is skipped" "$$" find_live live-id "$NONOBJECT"

  VANISHED="$TMP_ROOT/vanished"
  mkdir -p "$VANISHED"
  ln -s "$TMP_ROOT/no-such-target" "$VANISHED/a-vanished.json"
  expect_silent "a session file that vanishes before it is read is skipped" find_live live-id "$VANISHED"
  printf '{"pid": %s, "sessionId": "live-id"}' "$$" > "$VANISHED/b-live.json"
  expect_found "a live record after a vanished file is still found" "$$" find_live live-id "$VANISHED"

  PS_START="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$$" | tr -s ' ')"
  MIXED="$TMP_ROOT/mixed"
  mkdir -p "$MIXED"
  printf '{"pid": %s, "sessionId": "shared-id"}' "$DEAD_PID" > "$MIXED/a-dead.json"
  printf '{"pid": %s, "sessionId": "shared-id", "procStart": "%s"}' "$$" "$PS_START" > "$MIXED/b-live.json"
  expect_found "a dead match before a live one does not hide it" "$$" find_live shared-id "$MIXED"

  if [[ "$(id -u)" != "0" ]]; then
    UNREADABLE="$TMP_ROOT/unreadable"
    mkdir -p "$UNREADABLE"
    printf '{"pid": 1, "sessionId": "live-id"}' > "$UNREADABLE/a-unreadable.json"
    chmod 000 "$UNREADABLE/a-unreadable.json"
    printf '{"pid": %s, "sessionId": "live-id"}' "$$" > "$UNREADABLE/b-live.json"
    expect_failure "an unreadable session file is unknown, not skipped" 2 "cannot read $UNREADABLE/a-unreadable.json: Permission denied" find_live live-id "$UNREADABLE"
  else
    echo "SKIP: unreadable-file case needs a non-root user (root ignores mode bits)"
  fi

  PROC="$TMP_ROOT/procstart"
  mkdir -p "$PROC"
  printf '{"pid": %s, "sessionId": "mismatch-id", "procStart": "Mon Jan  1 00:00:00 2001"}' "$$" > "$PROC/mismatch.json"
  printf '{"pid": %s, "sessionId": "match-id", "procStart": "%s"}' "$$" "$PS_START" > "$PROC/match.json"
  expect_silent "a live pid whose procStart differs is not the session" find_live mismatch-id "$PROC"
  expect_found "a live pid whose procStart matches is found" "$$" find_live match-id "$PROC"

  locale -a >"$TMP_ROOT/locales" 2>/dev/null
  if grep -qx 'de_DE.UTF-8' "$TMP_ROOT/locales"; then
    LOCALE_DIR="$TMP_ROOT/locale"
    mkdir -p "$LOCALE_DIR"
    printf '{"pid": %s, "sessionId": "locale-id", "procStart": "%s"}' "$$" "$PS_START" > "$LOCALE_DIR/locale.json"
    LC_ALL=de_DE.UTF-8 expect_found "procStart is compared as ps prints it under LC_ALL=C, whatever the caller's locale" "$$" find_live locale-id "$LOCALE_DIR"
  else
    echo "SKIP: de_DE.UTF-8 locale not installed (procStart locale case)"
  fi

  NOT_A_DIR="$TMP_ROOT/not-a-dir"
  : > "$NOT_A_DIR"
  expect_failure "a sessions path that cannot be listed is unknown" 2 "cannot list $NOT_A_DIR: Not a directory" find_live live-id "$NOT_A_DIR"

  PS_FAILS="$TMP_ROOT/ps-fails"
  PS_GONE="$TMP_ROOT/ps-gone"
  PS_ABSENT="$TMP_ROOT/ps-absent"
  PS_GONE_ERR="$TMP_ROOT/ps-gone-err"
  PS_GONE_OUT="$TMP_ROOT/ps-gone-out"
  mkdir -p "$PS_FAILS" "$PS_GONE" "$PS_ABSENT" "$PS_GONE_ERR" "$PS_GONE_OUT"
  printf '#!/bin/sh\necho "ps: boom" >&2\nexit 2\n' > "$PS_FAILS/ps"
  printf '#!/bin/sh\nexit 1\n' > "$PS_GONE/ps"
  printf '#!/bin/sh\necho "ps: odd" >&2\nexit 1\n' > "$PS_GONE_ERR/ps"
  printf '#!/bin/sh\necho 123\nexit 1\n' > "$PS_GONE_OUT/ps"
  chmod +x "$PS_FAILS/ps" "$PS_GONE/ps" "$PS_GONE_ERR/ps" "$PS_GONE_OUT/ps"
  FIND_PATH="$PS_FAILS" expect_failure "a ps that fails is unknown" 2 "ps failed for pid $$ (exit 2): ps: boom" find_live live-id
  FIND_PATH="$PS_ABSENT" expect_failure "a ps that cannot run is unknown" 2 "cannot run ps: No such file or directory" find_live live-id
  FIND_PATH="$PS_GONE_ERR" expect_failure "a ps that exits 1 with an error message is unknown, not gone" 2 "ps failed for pid $$ (exit 1): ps: odd" find_live live-id
  FIND_PATH="$PS_GONE_OUT" expect_failure "a ps that exits 1 with output is unknown, not gone" 2 "ps failed for pid $$ (exit 1): " find_live live-id
  FIND_PATH="$PS_GONE" expect_silent "a pid that ps reports as gone is not live" find_live live-id

  PROJECTS="$TMP_ROOT/projects"
  RESUME_DIR="$TMP_ROOT/proj dir-1"
  OTHER_DIR="$TMP_ROOT/other"
  PLANTED_DIR="$TMP_ROOT/planted"
  mkdir -p "$RESUME_DIR" "$OTHER_DIR" "$PLANTED_DIR"
  ID_OK="aaaaaaaa-0000-4000-8000-000000000001"
  ID_ABSENT="aaaaaaaa-0000-4000-8000-000000000004"
  ID_FORK="aaaaaaaa-0000-4000-8000-000000000006"
  ID_LONG="aaaaaaaa-0000-4000-8000-000000000007"
  RESUME_FOLDER="$(printf '%s' "$RESUME_DIR" | sed 's/[^A-Za-z0-9]/-/g')"
  OTHER_FOLDER="$(printf '%s' "$OTHER_DIR" | sed 's/[^A-Za-z0-9]/-/g')"
  A199="$(printf 'a%.0s' $(seq 1 199))"
  mkdir -p "$PROJECTS/$RESUME_FOLDER" "$PROJECTS/$OTHER_FOLDER" "$PROJECTS/-unrelated" "$PROJECTS/-$A199"
  printf '{"type":"user","cwd":"/somewhere/else/entirely"}\n' > "$PROJECTS/$RESUME_FOLDER/$ID_OK.jsonl"
  : > "$PROJECTS/$RESUME_FOLDER/$ID_FORK.jsonl"
  : > "$PROJECTS/$OTHER_FOLDER/$ID_FORK.jsonl"
  : > "$PROJECTS/-$A199/$ID_LONG.jsonl"

  resume_dir_check() {
    AGENT_SESSION_PROJECTS_DIR="${3:-$PROJECTS}" "$PYTHON3" -I "$HANDLER_DIR/check-resume-dir.py" "$1" "$2"
  }
  NOT_FILED="the session's transcript is not filed under that directory"
  expect_silent "a directory whose project folder holds the transcript is accepted, whatever cwd the transcript records" resume_dir_check "$ID_OK" "$RESUME_DIR"
  expect_line "a planted directory is refused" "$NOT_FILED" resume_dir_check "$ID_OK" "$PLANTED_DIR"
  expect_line "another real project's directory is refused for this session" "$NOT_FILED" resume_dir_check "$ID_OK" "$OTHER_DIR"
  expect_line "a session with no transcript is refused" "no transcript was found for that session" resume_dir_check "$ID_ABSENT" "$RESUME_DIR"
  expect_silent "a forked session is accepted from its first project folder" resume_dir_check "$ID_FORK" "$OTHER_DIR"
  expect_silent "a forked session is accepted from its second project folder" resume_dir_check "$ID_FORK" "$RESUME_DIR"
  expect_line "a forked session is refused from a third directory" "$NOT_FILED" resume_dir_check "$ID_FORK" "$PLANTED_DIR"
  expect_line "a projects folder that cannot be read is refused" "cannot read $NOT_A_DIR: Not a directory" resume_dir_check "$ID_OK" "$RESUME_DIR" "$NOT_A_DIR"
  expect_silent "a directory that encodes to the same folder name is accepted (the encoding is lossy)" resume_dir_check "$ID_OK" "${RESUME_DIR/ /-}"
  expect_line "a directory with a non-ASCII character is refused" "the directory has a non-ASCII character, so its project folder name is not known" resume_dir_check "$ID_OK" "$TMP_ROOT/café"
  expect_silent "a directory whose encoded name is exactly 200 characters is looked up" resume_dir_check "$ID_LONG" "/$A199"
  expect_line "a directory whose encoded name is 201 characters is refused" "the directory's project folder name is longer than 200 characters, so it is not known" resume_dir_check "$ID_LONG" "/${A199}a"

  if [[ "$(id -u)" != "0" ]]; then
    LOCKED_PROJECTS="$TMP_ROOT/locked-projects"
    mkdir -p "$LOCKED_PROJECTS/locked"
    : > "$LOCKED_PROJECTS/locked/$ID_OK.jsonl"
    chmod 000 "$LOCKED_PROJECTS/locked"
    expect_line "a project folder that cannot be searched is a read failure, not a missing transcript" "cannot read $LOCKED_PROJECTS/locked/$ID_OK.jsonl: Permission denied" resume_dir_check "$ID_OK" "$RESUME_DIR" "$LOCKED_PROJECTS"
    chmod 755 "$LOCKED_PROJECTS/locked"
  else
    echo "SKIP: unsearchable-folder case needs a non-root user (root ignores mode bits)"
  fi

  validate() {
    "$PYTHON3" -I "$HANDLER_DIR/validate-link.py" "$@"
  }
  GOOD_ITERM="FE3D8603-0F98-49DC-8E4D-B13BA170D3BA"
  GOOD_CLAUDE="4b3e4f28-49ff-4bef-8291-224c904879a1"
  expect_silent "valid ids and an existing directory are accepted" validate "$GOOD_ITERM" "$GOOD_CLAUDE" "$TMP_ROOT"
  expect_line "a control character in the directory is refused" "the directory contains a control character" validate "$GOOD_ITERM" "$GOOD_CLAUDE" $'/tmp\x15touch /tmp/pwned'
  expect_line "a newline in the directory is refused" "the directory contains a control character" validate "$GOOD_ITERM" "$GOOD_CLAUDE" $'/tmp\necho'
  expect_line "a tab in the directory is refused" "the directory contains a control character" validate "$GOOD_ITERM" "$GOOD_CLAUDE" $'/tmp\tx'
  expect_line "DEL in the directory is refused" "the directory contains a control character" validate "$GOOD_ITERM" "$GOOD_CLAUDE" $'/tmp\x7fx'
  expect_line "a link without a Claude id is refused" "the link names no Claude session" validate "$GOOD_ITERM" "" "relative/nope"
  expect_line "a link without a Claude id is refused even with a good directory" "the link names no Claude session" validate "$GOOD_ITERM" "" "$TMP_ROOT"
  expect_line "a Claude id that is not a UUID is refused" "the Claude session id is not a UUID" validate "$GOOD_ITERM" "abc" "$TMP_ROOT"
  expect_line "an iTerm2 id that is not a UUID is refused" "the iTerm2 session id is not a UUID" validate "AB-12" "$GOOD_CLAUDE" "$TMP_ROOT"
  expect_line "a relative directory is refused" "the directory is not an existing absolute path" validate "$GOOD_ITERM" "$GOOD_CLAUDE" "relative/dir"
  expect_line "a missing directory is refused" "the directory is not an existing absolute path" validate "$GOOD_ITERM" "$GOOD_CLAUDE" "$TMP_ROOT/absent"

  # --- launch-link.py ---
  file_mode() {
    python3 -I -c 'import os,stat,sys;print(format(stat.S_IMODE(os.lstat(sys.argv[1]).st_mode),"o"))' "$1"
  }
  LAUNCH_KEY_HEX="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  LAUNCH_CONFIG="$TMP_ROOT/launch-config"
  mkdir -p "$LAUNCH_CONFIG"
  printf '%s\n' "$LAUNCH_KEY_HEX" > "$LAUNCH_CONFIG/launch-key"
  chmod 600 "$LAUNCH_CONFIG/launch-key"
  NO_CONFIG="$TMP_ROOT/no-config"
  launch_link() {
    AGENT_SESSION_CONFIG_DIR="${LINK_CONFIG:-$LAUNCH_CONFIG}" TMPDIR="${LINK_TMPDIR:-$TMP_ROOT}" "$PYTHON3" -I "$HANDLER_DIR/launch-link.py" "$@"
  }
  # Signs as the board does: HMAC-SHA256 keyed by the hex-decoded key, over the context line and the
  # fields, joined by newlines.
  sign() {
    python3 -I -c 'import hashlib,hmac,sys;print(hmac.new(bytes.fromhex(sys.argv[1]),"\n".join(["agent-session-launch-v1"]+sys.argv[2:]).encode(),hashlib.sha256).hexdigest())' "$LAUNCH_KEY_HEX" "$@"
  }
  LAUNCH_SESSION="5d9b3c1e-2f4a-4b6c-8d7e-9f0a1b2c3d4e"
  MULTILINE_PROMPT=$'/workflow:jtbd start here\n\tsecond line with "quotes" and $HOME\n'
  A200="$(printf 'a%.0s' $(seq 1 200))"
  PROMPT_MAX="$(head -c 32768 /dev/zero | tr '\0' b)"

  expect_silent "a launch link with a session, directory, title and multi-line prompt is accepted" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "My title" "$MULTILINE_PROMPT"
  expect_silent "a launch link with no title is accepted" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "" "hi"
  expect_silent "a title of exactly 200 characters is accepted" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "$A200" "hi"
  expect_silent "a prompt of exactly 32 KiB is accepted" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "" "$PROMPT_MAX"
  expect_line "a launch session id that is not a UUID is refused" "the session id is not a UUID" launch_link validate "abc" "$TMP_ROOT" "" "hi"
  expect_line "a launch directory that does not exist is refused" "the directory is not an existing absolute path" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT/absent" "" "hi"
  expect_line "a relative launch directory is refused" "the directory is not an existing absolute path" launch_link validate "$LAUNCH_SESSION" "relative" "" "hi"
  expect_line "a control character in the launch directory is refused" "the directory contains a control character" launch_link validate "$LAUNCH_SESSION" $'/tmp\x15x' "" "hi"
  expect_line "a newline in the title is refused" "the title contains a control character" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" $'a\nb' "hi"
  expect_line "a carriage return in the prompt is refused" "the prompt contains a control character other than tab or newline" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "" $'a\rb'
  expect_line "an escape sequence in the prompt is refused" "the prompt contains a control character other than tab or newline" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "" $'a\x1b[2Jb'
  expect_line "an empty prompt is refused" "the link has no prompt" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "" ""
  expect_line "a C1 control character in the title is refused" "the title contains a control character" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "$(printf 't\xc2\x9bx')" "hi"
  expect_line "a tag character in the prompt is refused, naming its code point" "the prompt contains an invisible character (U+E0052)" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "" "hi $(printf '\xf3\xa0\x81\x92')"
  expect_line "a bidi override in the title is refused, naming its code point" "the title contains an invisible character (U+202E)" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "$(printf 'a\xe2\x80\xaeb')" "hi"
  expect_line "a zero-width joiner in the directory is refused" "the directory contains an invisible character (U+200D)" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT$(printf '\xe2\x80\x8d')" "" "hi"
  expect_line "a line separator in the title is refused" "the title contains an invisible character (U+2028)" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "$(printf 'a\xe2\x80\xa8b')" "hi"
  expect_line "a variation selector from the supplement in the prompt is refused" "the prompt contains an invisible character (U+E0100)" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "" "hi $(printf '\xf3\xa0\x84\x80')"
  expect_line "a format character added after Unicode 14 in the prompt is refused" "the prompt contains an invisible character (U+13439)" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "" "hi $(printf '\xf0\x93\x90\xb9')"
  expect_line "an Arabic format character in the title is refused" "the title contains an invisible character (U+0890)" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "$(printf 'a\xe0\xa2\x90b')" "hi"
  expect_line "a Hangul filler in the title is refused" "the title contains an invisible character (U+3164)" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "$(printf 'a\xe3\x85\xa4b')" "hi"
  expect_line "a variation selector in the directory is refused" "the directory contains an invisible character (U+FE0F)" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT$(printf '\xef\xb8\x8f')" "" "hi"
  expect_silent "an emoji with a presentation selector in the prompt is accepted" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "" "$(printf 'ok \xe2\x9d\xa4\xef\xb8\x8f')"
  expect_silent "a zero-width joiner emoji sequence in the prompt and title is accepted" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "$(printf '\xf0\x9f\x91\xa8\xe2\x80\x8d\xf0\x9f\x91\xa9')" "$(printf '\xf0\x9f\x91\xa8\xe2\x80\x8d\xf0\x9f\x91\xa9')"
  expect_line "a whitespace-only prompt is refused" "the link has no prompt" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "" $' \n\t'
  expect_line "a title over 200 characters is refused" "the title is longer than 200 characters" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "${A200}a" "hi"
  expect_line "a prompt over 32 KiB is refused" "the prompt is longer than 32 KiB" launch_link validate "$LAUNCH_SESSION" "$TMP_ROOT" "" "${PROMPT_MAX}b"

  NOW="$(date +%s)"
  FRESH_EXP="$((NOW + 60))"
  GOOD_SIG="$(sign "$LAUNCH_SESSION" "$FRESH_EXP" "$TMP_ROOT" "My title" "$MULTILINE_PROMPT")"
  verify_fresh() {
    launch_link verify "$LAUNCH_SESSION" "$FRESH_EXP" "$TMP_ROOT" "My title" "$MULTILINE_PROMPT" "$1"
  }
  expect_line "a link the board signed, before it expires, is signed" "signed" verify_fresh "$GOOD_SIG"
  expect_line "a changed prompt is unsigned" "unsigned" launch_link verify "$LAUNCH_SESSION" "$FRESH_EXP" "$TMP_ROOT" "My title" "${MULTILINE_PROMPT}x" "$GOOD_SIG"
  expect_line "a changed directory is unsigned" "unsigned" launch_link verify "$LAUNCH_SESSION" "$FRESH_EXP" "/" "My title" "$MULTILINE_PROMPT" "$GOOD_SIG"
  expect_line "a changed title is unsigned" "unsigned" launch_link verify "$LAUNCH_SESSION" "$FRESH_EXP" "$TMP_ROOT" "Other" "$MULTILINE_PROMPT" "$GOOD_SIG"
  expect_line "a changed session id is unsigned" "unsigned" launch_link verify "5d9b3c1e-2f4a-4b6c-8d7e-9f0a1b2c3d4f" "$FRESH_EXP" "$TMP_ROOT" "My title" "$MULTILINE_PROMPT" "$GOOD_SIG"
  expect_line "a changed expiry is unsigned" "unsigned" launch_link verify "$LAUNCH_SESSION" "$((FRESH_EXP + 1))" "$TMP_ROOT" "My title" "$MULTILINE_PROMPT" "$GOOD_SIG"
  expect_line "a missing signature is unsigned" "unsigned" verify_fresh ""
  expect_line "an uppercase signature is unsigned" "unsigned" verify_fresh "$(printf '%s' "$GOOD_SIG" | tr a-f A-F)"
  expect_line "a non-ASCII signature is unsigned" "unsigned" verify_fresh "$(printf '\xc3\xa9')$GOOD_SIG"
  PAST_EXP="$((NOW - 1))"
  expect_line "a signed link past its expiry is expired" "expired" launch_link verify "$LAUNCH_SESSION" "$PAST_EXP" "$TMP_ROOT" "" "hi" "$(sign "$LAUNCH_SESSION" "$PAST_EXP" "$TMP_ROOT" "" "hi")"
  FAR_EXP="$((NOW + 600))"
  expect_line "a signed link expiring more than 150 s ahead is expired" "expired" launch_link verify "$LAUNCH_SESSION" "$FAR_EXP" "$TMP_ROOT" "" "hi" "$(sign "$LAUNCH_SESSION" "$FAR_EXP" "$TMP_ROOT" "" "hi")"
  expect_line "a signed link whose expiry is not a number is expired" "expired" launch_link verify "$LAUNCH_SESSION" "soon" "$TMP_ROOT" "" "hi" "$(sign "$LAUNCH_SESSION" "soon" "$TMP_ROOT" "" "hi")"
  LINK_CONFIG="$NO_CONFIG" expect_line "with no launch key every link is no-key" "no-key" verify_fresh "$GOOD_SIG"
  OPEN_KEY_CONFIG="$TMP_ROOT/open-key-config"
  mkdir -p "$OPEN_KEY_CONFIG"
  printf '%s\n' "$LAUNCH_KEY_HEX" > "$OPEN_KEY_CONFIG/launch-key"
  chmod 640 "$OPEN_KEY_CONFIG/launch-key"
  LINK_CONFIG="$OPEN_KEY_CONFIG" expect_line "a launch key others can read is not trusted" "no-key" verify_fresh "$GOOD_SIG"
  BAD_KEY_CONFIG="$TMP_ROOT/bad-key-config"
  mkdir -p "$BAD_KEY_CONFIG"
  printf 'not-a-hex-key\n' > "$BAD_KEY_CONFIG/launch-key"
  chmod 600 "$BAD_KEY_CONFIG/launch-key"
  LINK_CONFIG="$BAD_KEY_CONFIG" expect_line "a malformed launch key is not trusted" "no-key" verify_fresh "$GOOD_SIG"
  DIR_KEY_CONFIG="$TMP_ROOT/dir-key-config"
  mkdir -p "$DIR_KEY_CONFIG/launch-key"
  LINK_CONFIG="$DIR_KEY_CONFIG" expect_line "a launch key path that is a directory is not trusted" "no-key" verify_fresh "$GOOD_SIG"

  PROMPT_TMP="$TMP_ROOT/prompt-tmp"
  mkdir -p "$PROMPT_TMP"
  LINK_TMPDIR="$PROMPT_TMP" capture launch_link write-prompt "$MULTILINE_PROMPT"
  check "write-prompt exits 0" "0" "$CAP_RC"
  PROMPT_PATH="$(cat "$CAP_OUT")"
  check "the prompt file is in the agent-session folder under TMPDIR" "$PROMPT_TMP/agent-session" "$(dirname "$PROMPT_PATH")"
  printf '%s' "$MULTILINE_PROMPT" > "$CAP_EXP"
  cmp -s "$PROMPT_PATH" "$CAP_EXP"
  check "the prompt file holds the prompt byte for byte" "0" "$?"
  check "the prompt file is readable only by its owner" "600" "$(file_mode "$PROMPT_PATH")"
  check "the prompt folder is private" "700" "$(file_mode "$PROMPT_TMP/agent-session")"
  OLD_PROMPT="$PROMPT_TMP/agent-session/prompt-old.txt"
  : > "$OLD_PROMPT"
  touch -t 202001010000 "$OLD_PROMPT"
  LINK_TMPDIR="$PROMPT_TMP" capture launch_link write-prompt "again"
  [ ! -e "$OLD_PROMPT" ]
  check "a prompt file left from more than a day ago is removed" "0" "$?"
  [ -e "$PROMPT_PATH" ]
  check "a recent prompt file is kept" "0" "$?"
  SHARED_TMP="$TMP_ROOT/shared-tmp"
  mkdir -p "$SHARED_TMP/agent-session"
  chmod 777 "$SHARED_TMP/agent-session"
  LINK_TMPDIR="$SHARED_TMP" expect_failure "a prompt folder others can write to is refused" 1 "$SHARED_TMP/agent-session is not a private directory owned by this user" launch_link write-prompt "hi"

  build_launch() {
    LINK_CONFIG="${TEMPLATE_DIR:-$NO_CONFIG}" launch_link build-command "$@"
  }
  DEFAULT_LAUNCH="cd '/p q' && AGENT_SESSION_LAUNCH='5d9b3c1e-2f4a-4b6c-8d7e-9f0a1b2c3d4e' AGENT_SESSION_TITLE='it'\\''s' claude --session-id '5d9b3c1e-2f4a-4b6c-8d7e-9f0a1b2c3d4e' -n 'it'\\''s' -- \"\$(cat '/t/f' && rm -f '/t/f')\""
  expect_line "no template file uses the default launch command" "$DEFAULT_LAUNCH" build_launch "$LAUNCH_SESSION" "/p q" "it's" "/t/f"
  UNTITLED_LAUNCH="cd '/p' && AGENT_SESSION_LAUNCH='5d9b3c1e-2f4a-4b6c-8d7e-9f0a1b2c3d4e' AGENT_SESSION_TITLE='' claude --session-id '5d9b3c1e-2f4a-4b6c-8d7e-9f0a1b2c3d4e'  -- \"\$(cat '/t/f' && rm -f '/t/f')\""
  expect_line "with no title the default command passes no -n" "$UNTITLED_LAUNCH" build_launch "$LAUNCH_SESSION" "/p" "" "/t/f"
  TEMPLATE_DIR="$TMP_ROOT/template-config"
  mkdir -p "$TEMPLATE_DIR"
  printf '   \n' > "$TEMPLATE_DIR/launch-command"
  TEMPLATE_DIR="$TEMPLATE_DIR" expect_line "a blank template file uses the default launch command" "$DEFAULT_LAUNCH" build_launch "$LAUNCH_SESSION" "/p q" "it's" "/t/f"
  printf 'cd {cwd} && claude {name} {prompt} # {session} {unknown}\r\nsecond line {cwd}\n' > "$TEMPLATE_DIR/launch-command"
  TEMPLATE_DIR="$TEMPLATE_DIR" expect_line "a custom template's first line is used, carriage return removed, other braces kept" "cd '/p' && claude -n 't' \"\$(cat '/t/f' && rm -f '/t/f')\" # '5d9b3c1e-2f4a-4b6c-8d7e-9f0a1b2c3d4e' {unknown}" build_launch "$LAUNCH_SESSION" "/p" "t" "/t/f"
  printf '{name} {session}\n' > "$TEMPLATE_DIR/launch-command"
  TEMPLATE_DIR="$TEMPLATE_DIR" expect_line "a placeholder inside a substituted value is not expanded again" "-n '{session}' '5d9b3c1e-2f4a-4b6c-8d7e-9f0a1b2c3d4e'" build_launch "$LAUNCH_SESSION" "/p" "{session}" "/t/f"

  RUN_DIR="$TMP_ROOT/run dir"
  mkdir -p "$RUN_DIR"
  printf 'cd {cwd} && printf %%s {prompt} > got\n' > "$TEMPLATE_DIR/launch-command"
  TRICKY_PROMPT=$'line one "double" \'single\' $HOME `date` \\back\n\tline two'
  for run_shell in bash zsh; do
    if command -v "$run_shell" >/dev/null 2>&1; then
      rm -f "$RUN_DIR/got"
      RUN_PROMPT_FILE="$(LINK_TMPDIR="$PROMPT_TMP" launch_link write-prompt "$TRICKY_PROMPT")"
      RUN_COMMAND="$(TEMPLATE_DIR="$TEMPLATE_DIR" build_launch "$LAUNCH_SESSION" "$RUN_DIR" "" "$RUN_PROMPT_FILE")"
      "$run_shell" -c "$RUN_COMMAND"
      printf '%s' "$TRICKY_PROMPT" > "$CAP_EXP"
      cmp -s "$RUN_DIR/got" "$CAP_EXP"
      check "$run_shell: the typed command delivers the prompt byte for byte" "0" "$?"
      [ ! -e "$RUN_PROMPT_FILE" ]
      check "$run_shell: the typed command deletes the prompt file" "0" "$?"
    else
      echo "SKIP: $run_shell not installed (launch command round trip)"
    fi
  done
else
  echo "SKIP: python3 not available (find-live-session.py)"
fi

# --- Part 2: handler.applescript ----------------------------------------------
if command -v osascript >/dev/null 2>&1 && command -v osacompile >/dev/null 2>&1; then
  osacompile -o "$TMP_ROOT/handler.scpt" "$HANDLER_SCRIPT" 2>"$TMP_ROOT/compile.err"
  check "handler compiles" "0" "$?"

  parse() {
    osascript -e "set handlerScript to load script POSIX file \"$TMP_ROOT/handler.scpt\"" \
      -e "tell handlerScript to parseAgentURL(\"$1\")"
  }

  expect_line "full URL with a percent-encoded cwd containing a space" "hostName:iterm, itermId:AB-12, claudeId:c1, launchDir:/a b/c, sessionId:, expiry:, launchTitle:, launchPrompt:, signature:" parse 'agent-session://iterm/AB-12?claude=c1&cwd=%2Fa%20b%2Fc'

  expect_line "unknown host is returned as-is for the caller to refuse" "hostName:other, itermId:x, claudeId:, launchDir:, sessionId:, expiry:, launchTitle:, launchPrompt:, signature:" parse 'agent-session://other/x'

  expect_line "URL missing the claude param leaves claudeId empty" "hostName:iterm, itermId:AB-12, claudeId:, launchDir:/d, sessionId:, expiry:, launchTitle:, launchPrompt:, signature:" parse 'agent-session://iterm/AB-12?cwd=%2Fd'

  build() {
    osascript -e "set handlerScript to load script POSIX file \"$TMP_ROOT/handler.scpt\"" \
      -e "tell handlerScript to buildResumeCommand(\"$1\", \"$2\", \"$3\")"
  }

  expect_line "blank template resumes with the default command" "cd '/p' && claude --resume 'c1'" build '  ' c1 /p

  expect_line "cwd with a space and a single quote is shell-quoted" "cd '/a b/it'\\''s' && claude --resume 'c1'" build 'cd {cwd} && claude --resume {claude}' c1 "/a b/it's"

  expect_line "custom template substitutes every placeholder and keeps the rest verbatim" "cd '/x' && { [ ! -f .env.local ] || source .env.local; } && claude --resume 'c1' # 'c1'" build 'cd {cwd} && { [ ! -f .env.local ] || source .env.local; } && claude --resume {claude} # {claude}' c1 /x
  export AGENT_SESSION_HANDLER_DIR="$HANDLER_DIR"
  check_url() {
    osascript -e "set handlerScript to load script POSIX file \"$TMP_ROOT/handler.scpt\"" \
      -e "tell handlerScript to checkAgentURL(parseAgentURL(\"$1\"))"
  }
  GOOD_URL="agent-session://iterm/$GOOD_ITERM?claude=$GOOD_CLAUDE&cwd=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$TMP_ROOT")"
  expect_line "a well-formed link passes the whole check" "" check_url "$GOOD_URL"
  expect_line "the probe link with an encoded kill-line and newline is refused" "the directory contains a control character" check_url "agent-session://iterm/$GOOD_ITERM?claude=$GOOD_CLAUDE&cwd=%15touch%20%2Ftmp%2Fpwned%0Aecho"
  expect_line "an encoded tab is refused" "the directory contains a control character" check_url "agent-session://iterm/$GOOD_ITERM?claude=$GOOD_CLAUDE&cwd=%2Ftmp%09x"
  expect_line "an encoded DEL is refused" "the directory contains a control character" check_url "agent-session://iterm/$GOOD_ITERM?claude=$GOOD_CLAUDE&cwd=%2Ftmp%7Fx"
  expect_line "a link without a claude parameter is refused" "the link names no Claude session" check_url "agent-session://iterm/$GOOD_ITERM?cwd=%2Ftmp"
  expect_line "an unknown host is refused" "unknown host" check_url "agent-session://other/$GOOD_ITERM"

  resume_refusal() {
    AGENT_SESSION_HANDLER_DIR="$HANDLER_DIR" AGENT_SESSION_PROJECTS_DIR="$PROJECTS" osascript \
      -e "set handlerScript to load script POSIX file \"$TMP_ROOT/handler.scpt\"" \
      -e "tell handlerScript to resumeDirRefusal(\"$1\", \"$2\")"
  }
  expect_line "the handler allows a resume from the session's project directory" "" resume_refusal "$ID_OK" "$RESUME_DIR"
  expect_line "the handler refuses a resume in a planted directory" "the session's transcript is not filed under that directory" resume_refusal "$ID_OK" "$PLANTED_DIR"
  expect_line "the handler refuses a resume when the session has no transcript" "no transcript was found for that session" resume_refusal "$ID_ABSENT" "$RESUME_DIR"
  FAILING_CHECK="$TMP_ROOT/failing-check"
  mkdir -p "$FAILING_CHECK"
  printf 'import sys\nsys.exit(3)\n' > "$FAILING_CHECK/check-resume-dir.py"
  failing_check() {
    AGENT_SESSION_HANDLER_DIR="$FAILING_CHECK" osascript -e "set handlerScript to load script POSIX file \"$TMP_ROOT/handler.scpt\"" -e 'tell handlerScript to resumeDirRefusal("x", "/")'
  }
  expect_line "the handler reports a failing directory check" "the directory check failed: The command exited with a non-zero status." failing_check

  classify() {
    osascript -e "set handlerScript to load script POSIX file \"$TMP_ROOT/handler.scpt\"" \
      -e "tell handlerScript to classifyLiveLookup(\"$1\")"
  }
  expect_line "no lookup result means no live process" "none" classify ''
  expect_line "a live process with ?? as its tty is not resumable" "no-tty" classify "123"$'\t'"??"
  expect_line "a live process with an empty tty is not resumable" "no-tty" classify "123"$'\t'
  lookup() {
    AGENT_SESSION_HANDLER_DIR="$1" AGENT_SESSION_SESSIONS_DIR="$2" osascript \
      -e "set handlerScript to load script POSIX file \"$TMP_ROOT/handler.scpt\"" \
      -e "tell handlerScript to classifyLiveLookup(liveSessionLookup(\"live-id\"))"
  }
  FAILING_HELPER="$TMP_ROOT/failing-helper"
  mkdir -p "$FAILING_HELPER"
  printf 'import sys\nprint("boom", file=sys.stderr)\nsys.exit(3)\n' > "$FAILING_HELPER/find-live-session.py"
  expect_line "a helper that exits non-zero classifies as unknown" "unknown" lookup "$FAILING_HELPER" "$TMP_ROOT"
  expect_line "a sessions path the real helper cannot list classifies as unknown" "unknown" lookup "$HANDLER_DIR" "$NOT_A_DIR"
  expect_line "a sessions file that is not valid JSON classifies as unknown" "unknown" lookup "$HANDLER_DIR" "$GARBAGE"
  expect_line "a sessions dir that does not exist classifies as none" "none" lookup "$HANDLER_DIR" "$TMP_ROOT/absent"
  expect_line "a completed scan that finds nothing classifies as none" "none" lookup "$HANDLER_DIR" "$MIXED"
  expect_line "a helper failure is unknown, never none" "unknown" classify '!cannot list /x: Permission denied'
  expect_line "output that is not pid and tty is unknown" "unknown" classify 'garbage'
  expect_line "a non-numeric pid is unknown" "unknown" classify "abc"$'\t'"ttys012"
  expect_line "a live process with a tty reports it" "ttys012" classify "123"$'\t'"ttys012"

  # --- launch links ---
  in_handler() {
    osascript -e "set handlerScript to load script POSIX file \"$TMP_ROOT/handler.scpt\"" -e "tell handlerScript to $1"
  }
  enc() {
    python3 -I -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"
  }
  launch_url() {
    printf 'agent-session://launch?session=%s&exp=%s&cwd=%s&title=%s&prompt=%s&sig=%s' "$(enc "$1")" "$(enc "$2")" "$(enc "$3")" "$(enc "$4")" "$(enc "$5")" "$(enc "$6")"
  }
  expect_line "a launch link takes the launch path" "launch" in_handler 'linkPath(parseAgentURL("agent-session://launch?session=x"))'
  expect_line "an iterm link takes the resume path" "resume" in_handler 'linkPath(parseAgentURL("agent-session://iterm/AB-12?claude=c1&cwd=%2Fd"))'
  expect_line "a link with an unknown host takes the resume path, where it is refused" "resume" in_handler 'linkPath(parseAgentURL("agent-session://other/x"))'
  expect_line "a launch link's fields are decoded, a plus as a space and %2B as a plus" "hostName:launch, itermId:, claudeId:, launchDir:/a b, sessionId:S1, expiry:123, launchTitle:T x, launchPrompt:p+q, signature:ab" in_handler 'parseAgentURL("agent-session://launch?session=S1&exp=123&cwd=%2Fa%20b&title=T+x&prompt=p%2Bq&sig=ab")'
  expect_line "a launch link without a title decodes it as empty" "hostName:launch, itermId:, claudeId:, launchDir:, sessionId:S1, expiry:, launchTitle:, launchPrompt:hi, signature:" in_handler 'parseAgentURL("agent-session://launch?session=S1&prompt=hi")'
  expect_line "a decoded multi-line prompt keeps every line feed, the last one included" $'a\nb\n' in_handler 'launchPrompt of parseAgentURL("agent-session://launch?prompt=a%0Ab%0A")'

  SIGNED_URL="$(launch_url "$LAUNCH_SESSION" "$FRESH_EXP" "$TMP_ROOT" "My title" "$MULTILINE_PROMPT" "$GOOD_SIG")"
  TAMPERED_URL="$(launch_url "$LAUNCH_SESSION" "$FRESH_EXP" "$TMP_ROOT" "My title" "${MULTILINE_PROMPT}rm -rf ~" "$GOOD_SIG")"
  MISSING_DIR_URL="$(launch_url "$LAUNCH_SESSION" "$FRESH_EXP" "$TMP_ROOT/absent" "My title" "$MULTILINE_PROMPT" "$GOOD_SIG")"
  launch_check() {
    AGENT_SESSION_HANDLER_DIR="$HANDLER_DIR" AGENT_SESSION_CONFIG_DIR="${LINK_CONFIG:-$LAUNCH_CONFIG}" TMPDIR="$PROMPT_TMP" in_handler "$1(parseAgentURL(\"$2\"))"
  }
  expect_line "the handler reads a board-signed multi-line launch link as signed" "signed" launch_check launchTrust "$SIGNED_URL"
  expect_line "the handler reads a launch link with a changed prompt as unsigned" "unsigned" launch_check launchTrust "$TAMPERED_URL"
  LINK_CONFIG="$NO_CONFIG" expect_line "the handler reads every launch link as no-key when there is no key" "no-key" launch_check launchTrust "$SIGNED_URL"
  expect_line "the handler accepts a well-formed launch link" "" launch_check launchRefusal "$SIGNED_URL"
  expect_line "the handler refuses a launch link whose directory does not exist" "the directory is not an existing absolute path" launch_check launchRefusal "$MISSING_DIR_URL"
  NUL_TITLE_URL="agent-session://launch?session=$LAUNCH_SESSION&cwd=$(enc "$TMP_ROOT")&title=a%00b&prompt=hi"
  NUL_PROMPT_URL="agent-session://launch?session=$LAUNCH_SESSION&cwd=$(enc "$TMP_ROOT")&prompt=a%00b"
  expect_line "a NUL in a launch title is refused with a reason" "the title contains a control character" launch_check launchRefusal "$NUL_TITLE_URL"
  expect_line "a NUL in a launch prompt is refused with a reason" "the prompt contains a control character other than tab or newline" launch_check launchRefusal "$NUL_PROMPT_URL"
  expect_line "a NUL in a resume link's directory is refused with a reason" "the directory contains a control character" check_url "agent-session://iterm/$GOOD_ITERM?claude=$GOOD_CLAUDE&cwd=%2Ftmp%00x"

  P2000="$(head -c 2000 /dev/zero | tr '\0' x)"
  expect_line "a signed link opens without asking, whatever its prompt length" "open" in_handler "launchGate(\"signed\", \"${P2000}${P2000}\")"
  expect_line "an unsigned link asks first" "confirm" in_handler 'launchGate("unsigned", "hi")'
  expect_line "an expired link asks first" "confirm" in_handler 'launchGate("expired", "hi")'
  expect_line "a link with no key asks first" "confirm" in_handler 'launchGate("no-key", "hi")'
  expect_line "an unrecognised trust status asks first" "confirm" in_handler 'launchGate("garbage", "hi")'
  expect_line "an unsigned prompt of exactly 2000 characters asks first" "confirm" in_handler "launchGate(\"unsigned\", \"$P2000\")"
  expect_line "an unsigned prompt over 2000 characters is refused" "refuse" in_handler "launchGate(\"unsigned\", \"${P2000}x\")"

  HANDLER_RUN_DIR="$TMP_ROOT/handler run"
  mkdir -p "$HANDLER_RUN_DIR"
  printf 'cd {cwd} && printf %%s {prompt} > got\n' > "$TEMPLATE_DIR/launch-command"
  RUN_URL="$(launch_url "$LAUNCH_SESSION" "$FRESH_EXP" "$HANDLER_RUN_DIR" "" "$TRICKY_PROMPT" "")"
  LINK_CONFIG="$TEMPLATE_DIR" capture launch_check prepareLaunchCommand "$RUN_URL"
  check "the handler prepares a launch command" "0" "$CAP_RC"
  bash -c "$(cat "$CAP_OUT")"
  printf '%s' "$TRICKY_PROMPT" > "$CAP_EXP"
  cmp -s "$HANDLER_RUN_DIR/got" "$CAP_EXP"
  check "the handler's launch command delivers the decoded prompt byte for byte" "0" "$?"

  expect_line "a resume link with an unknown host is still refused" "unknown host" check_url "agent-session://other/$GOOD_ITERM"
else
  echo "SKIP: osascript/osacompile not available (handler.applescript)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
