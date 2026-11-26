import { rmSync } from 'node:fs'
import { claimLockWithin, releaseLockAt } from '../pr-monitor/lock.ts'
import {
  atomicWrite,
  readClassified,
  sessionGlobalScope,
  storePath,
} from '../workflow-store/store.ts'
import type { BackgroundTask } from './background-wait.ts'
import type { TeammateIdentity } from './lead.ts'
import { invokeDashboardBin, resolveDashboardBin } from './invoke.ts'
import { loadRegistry, registryLeaves } from './registry.ts'

// A lead's busy teammates and its own last stop tasks, kept in the lead's session scope. The engine
// reports an idle teammate as running, so the lead learns which teammates are busy from the
// teammates' own turn starts and ends instead of from its Stop payload.

const TEAMMATES_FILE = 'teammate-turns.json'
const STOP_TASKS_FILE = 'stop-tasks.json'
const LOCK_FILE = 'teammate-turns.lock'
// A holder of the lock makes one board call per own leaf, 5s each (DASHBOARD_INVOKE_TIMEOUT_MS), so
// 15s covers a lead with three leaves. hooks/wake.ts sizes its turn-start timeout from this.
const LOCK_WAIT_MS = 15_000
const LOCK_POLL_MS = 50
export const TEAMMATE_TASK_TYPE = 'teammate'

interface TeammateTurn {
  label: string
  pid: number
  startedAt: string
  endedAt?: string
}

interface StopTasks {
  at: string
  tasks: BackgroundTask[]
}

/**
 * A teammate's turn started at `startedAt`: it joins the lead's busy list, and a lead at rest is
 * re-recorded. A start older than the teammate's recorded turn end belongs to a turn that already
 * ended, whatever order the two reached the lock in, so it is dropped.
 */
export const teammateTurnStarted = (
  leadId: string,
  teammateId: string,
  identity: TeammateIdentity,
  startedAt: string
): void =>
  withLeadLock(leadId, () => {
    const turns = liveTurns(readTurns(leadId))
    const endedAt = turns[teammateId]?.endedAt
    if (endedAt !== undefined && startedAt < endedAt) {
      return
    }

    turns[teammateId] = { label: identity.label, pid: identity.pid, startedAt }
    writeTurns(leadId, turns)
    rerecordLeadWait(leadId, turns)
  })

/**
 * A teammate's turn ended: it leaves the lead's busy list, and a lead at rest is re-recorded. The
 * end instant stays on the entry so a start that arrives later for the same turn is recognised.
 */
export const teammateTurnEnded = (
  leadId: string,
  teammateId: string,
  identity: TeammateIdentity
): void =>
  withLeadLock(leadId, () => {
    const turns = liveTurns(readTurns(leadId))
    const endedAt = new Date().toISOString()
    const entry = turns[teammateId] ?? {
      label: identity.label,
      pid: identity.pid,
      startedAt: endedAt,
    }
    turns[teammateId] = { ...entry, endedAt }
    writeTurns(leadId, turns)
    rerecordLeadWait(leadId, turns)
  })

/**
 * The lead's own Stop (runWait): keeps `tasks` so a teammate's turn change can rebuild the lead's
 * wait, and records them with each live busy teammate appended on the lead's own leaves. The read
 * and the record are one locked step, so no teammate re-record lands between them.
 */
export const leadStopped = (leadId: string, tasks: BackgroundTask[]): void =>
  withLeadLock(leadId, () => {
    const stop: StopTasks = { at: new Date().toISOString(), tasks }
    atomicWrite(storePath(sessionGlobalScope(leadId), STOP_TASKS_FILE), `${JSON.stringify(stop)}\n`)
    recordLeadWait(leadId, [...tasks, ...teammateTasks(liveTurns(readTurns(leadId)))])
  })

/**
 * A turn of this session started: its last stop tasks no longer describe it. When they are removed,
 * the wait on its own leaves is cleared in the same locked step, without a recorded-before bound:
 * every wait on the node came from that Stop or from a teammate re-record built on it, and a
 * re-record that ran after the turn's start would otherwise survive a bounded clear. A re-record
 * that waited on the lock then finds no stop tasks and records nothing.
 */
export const forgetLeadStopTasks = (leadId: string, startedAt: string): void =>
  withLeadLock(leadId, () => {
    const stop = readStopTasks(leadId)
    if (stop === undefined || stop.at >= startedAt) {
      return
    }

    recordLeadWait(leadId, [])
    rmSync(storePath(sessionGlobalScope(leadId), STOP_TASKS_FILE), { force: true })
  })

/**
 * The lead's wait is cleared (runWait with no payload), as one locked step: a Stop recorded before
 * `recordedBefore` (any Stop, whatever its timestamp, when there is none) is removed, so a later
 * teammate turn change does not restore the cleared tasks, and every own leaf is cleared. When a
 * Stop is removed the clear carries no bound, which wipes a teammate re-record written after the
 * bound on top of that Stop. Otherwise each leaf is cleared limited to a wait recorded before
 * `recordedBefore` when one is given. A lock that cannot be claimed changes nothing: the leaves and
 * the Stop stay as they were.
 */
export const clearLeadWait = (leadId: string, recordedBefore?: string): void =>
  withLeadLock(leadId, () => {
    const stop = readStopTasks(leadId)
    if (stop !== undefined && (recordedBefore === undefined || stop.at < recordedBefore)) {
      clearOwnLeaves(leadId)
      rmSync(storePath(sessionGlobalScope(leadId), STOP_TASKS_FILE), { force: true })
      return
    }

    clearOwnLeaves(leadId, recordedBefore)
  })

/**
 * The process ids of this lead's teammates that have a turn recorded in the turn list their own turn
 * starts and ends write. An absent list means no teammate has recorded a turn yet. null when the
 * list exists but cannot be read or is not a turn list: which teammates recorded a turn is then
 * unknown, not none.
 */
