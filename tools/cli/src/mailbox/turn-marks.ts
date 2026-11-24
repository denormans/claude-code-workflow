import { copyFileSync } from 'node:fs'
import {
  atomicWrite,
  readClassified,
  sessionGlobalScope,
  storePath,
} from '../workflow-store/store.ts'

// The prompts a session has started, in start order, kept beside the failed-turn record and written
// under its lock whether or not a failure exists. A prompt is marked succeeded when its turn stops.

const MARKS_FILENAME = 'turn-marks.json'
const MAX_STARTED = 8

interface TurnMark {
  promptId: string
  at: string
  succeeded?: true
  // A success recorded for a prompt whose start was never marked; `at` is when the success landed.
  unplaced?: true
}

export interface TurnMarks {
  started: TurnMark[]
  // Set when the file exists and cannot be read or parsed. `started` is then empty and says
  // nothing about the session's turns.
  damage?: 'unreadable' | 'malformed'
}

// An absent file is an empty history; a file that exists and cannot be read is `damage`, never an
// empty history.
export const loadTurnMarks = (rawSessionId: string): TurnMarks => {
  const read = readClassified(marksPath(rawSessionId))
  if (read.kind === 'absent') {
    return { started: [] }
  }

  if (read.kind !== 'content') {
    return { started: [], damage: 'unreadable' }
  }

  try {
    const parsed = JSON.parse(read.content) as { started?: unknown }
    if (!Array.isArray(parsed.started)) {
      return { started: [], damage: 'malformed' }
    }

    if (!parsed.started.every(isTurnMark)) {
      return { started: [], damage: 'malformed' }
    }

    return { started: parsed.started }
  } catch {
    return { started: [], damage: 'malformed' }
  }
}

const isTurnMark = (entry: unknown): entry is TurnMark => {
  const mark = entry as Partial<Record<keyof TurnMark, unknown>> | null

  return (
    typeof mark?.promptId === 'string' &&
    typeof mark.at === 'string' &&
    !Number.isNaN(Date.parse(mark.at)) &&
    (mark.succeeded === undefined || mark.succeeded === true) &&
    (mark.unplaced === undefined || mark.unplaced === true)
  )
}

// Extends the marks with `change`. The bytes of a malformed file are copied to `<file>.damaged`,
// replacing an earlier copy, before the new history is written over the original, so a write that
// fails leaves the damaged file in place and still reading as damaged. Without the record lock a
// malformed file is left alone and nothing is written. A file that cannot be read is written over,
// and the write's error reaches the caller.
export const updateTurnMarks = (
  rawSessionId: string,
  lockHeld: boolean,
  change: (marks: TurnMarks) => TurnMarks
): void => {
  const marks = loadTurnMarks(rawSessionId)
  if (marks.damage === 'malformed') {
    if (!lockHeld) {
      return
    }

    try {
      copyFileSync(marksPath(rawSessionId), `${marksPath(rawSessionId)}.damaged`)
    } catch {
      return
    }
  }

  atomicWrite(marksPath(rawSessionId), JSON.stringify(change(marks)))
}

export const withStarted = (marks: TurnMarks, promptId: string, at: string): TurnMarks => {
  const existing = marks.started.find((entry) => entry.promptId === promptId)

  return place(marks, {
    promptId,
    at,
    ...(existing?.succeeded === true ? { succeeded: true } : {}),
  })
}

// A marked prompt keeps its position. A prompt never seen is recorded as `unplaced`: its success
// is kept so a start mark that arrives late finds it, but it has no position among the turns that
// do. `failureOrder` ignores it in both of its reads for an unmarked prompt, the later-start check
// and the last-succeeded check, so it neither proves a later turn nor hides a running one. Only
// `succeededAfterFailure` counts it for an unmarked prompt, by `at`.
export const withSucceeded = (marks: TurnMarks, promptId: string, at: string): TurnMarks =>
  isMarked(marks, promptId)
    ? {
        started: marks.started.map((entry) =>
          entry.promptId === promptId ? { ...entry, succeeded: true } : entry
        ),
      }
    : place(marks, { promptId, at, succeeded: true, unplaced: true })

const isMarked = (marks: TurnMarks, promptId: string): boolean => indexOf(marks, promptId) >= 0

export type FailureOrder = 'later' | 'unproven' | 'resumable'

// How the turns marked so far stand against the failure of `promptId`. A marked prompt is ordered
// by position. For an unmarked one a mark that began at or after `failureAt` proves a later turn;
// otherwise a mark after the last succeeded turn is unproven, since it may be a later turn or an
// older one that was interrupted, and neither sets `succeeded`. Marks that could not be read prove
// nothing, so every failure stands unproven.
export const failureOrder = (
  marks: TurnMarks,
  promptId: string,
  failureAt: string
): FailureOrder => {
  if (marks.damage !== undefined) {
    return 'unproven'
  }

  const turns = placed(marks)
  const index = indexOf(marks, promptId)
  if (index >= 0) {
    return index < turns.length - 1 ? 'later' : 'resumable'
  }

  if (turns.some((entry) => Date.parse(entry.at) >= Date.parse(failureAt))) {
    return 'later'
  }

  const lastSucceeded = turns.findLastIndex((entry) => entry.succeeded === true)

  return lastSucceeded < turns.length - 1 ? 'unproven' : 'resumable'
}

// Whether a turn that started after the failure of `promptId` has succeeded, ordered as above.
export const succeededAfterFailure = (
  marks: TurnMarks,
  promptId: string,
  failureAt: string
): boolean => {
  const index = indexOf(marks, promptId)
  if (index >= 0) {
    return placed(marks)
      .slice(index + 1)
      .some((entry) => entry.succeeded === true)
  }

  return marks.started.some(
    (entry) => entry.succeeded === true && Date.parse(entry.at) >= Date.parse(failureAt)
  )
}

// Whether both prompts are known and `olderId` is positioned before `laterId`.
export const isOlder = (marks: TurnMarks, olderId: string, laterId: string): boolean => {
  const older = indexOf(marks, olderId)
  const later = indexOf(marks, laterId)

  return older >= 0 && later >= 0 && older < later
}

const place = (marks: TurnMarks, mark: TurnMark): TurnMarks => {
  const byAt = (first: TurnMark, second: TurnMark): number =>
    Date.parse(first.at) - Date.parse(second.at)
  const all = [...marks.started.filter((entry) => entry.promptId !== mark.promptId), mark].sort(
    byAt
  )
  const newest = (unplaced: boolean): TurnMark[] =>
    all.filter((entry) => (entry.unplaced === true) === unplaced).slice(-MAX_STARTED)

  return { started: [...newest(false), ...newest(true)].sort(byAt) }
}

const placed = (marks: TurnMarks): TurnMark[] => marks.started.filter((entry) => !entry.unplaced)

const indexOf = (marks: TurnMarks, promptId: string): number =>
  placed(marks).findIndex((entry) => entry.promptId === promptId)

const marksPath = (rawSessionId: string): string =>
  storePath(sessionGlobalScope(rawSessionId), MARKS_FILENAME)
