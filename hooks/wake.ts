import type { Register } from 'claude-code'

// The session's own waker (FLOW-400). While the session is idle it asks `mailbox check` whether
// anything should wake it, and starts a turn carrying whatever is new. It only schedules: what is
// worth waking for is decided by the CLI. It also beats the board while the agent works.

const TICK_MS = 60_000
// Keep in step with CHECK_INTERVAL_MINUTES in tools/cli/src/pr-monitor/poll.ts, which the
// pr-monitor command text and the wedge bound's idle-minutes figure derive from; the mod cannot
// import it.
const CHECK_INTERVAL_MS = 180_000
// Keep CHECK_TOTAL_BUDGET_MS in tools/cli/src/mailbox/check.ts below this: a check that runs past it
// is killed and delivers nothing.
const CHECK_TIMEOUT_MS = 120_000
// A beat is sent at most this often, and only after a tool call or turn end since the last one:
// a beat must mean the agent is doing something (FLOW-321). The board marks a session hung after
// 60 minutes without one.
const BEAT_INTERVAL_MS = 300_000
// `dashboard session heartbeat` invokes the board once per live leaf, 5s each, plus one
// `session list` read for each leaf marked paused.
const BEAT_TIMEOUT_MS = 30_000
// `mailbox turn-started` makes no board call. It takes the failed-turn record lock, which waits at
// most 500 tries of 20ms (10s, in withRecordLock) before running unlocked, then reads and writes
// the turn marks locally.
const CLEAR_TIMEOUT_MS = 30_000
// `dashboard session wait --clear` claims the teammate-turns lock once, waiting up to 15s while a
// holder makes one 5s board call per leaf, 15s for three leaves. Its locked step makes one 5s
// clear call per leaf, another 15s, and nothing runs after it. 15 + 15 = 30s, and 15s of slack
// keeps contention in the skip path rather than a kill.
const WAIT_CLEAR_TIMEOUT_MS = 45_000
// `dashboard session turn-start` claims the teammate-turns lock twice, for the lead's stop tasks and
// for a teammate's busy entry. Each claim waits up to 15s while a holder makes one 5s board call per
// leaf, 15s for three leaves; a claim then runs its own locked step, which is as long again, and the
// run ends with one 5s `session turn --clear` per leaf. 2 x (15 + 15) + 15 = 75s, and 15s of slack
// keeps contention in the skip path rather than a kill.
const TURN_START_TIMEOUT_MS = 90_000
// `mailbox check` exits 0 on a complete read and 3 on a partial one: there is no board binary, a board
// read failed or its output was unparseable, or the registry was unreadable, so the answers listed
// may be a subset of what is released.
const PARTIAL_EXIT = 3
// A check prints one entry per wake reason, each opening with a source tag; it indents an answer's
// continuation lines, so only an entry's first line can open with a tag. Entries split before a known
// tag at the start of a line.
const ENTRY_START = /\n(?=\[(?:dashboard|pr-monitor|renovate-pr-monitor|team|turn)\] )/
const RELEASED_ITEM = /^\[dashboard\] item (\S+) /
const FAILED_TURN_ENTRY = /^\[turn\] /