export const startedTeammatePids = (leadId: string): Set<number> | null => {
  const read = readClassified(storePath(sessionGlobalScope(leadId), TEAMMATES_FILE))
  if (read.kind === 'absent') {
    return new Set()
  }

  if (read.kind === 'unreadable') {
    return null
  }

  const parsed = parseJson(read.content)
  return isTurns(parsed) ? new Set(Object.values(parsed).map((turn) => turn.pid)) : null
}

/**
 * The labels of this lead's teammates whose turn is under way: started, not yet ended, and with a
 * process still running. Read without the lock, for a reader that only decides whether the lead
 * has a wait (the Stop gate); every writer replaces the file whole, so a read sees one version or
 * the other. An absent, unreadable or malformed list reads as none: the caller treats a busy
 * teammate as a reason to stop quietly, so an unknown list must not grant one.
 */
export const busyTeammateLabels = (leadId: string): string[] =>
  teammateTasks(liveTurns(readTurns(leadId)))
    .map((task) => task.label)
    .sort()

const rerecordLeadWait = (leadId: string, turns: Record<string, TeammateTurn>): void => {
  const stop = readStopTasks(leadId)
  if (stop === undefined) {
    return
  }

  recordLeadWait(leadId, [...stop.tasks, ...teammateTasks(turns)])
}

// Records `tasks` as the wait on the lead's own leaves, or clears it when there are none.
const recordLeadWait = (leadId: string, tasks: BackgroundTask[]): void => {
  if (tasks.length === 0) {
    clearOwnLeaves(leadId)
    return
  }

  waitOnOwnLeaves(leadId, ['--tasks', JSON.stringify(tasks)])
}

// Clears the wait on the lead's own leaves, limited to a wait recorded before `recordedBefore` when
// one is given.
const clearOwnLeaves = (leadId: string, recordedBefore?: string): void =>
  waitOnOwnLeaves(
    leadId,
    recordedBefore === undefined ? ['--clear'] : ['--clear', '--recorded-before', recordedBefore]
  )

const waitOnOwnLeaves = (leadId: string, flags: string[]): void => {
  const bin = resolveDashboardBin()
  if (bin === null) {
    return
  }

  for (const leaf of registryLeaves(loadRegistry(leadId))) {
    invokeDashboardBin(bin, ['session', 'wait', '--id', leaf.internalId, ...flags], { quiet: true })
  }
}

const teammateTasks = (turns: Record<string, TeammateTurn>): BackgroundTask[] =>
  Object.values(turns)
    .filter((turn) => turn.endedAt === undefined)
    .map((turn) => ({ type: TEAMMATE_TASK_TYPE, label: turn.label }))

// An entry whose teammate process has exited is dropped: the fact is read now, never scheduled. A
// teammate interrupted mid-turn fires no Stop, so it stays on its lead's node until its next turn
// ends; no event corrects it sooner and no timer is added.
const liveTurns = (turns: Record<string, TeammateTurn>): Record<string, TeammateTurn> =>
  Object.fromEntries(Object.entries(turns).filter(([, turn]) => isAlive(turn.pid)))

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const readTurns = (leadId: string): Record<string, TeammateTurn> => {
  const read = readClassified(storePath(sessionGlobalScope(leadId), TEAMMATES_FILE))
  if (read.kind !== 'content') {
    return {}
  }

  const parsed = parseJson(read.content)
  return isTurns(parsed) ? parsed : {}
}

const writeTurns = (leadId: string, turns: Record<string, TeammateTurn>): void =>
  atomicWrite(storePath(sessionGlobalScope(leadId), TEAMMATES_FILE), `${JSON.stringify(turns)}\n`)

const readStopTasks = (leadId: string): StopTasks | undefined => {
  const read = readClassified(storePath(sessionGlobalScope(leadId), STOP_TASKS_FILE))
  if (read.kind !== 'content') {
    return undefined
  }

  const parsed = parseJson(read.content)
  return isStopTasks(parsed) ? parsed : undefined
}

// Text that is not JSON reads like JSON of the wrong shape: the caller's shape check refuses it.
const parseJson = (content: string): unknown => {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

// DASHBOARD_TEAMMATE_TURNS_LOCK_WAIT_MS overrides the 15 s wait bound; a test sets it to reach the
// timeout without waiting it out.
const lockWaitMs = (): number => {
  const override = Number(process.env.DASHBOARD_TEAMMATE_TURNS_LOCK_WAIT_MS)
  return Number.isFinite(override) && override > 0 ? override : LOCK_WAIT_MS
}

// A lock it cannot claim in time means another writer is stuck; the change is dropped rather than
// written unlocked.
const withLeadLock = (leadId: string, body: () => void): void => {
  const lockPath = storePath(sessionGlobalScope(leadId), LOCK_FILE)
  if (!claimLockWithin(lockPath, 'teammate turns', lockWaitMs(), LOCK_POLL_MS)) {
    process.stderr.write('dashboard: teammate turns are locked by another writer; skipped\n')
    return
  }

  try {
    body()
  } finally {
    releaseLockAt(lockPath)
  }
}

const isTurns = (value: unknown): value is Record<string, TeammateTurn> =>
  isObject(value) &&
  Object.values(value).every(
    (turn) =>
      isObject(turn) &&
      typeof turn.label === 'string' &&
      typeof turn.pid === 'number' &&
      typeof turn.startedAt === 'string' &&
      (turn.endedAt === undefined || typeof turn.endedAt === 'string')
  )

const isStopTasks = (value: unknown): value is StopTasks =>
  isObject(value) && typeof value.at === 'string' && Array.isArray(value.tasks)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
