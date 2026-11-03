import { readFileSync } from 'node:fs'
import { invokeDashboardBin, resolveDashboardBin } from './invoke.ts'
import { loadRegistry, registryLeaves } from './registry.ts'
import { resolveRawSessionId } from './session-id.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

/** One piece of background work in the board's shape. */
export interface BackgroundTask {
  type: string
  label: string
}

const LABEL_MAX = 120
const TEAMMATE_TYPE = 'teammate'
const LABEL_FIELDS = ['command', 'tool', 'name', 'description'] as const
const SUBAGENT_LABEL_FIELDS = ['description', 'agent_type'] as const

/**
 * Records the caller's background wait on its own board leaves, or clears it.
 *
 * `payload` is the Stop hook's JSON text; null means clear, and then `recordedBefore` (an ISO
 * instant) limits the clear to a wait recorded before it; a payload with `recordedBefore` is
 * refused. A payload with no tasks clears unconditionally. Only the session's own leaves are
 * touched, so a caller with no leaf of its own records nothing. A teammate has one only once the
 * board holds a node it owns (permission-hold.sh nests one under its lead when it first asks for a
 * permission); until then its Stop records nothing. It deliberately omits the lead's leaves, unlike
 * a heartbeat: a teammate's wait on the lead's node would collide with the lead's own record and
 * clear. Every board call is quiet, because a failed record must never fail the stop or the turn
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

  let leaves: string[]
  let tasks: BackgroundTask[]
  try {
    leaves = registryLeaves(loadRegistry(resolveRawSessionId(session))).map(
      (leaf) => leaf.internalId
    )
    tasks = payload === null ? [] : backgroundTasksFromStopPayload(JSON.parse(payload))
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    setRequestedExitCode(1)
    return
  }

  const clearFlags =
    recordedBefore !== undefined ? ['--clear', '--recorded-before', recordedBefore] : ['--clear']
  const flags = tasks.length === 0 ? clearFlags : ['--tasks', JSON.stringify(tasks)]
  for (const id of leaves) {
    invokeDashboardBin(bin, ['session', 'wait', '--id', id, ...flags], { quiet: true })
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
