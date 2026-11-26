import { readFileSync } from 'node:fs'
import { resolveDashboardBin } from './invoke.ts'
import { resolveRawSessionId } from './session-id.ts'
import { clearLeadWait, leadStopped } from './teammate-turns.ts'
import { loadWatchedFor } from '../pr-monitor/state.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

/** One piece of background work in the board's shape. */
export interface BackgroundTask {
  type: string
  label: string
}

const LABEL_MAX = 120
const TEAMMATE_TYPE = 'teammate'
const WATCHED_PR_TASK_TYPE = 'pr-monitor'
const LABEL_FIELDS = ['command', 'tool', 'name', 'description'] as const
const SUBAGENT_LABEL_FIELDS = ['description', 'agent_type'] as const

/**
 * Records the caller's background wait on its own board leaves, or clears it.
 *
 * `payload` is the Stop hook's JSON text; null means clear; a payload with `recordedBefore` (an
 * ISO instant) is refused. A payload is recorded through `leadStopped`: its tasks plus each live
 * busy teammate, written under the lead's lock, cleared only when both are empty, and not written
 * at all when the lock cannot be claimed in time. A clear is `clearLeadWait`, one locked step: it
 * removes a recorded Stop older than `recordedBefore` (any Stop when there is none), so a later
 * teammate turn change does not restore the cleared tasks, and clears every own leaf without the
 * bound, which includes a teammate re-record written after the bound on top of that older Stop.
 * With no such Stop it clears each own leaf, limited to a wait recorded before `recordedBefore`
 * when one is given. A lock that cannot be claimed in time changes nothing. Only the session's own
 * leaves are
 * touched, so a caller with no leaf of its own records nothing. A teammate has one only once the
 * board holds a node it owns (permission-hold.sh nests one under its lead when it first asks for a
 * permission); until then its Stop records nothing. It deliberately omits the lead's leaves, unlike
 * a heartbeat: a teammate's wait on the lead's node would collide with the lead's own record and
 * clear. A teammate's busy turns reach its lead's record through `teammate-turns.ts`, not through
 * the payload. Every board call is quiet, because a failed record must never fail the stop or the turn
 * that triggered it.
 */
export const runWait = (
  session: string | undefined,
  payload: string | null,
  recordedBefore?: string
): void => {
  if (payload !== null && recordedBefore !== undefined) {
    process.stderr.write('--recorded-before needs --clear\n')
    setRequestedExitCode(1)
    return
  }

  const bin = resolveDashboardBin()
  if (bin === null) {
    return
  }

  try {
    const rawId = resolveRawSessionId(session)
    if (payload !== null) {
      leadStopped(rawId, [
        ...backgroundTasksFromStopPayload(JSON.parse(payload)),
        ...watchedPrTasks(rawId),
      ])
      return
    }

    clearLeadWait(rawId, recordedBefore)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    setRequestedExitCode(1)
  }
}

/** Reads the whole of stdin, where the Stop hook pipes its payload. */
export const readStdin = (): string => readFileSync(0, 'utf8')

/**
 * Maps the Stop payload's `background_tasks` to board tasks, leaving teammates out: the engine
 * reports an idle teammate as running, so a teammate entry cannot tell a busy teammate from an idle
 * one. The label is the most specific text the engine gives for the task type, falling back to its
 * description and then the type itself (a subagent's is its description, then its agent type), and
 * is clipped so a long command cannot flood the card. A payload with no list, or entries that are
 * not objects, yields no tasks: the engine's contract may grow, and an unknown shape must read as
 * "not waiting" rather than fail the stop.
 */
export const backgroundTasksFromStopPayload = (payload: unknown): BackgroundTask[] => {
  if (!isObject(payload) || !Array.isArray(payload.background_tasks)) {
    return []
  }

  return payload.background_tasks
    .filter(isObject)
    .filter((task) => task.type !== TEAMMATE_TYPE)
    .map((task) => {
      const type = typeof task.type === 'string' && task.type !== '' ? task.type : 'task'
      return { type, label: clip(firstLabel(task) ?? type) }
    })
}

/**
 * The PRs this session watches, as board tasks: a watched PR is a wait the wake mod answers, so a
 * session parked on one is waiting on it, not idle. The label is the PR's own `owner/repo#N`.
 */
export const watchedPrTasks = (rawSessionId: string): BackgroundTask[] =>
  loadWatchedFor(rawSessionId).map((pr) => ({
    type: WATCHED_PR_TASK_TYPE,
    label: clip(`${pr.repo}#${pr.prNumber}`),
  }))

const firstLabel = (task: Record<string, unknown>): string | undefined => {
  const fields = task.type === 'subagent' ? SUBAGENT_LABEL_FIELDS : LABEL_FIELDS

  for (const field of fields) {
    const value = task[field]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }

  return undefined
}

const clip = (text: string): string => {
  const characters = Array.from(text)

  return characters.length > LABEL_MAX ? `${characters.slice(0, LABEL_MAX - 1).join('')}…` : text
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
