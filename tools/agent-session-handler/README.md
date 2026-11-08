# Agent Session handler

A small macOS applet that opens `agent-session://` links from the board. For an `iterm` link it
focuses the iTerm2 session the link names; if that session is gone, it opens a new iTerm2 tab in the
session's launch directory and runs `claude --resume` for it. For a `launch` link it starts a new
interactive Claude Code session in a new iTerm2 tab (see [Starting a new session](#starting-a-new-session)).

## Install

The handler needs iTerm2, and Xcode or the Xcode Command Line Tools (`xcode-select --install`). It runs its
helpers with `/usr/bin/python3`, which is only a stub until one of them is installed.

The installer ships with the plugin. Run it from the plugin's marketplace copy, whose path is the same
for every plugin version:

```bash
~/.claude/plugins/marketplaces/denormans-workflow/tools/agent-session-handler/install.sh
```

If that copy is missing, run the same script from the newest version under
`~/.claude/plugins/cache/denormans-workflow/workflow/`. From a checkout of this repository, run
`tools/agent-session-handler/install.sh`.

It builds `~/Applications/Agent Session.app`, copies the helpers into it, and registers it for
`agent-session://` links. Because the app holds its own copy, updating the plugin does not change it:
run the installer again to pick up a newer handler. Each run deletes the existing app before
building the new one, so if a run fails, fix the error and run it again.

The first time a link opens, macOS asks whether Agent Session may control iTerm2. Allow it. If it was
denied, turn it back on in System Settings → Privacy & Security → Automation, under Agent Session.

## Finding a session that has moved

An `iterm` link names an iTerm2 session id, which may change when iTerm2 restarts or the session is
resumed in another pane. When no iTerm2 session has that id, the handler looks for a live Claude Code process running the link's
Claude session, using the `sessionId` and `pid` in `~/.claude/sessions/<pid>.json`, and focuses the
iTerm2 pane on that process's tty. A process counts as live only if it exists and, when the file
records `procStart`, started at that time. If a live process has no iTerm2 pane (another terminal, or
no terminal at all), the handler says so and does not resume. Only when no live process is found, and
the link's directory is one the session can be resumed from (see Resume command), does it
open a new tab and resume.

Those files are Claude Code's own and undocumented. A sessions folder that does not exist counts as
"not found", and so does a file that is valid JSON but names another session or none, or that
disappears before it is read. The check cannot say whether a session is running, and the handler asks
"Resume anyway" or "Cancel" (Cancel is the default) rather than assuming nothing is running, when:

- the folder cannot be listed, or a file that exists cannot be read or is not valid JSON;
- a file names the session without a usable pid;
- `ps` cannot run, or fails with output or an exit status other than 1 (`ps -p` exits 1 with no output
  for a pid that does not exist, so a process that exited just after it was found counts as not live);
- the helper fails or prints something unrecognised.

## Resume command

When a link needs a new tab, the handler types a resume command into it. The default is:

```
cd {cwd} && claude --resume {claude}
```

To change it, put a one-line template in `~/.config/agent-session/resume-command`. `{cwd}` and
`{claude}` are replaced with shell-quoted values; the line is otherwise typed as written. A missing or
blank file means the default. For example, to load `.env.local` before resuming:

```
cd {cwd} && { [ ! -f .env.local ] || source .env.local; } && claude --resume {claude}
```

The resume command runs only in a directory whose encoded name is a folder under
`~/.claude/projects/` that holds the session's transcript (`<folder>/<claude session id>.jsonl`), the
folder Claude Code files that session under. The encoding replaces every character other than A-Z, a-z
and 0-9 with `-`; Claude Code does not document it. The handler resumes nothing, and says why, when no
folder holds the transcript, when the projects folder cannot be listed, when the transcript's path
cannot be looked up (a folder that cannot be searched, for example), or when no folder holding it is
named for the link's directory. It also refuses a directory with a non-ASCII character or an encoded
name longer than 200 characters, because the encoding is not evidenced there.

The encoding is lossy: any other directory of the same length that matches wherever either holds a
letter or digit encodes to the same name and is accepted too (`/a/b-c`, `/a/b/c` and `/a-b/c` match).
An attacker therefore needs the user's real session id and a directory whose path matches the
project's at every letter and digit, wherever the attacker can create one. A template that runs files
from `{cwd}`, like the `.env.local` one above, trusts the contents of that directory.

## Starting a new session

A `launch` link starts a new interactive Claude Code session in a new iTerm2 tab:

```
agent-session://launch?session=<uuid>&exp=<unix seconds>&cwd=<directory>&title=<title>&prompt=<prompt>&sig=<signature>
```

Every value is URL-encoded: `%20` for a space and `%2B` for `+`, since a bare `+` reads as a space.
`title` may be empty or left out. The prompt is the session's first message, so a slash command or
skill in it runs as if typed. In a directory Claude Code has never trusted, Claude Code still asks
whether to trust it.

### Signed and unsigned links

A link signed with the launch key opens without asking. The board will create and sign launch links
in a later release; until then, a link you build by hand gets the dialog described below. The
signature is HMAC-SHA256, keyed by the 32 bytes that the launch key's hex digits encode, over these
lines joined by a line feed, with no line feed after the last:

```
agent-session-launch-v1
<session>
<exp>
<cwd>
<title>
<prompt>
```

The signature is written as 64 lowercase hex digits. The handler expects the launch key at
`~/.config/agent-session/launch-key`: one line of 64 lowercase hex digits. It only reads the file,
and ignores it unless it is a regular file you own with no group or other permission bits.

A launch link stops at a dialog that shows its directory, title and whole prompt, with Cancel as the
default, when its signature is missing or does not match, when it has expired (`exp` is not a number
of up to 12 digits, is in the past, or is more than 150 seconds ahead, which allows for a small clock
difference), or when no usable key is set up. Nothing runs if you cancel. Such a link may carry at
most 2,000 characters of prompt, so the dialog can show all of it; a longer one is refused.

Each link names a new session id, and Claude Code refuses to start a session with an id that is
already in use, so a link opened twice starts one session. The second tab shows Claude Code's
"already in use" error.

### Launch command

The handler types a launch command into the new tab. The default is:

```
cd {cwd} && AGENT_SESSION_LAUNCH={session} AGENT_SESSION_TITLE={title} claude --session-id {session} {name} -- {prompt}
```

To change it, put a one-line template in `~/.config/agent-session/launch-command`. Only the first
line is read, carriage returns are removed, and a missing or blank file means the default.

| Placeholder | Becomes |
|---|---|
| `{cwd}` | the directory, shell-quoted |
| `{session}` | the new session's id, shell-quoted |
| `{title}` | the title, shell-quoted (`''` when there is none) |
| `{name}` | `-n '<title>'`, or nothing when there is no title |
| `{prompt}` | `"$(cat '<file>' && rm -f '<file>')"`, which reads the prompt from a private file and deletes it |

Everything else is typed as written, including braces that are not one of these placeholders. Keep
`--` before `{prompt}`, so that a prompt starting with `-` is not read as an option. Keep the two
`AGENT_SESSION_` variables. The plugin's SessionStart hook reads them. When `AGENT_SESSION_LAUNCH`
matches the new session's id, it tells the session to invoke the board skill before its first reply,
and when `AGENT_SESSION_TITLE` is also not empty, it opens the session's board card under that title
before any workflow runs. A `claude` process that the session starts later
inherits both variables but has its own id, so it doesn't take the title. The command uses POSIX
shell syntax (`&&`, `$(…)`, `NAME=value command`), which bash and zsh accept. For example, to load
`.env.local` and choose a model:

```
cd {cwd} && { [ ! -f .env.local ] || source .env.local; } && AGENT_SESSION_LAUNCH={session} AGENT_SESSION_TITLE={title} claude --model opus --session-id {session} {name} -- {prompt}
```

The prompt is not typed into the terminal, because iTerm2 would submit a multi-line prompt one line
at a time. The handler writes it to a new file, readable only by you, in `agent-session/` under your
temporary directory (`$TMPDIR`), a folder created so that only you can open it. It refuses to launch
when that folder is not a directory (a symbolic link included), is not owned by you, or has any group
or other permission bit. The command reads the file and deletes it; line feeds at the very end of the
prompt are dropped. A file left by a launch that never ran is deleted by a later launch once it is a
day old.

## What a link may contain

The handler refuses, with a dialog and no other action, any `iterm` link whose decoded values hold a
control character (below 0x20, or DEL), whose iTerm2 or Claude session id is missing or not a UUID, or
whose directory is missing or not an existing absolute path.

It refuses a `launch` link, signed or not, whose session id is not a UUID; whose directory is not an
existing absolute path; whose title is longer than 200 characters; or whose prompt is empty, only
whitespace, or longer than 32 KiB as UTF-8. It also refuses a link in which:

- the session id, directory or title holds a control character (below 0x20, DEL, or 0x80 to 0x9F);
- the prompt holds a control character other than tab and line feed (a carriage return included);
- any of the four holds a character Unicode marks as invisible (format characters, line and paragraph
  separators, and default-ignorable code points such as variation selectors and Hangul fillers). The
  set is fixed to Unicode 18.0.0, whichever Python runs. The zero-width joiner and the two
  presentation selectors (U+FE0E and U+FE0F) are allowed in the title and the prompt, so that joined
  and presentation-styled emoji keep working; flags built from tag characters (England, Scotland,
  Wales) are still refused.

A NUL in any value counts as a control character, in a `launch` link and in an `iterm` link alike.
