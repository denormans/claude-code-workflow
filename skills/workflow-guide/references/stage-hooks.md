# Stage Hooks

People using the workflow attach their own steps to named workflow moments through hook files (the
README's **Workflow stage hooks** section is the user-facing description). Each skill that owns a
moment runs it with `workflow-hooks` at one call site and handles the result as this file says.
This file is the one place that says how.

## Running a moment

Run `workflow-hooks run --moment "<moment>"` as its own foreground Bash command — never piped and
never chained with another command, because its exit code is the result. The one form allowed is
the subshell below, `(cd "<worktree-path>" && workflow-hooks run ...)`; its parentheses keep the
session's own working directory unchanged. If stdout carries no `workflow-hooks` JSON, the moment
did not run to a result — a failed `cd`, a crash, anything else. Read stderr for the cause and
treat it as a blocking failure, reported like exit 1 with stderr in place of `problems`. Add
`--ticket "<TICKET-ID>"` whenever there is a ticket, `--pr "<pr-url>"` on the PR moments, and
`--tests-outcome "<pass|fail>"` on `tests.after`.

Run it from the directory its commands should start in, since they start at the top level of the
checkout it was run from and read the branch there:

- **The story's worktree, while one exists** — work start, team start, tests, every PR moment and
  `cleanup.before`: `(cd "<worktree-path>" && workflow-hooks run --moment "<moment>" ...)`. In a
  multi-repo story, run the moment once per repo, from that repo's worktree.
- **Otherwise** — the design phases run from the directory Claude was launched in, and
  `cleanup.after`, after the worktree is gone, from the repo root.

With no hooks configured and the usual arguments (`--moment <id>`, `--ticket`, `--pr`,
`--tests-outcome pass|fail`, each at most once, no value starting with `-`) it prints
`{"moment":"<moment>","ran":[],"instructions":[]}` and exits 0 at once, so a call site costs
nothing until someone configures a hook. With no hooks file, any other argument is
handed to the full CLI, so the exit code and stdout match a hooks file that configures no step for
that moment. Never skip a call site
because you expect nothing to be configured: the hook files are the user's, and you cannot see them
from the skill.

## Exit codes

| Exit | Meaning | What you do |
|---|---|---|
| 0 | Every blocking step passed. | Carry out each `instructions` entry, in order, as part of this moment. Report every `ran` entry whose `outcome` is not `ok` as a non-blocking failure (§Reporting a result), then continue. |
| 1 | A hooks file is invalid, or the moment id is unknown. The JSON carries `error` and either `problems` (each file and field) or `moments` (the valid ids). With no JSON on stdout the moment did not run to a result (§Running a moment); the cause is on stderr. | Treat it as a blocking failure. |
| 3 | A blocking command step failed or timed out, and no later step ran. | Stop at this moment and report it as a blocking failure. Do not carry on past the moment until the answer comes back. |

An `instructions` entry marked `blocking: true` that you cannot complete is a blocking failure,
exactly like exit 3. One marked `blocking: false` that you cannot complete is a non-blocking
failure.

## Reporting a result

**The team lead** reports on the board, through a temp file, never a shell string
(`skills/board/references/dashboard-protocol.md` §2):

- **A non-blocking failure** is an info note naming the moment, the step, its `source` file and its
  `outputTail`: `dashboard item add --type info --prompt "$(cat "<tmpfile>")"`. Then carry on.
- **A blocking failure, or exit 1,** is a question naming the same things (for exit 1, the
  `error` and its `problems` or `moments` instead), recommending a fix to the step and a re-run:
  `dashboard item add --type question --recommend "<one line>" --stalls "<what waits on this moment>" --why-mine fact --prompt "$(cat "<tmpfile>")"`.
  Wait for the answer. When it says the step is fixed, run the moment again; when it says to carry
  on without it, carry on past the moment. With no board, `item add` exits 3 and prints the
  question: ask it in the terminal and wait there.

**A teammate** does not post. It sends the team lead the moment, the exit code and the JSON
`workflow-hooks` printed, and for a blocking failure or exit 1 it stops at the moment until the team
lead answers. The team lead posts it as above and relays the answer.

## Where the moments are

The moment ids, and the file that runs each one, are `MOMENT_CALL_SITES` in
`tools/cli/src/workflow-hooks/moments.ts`. `pnpm lint` reports a call site missing from any file
that list names, and any call naming a moment that does not exist.