export const register: Register = (on) => {
  // Module memory, so a reload starts all of these at their initial value: the next turn.start sets
  // the turn state, and the next tool call re-arms the beat.
  let isTurnRunning = false
  let turnStarts = 0
  let hasActivitySinceBeat = false
  let lastBeatAt = Number.NEGATIVE_INFINITY
  let isInteractive = false

  // A main-loop turn starting means the session is no longer waiting on background work (FLOW-457):
  // clear what its last Stop recorded. The clear carries the instant the turn started, so it only
  // clears a wait recorded before then, never one this turn's own Stop wrote. Not awaited, so a slow
  // board never delays the turn, and a failure is dropped — the next turn start clears again.
  on('turn.start', ($, e, next) => {
    isTurnRunning = true
    turnStarts += 1

    if (e.agentId === undefined) {
      const turnStartedAt = new Date().toISOString()

      void $.session
        .id()
        .then((sessionId) =>
          $.process.run(
            [
              `${$.plugin.root}/bin/dashboard`,
              'session',
              'wait',
              '--clear',
              '--recorded-before',
              turnStartedAt,
              '--session',
              sessionId,
            ],
            { timeoutMs: WAIT_CLEAR_TIMEOUT_MS }
          )
        )
        .catch(() => undefined)

      // The board's turn outcome clears at the same instant. --interactive lets the
      // turn's end open a board node for a session outside any workflow; a `-p` run never does.
      void $.session
        .id()
        .then((sessionId) =>
          $.process.run(
            [
              `${$.plugin.root}/bin/dashboard`,
              'session',
              'turn-start',
              '--started-at',
              turnStartedAt,
              '--session',
              sessionId,
              ...(isInteractive ? ['--interactive'] : []),
            ],
            { timeoutMs: TURN_START_TIMEOUT_MS }
          )
        )
        .catch(() => undefined)

      // Every turn start is recorded, so a failure that follows a start is not resumed over the
      // user and a start later than a failure stops the failed-turn entry from printing again. The
      // prompt id orders it against the failure; without one the start is marked under an id of its
      // own. Not awaited; a failure is dropped.
      void Promise.all([
        $.session.id(),
        $.session.info().then(
          (info) => info.promptId,
          () => undefined
        ),
      ])
        .then(([sessionId, promptId]) =>
          $.process.run(
            [
              `${$.plugin.root}/bin/mailbox`,
              'turn-started',
              '--session',
              sessionId,
              '--started-at',
              turnStartedAt,
              ...(promptId === undefined ? [] : ['--prompt-id', promptId]),
            ],
            { timeoutMs: CLEAR_TIMEOUT_MS }
          )
        )
        .catch(() => undefined)
    }

    return next(e)
  })

  on('tool.call', ($, e, next) => {
    hasActivitySinceBeat = true
    return next(e)
  })

  // A subagent's turn ends carrying its agentId; only the main loop's end leaves the session idle.
  on('turn.complete', ($, e, next) => {
    hasActivitySinceBeat = true
    if (e.agentId === undefined) {
      isTurnRunning = false
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isInteractive = e.isInteractive
    // A `-p` run or the SDK has nobody at the prompt to wake.
    if (!e.isInteractive) {
      return started
    }

    let lastCheckAt = 0

    $.clock.every(TICK_MS, async () => {
      // Read every tick, not once: after a `/clear` or a resume the process goes on under another
      // session id.
      const sessionId = await $.session.id()
      // Released answers stay released until consumed, so without this every check would re-deliver
      // them. Kept per session in $.store, so a reload or restart does not re-deliver either.
      const deliveredKey = `delivered-board-items:${sessionId}`
      const now = await $.clock.now()
      if (hasActivitySinceBeat && now - lastBeatAt >= BEAT_INTERVAL_MS) {
        hasActivitySinceBeat = false
        lastBeatAt = now
        // A failed or timed-out beat is dropped, not retried: the next activity re-arms one, and a
        // rejection here must not cost this tick its check.
        await $.process
          .run([`${$.plugin.root}/bin/dashboard`, 'session', 'heartbeat', '--session', sessionId], {
            timeoutMs: BEAT_TIMEOUT_MS,
          })
          .catch(() => undefined)
      }

      if (isTurnRunning || now - lastCheckAt < CHECK_INTERVAL_MS) {
        return
      }

      lastCheckAt = now
      const turnStartsBefore = turnStarts
      // Residual: a death line or a PR change is recorded when the check prints it (a death as
      // reported, a PR change as the new baseline), so it is lost if the check then rejects at its
      // timeout, or if the submit below rejects. An answer is not: it is re-printed until consumed.
      const { exitCode, stdout } = await $.process.run(
        [`${$.plugin.root}/bin/mailbox`, 'check', '--session', sessionId],
        { timeoutMs: CHECK_TIMEOUT_MS }
      )

      const output = stdout.trim()
      const entries = output === '' ? [] : output.split(ENTRY_START)
      // Every entry that is not an answer is delivered whatever the exit code and whatever the
      // session is doing: `$.prompt.submit` queues behind a running turn. A death line or a PR
      // change is printed once and recorded as reported; a "could not be polled" line is never
      // recorded and repeats each check until the PR polls again.
      // Answer entries are re-printed until consumed, so a stale or unreliable read can wait.
      const delivered = new Set(asStringArray(await $.store.get(deliveredKey)))
      const isAnswerReadUsable =
        (exitCode === 0 || exitCode === PARTIAL_EXIT) &&
        !isTurnRunning &&
        turnStarts === turnStartsBefore
      const reportedIds = entries.flatMap((entry) => releasedItemId(entry) ?? [])
      const wake = entries.filter((entry) => {
        // A failed-turn entry repeats until a turn starts, so like an answer it waits for a usable
        // read and is never recorded as delivered.
        if (FAILED_TURN_ENTRY.test(entry)) {
          return isAnswerReadUsable
        }

        const id = releasedItemId(entry)
        if (id === undefined) {
          return true
        }

        return isAnswerReadUsable && !delivered.has(id)
      })

      if (wake.length > 0) {
        await $.prompt.submit({ text: wake.join('\n') })
      }

      if (isAnswerReadUsable) {
        // Recorded only after the submit, so one that rejects leaves the answer to be delivered by
        // the next check. Only ids the check still reports are kept on a complete read: a consumed
        // answer drops out, so the list stays as small as the board's open set. A partial read
        // cannot tell consumed from unread, so it only adds.
        await $.store.set(
          deliveredKey,
          exitCode === 0 ? reportedIds : [...new Set([...delivered, ...reportedIds])]
        )
      }
    })

    return started
  })
}

const releasedItemId = (entry: string): string | undefined => RELEASED_ITEM.exec(entry)?.[1]

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
