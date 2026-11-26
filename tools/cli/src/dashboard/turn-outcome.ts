import { existsSync } from 'node:fs'
import { flagValueArgs, invokeDashboardBin, resolveDashboardBin } from './invoke.ts'
import { parseBoardNodes, type BoardNode } from './board-nodes.ts'
import { ensureSessionConversationNode } from './item.ts'
import { loadRegistry, registryLeaves } from './registry.ts'
import { tryResolveRawSessionId } from './session-id.ts'
import { teammateTurnEnded, teammateTurnStarted, forgetLeadStopTasks } from './teammate-turns.ts'
import { resolveTeammateIdentity } from './lead.ts'
import { atomicWrite, sessionGlobalScope, storePath } from '../workflow-store/store.ts'
import { getRequestedExitCode, setRequestedExitCode } from '../runtime-exit-code.ts'

export type TurnOutcome = 'finished' | 'failed'

const INTERACTIVE_MARKER = 'interactive'
const CONVERSATION_FALLBACK_TEXT = 'Conversation'

/**
 * Records how this session's turn ended on its own board leaves. `payload` is the Stop or
 * StopFailure hook's JSON. A session with no leaf opens its conversation root first when it is
 * interactive, is not a teammate, and the board holds no node of any lifecycle for it; a teammate
 * instead leaves its lead's busy list. A failure is reported on stderr and never changes the exit
 * code: a failed record must never fail the turn's end.
 */
export const runTurnEnd = (
  session: string | undefined,
  outcome: TurnOutcome,
  payload: string
): void => {
  withoutExitCode(() => recordTurnEnd(session, outcome, payload))
}

/**
 * The turn-start half: clears an outcome recorded before `startedAt` on the session's own leaves,
 * marks the session interactive when asked, and in a teammate joins its lead's busy list. Fails
 * as `runTurnEnd` does: reported on stderr, exit code unchanged.
 */
export const runTurnStart = (
  session: string | undefined,
  startedAt: string,
  interactive: boolean
): void => {
  withoutExitCode(() => recordTurnStart(session, startedAt, interactive))
}

// Runs `body` so that nothing it does, including the shared node-opening and board helpers that
// request a non-zero exit on failure, leaves the process exiting non-zero.
const withoutExitCode = (body: () => void): void => {
  const exitBefore = getRequestedExitCode()
  try {
    body()
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  } finally {
    setRequestedExitCode(exitBefore ?? 0)
  }
}

const recordTurnEnd = (
  session: string | undefined,
  outcome: TurnOutcome,
  payload: string
): void => {
  const rawId = tryResolveRawSessionId(session)
  if (rawId === null) {
    return
  }

  const parsed: unknown = JSON.parse(payload)
  if (isObject(parsed) && typeof parsed.agent_id === 'string' && parsed.agent_id !== '') {
    return
  }

  const teammate = resolveTeammateIdentity(rawId)
  if (teammate !== undefined && teammate !== null) {
    teammateTurnEnded(teammate.leadSessionId, rawId, teammate)
  }

  const bin = resolveDashboardBin()
  if (bin === null) {
    return
  }

  const message = turnMessage(outcome, parsed)
  let leaves = ownLeaves(rawId)
  if (leaves.length === 0) {
    if (teammate !== undefined || !existsSync(interactiveMarkerPath(rawId))) {
      return
    }

    if (!boardHoldsNoNodeOf(rawId, bin)) {
      return
    }

    if (!ensureSessionConversationNode(rawId, message ?? CONVERSATION_FALLBACK_TEXT, bin)) {
      return
    }

    leaves = ownLeaves(rawId)
  }

  const messageArgs = message === undefined ? [] : flagValueArgs('--message', message)
  for (const id of leaves) {
    invokeDashboardBin(bin, ['session', 'turn', '--id', id, '--outcome', outcome, ...messageArgs], {
      quiet: true,
    })
  }
}

const recordTurnStart = (
  session: string | undefined,
  startedAt: string,
  interactive: boolean
): void => {
  const rawId = tryResolveRawSessionId(session)
  if (rawId === null) {
    return
  }

  if (interactive) {
    atomicWrite(interactiveMarkerPath(rawId), `${startedAt}\n`)
  }

  forgetLeadStopTasks(rawId, startedAt)

  const teammate = resolveTeammateIdentity(rawId)
  if (teammate !== undefined && teammate !== null) {
    teammateTurnStarted(teammate.leadSessionId, rawId, teammate, startedAt)
  }

  const bin = resolveDashboardBin()
  if (bin === null) {
    return
  }

  for (const id of ownLeaves(rawId)) {
    invokeDashboardBin(
      bin,
      ['session', 'turn', '--id', id, '--clear', '--recorded-before', startedAt],
      {
        quiet: true,
      }
    )
  }
}

// True only when the board answered and lists no node, active, paused, ended or closed, for this
// session: a session that ended or paused its node must not get a new one from the turn that
// ended it. It takes up to two calls because the board's `--lifecycle` filter accepts only active,
// ended and closed (ai-review-tool `packages/cli/src/cli/commands/session/list/command.ts`,
// `sessionListCommand`'s lifecycle enum), and with no filter the list holds everything except
// closed, paused included (`packages/services/src/sessions/list.ts`, `isLifecycleAllowed`).
// `--lifecycle closed` holds the rest, and is read only when the unfiltered list is empty. A failed
// or unparseable read is not evidence the session has none.
const boardHoldsNoNodeOf = (rawId: string, bin: string): boolean => {
  const unclosed = listNodesOf(rawId, bin, [])
  if (unclosed === null || unclosed.length > 0) {
    return false
  }

  const closed = listNodesOf(rawId, bin, ['--lifecycle', 'closed'])
  return closed !== null && closed.length === 0
}

const listNodesOf = (rawId: string, bin: string, filter: string[]): BoardNode[] | null => {
  const out = invokeDashboardBin(bin, ['session', 'list', ...filter], { quiet: true })
  if (out === null) {
    return null
  }

  const parsed = parseBoardNodes(out, rawId)
  return parsed.ok ? parsed.nodes : null
}

// Exported for the unit test.
export const turnMessage = (outcome: TurnOutcome, payload: unknown): string | undefined => {
  if (!isObject(payload)) {
    return undefined
  }

  const last = nonBlank(payload.last_assistant_message)
  if (outcome === 'finished') {
    return last
  }

  const error = nonBlank(payload.error) ?? 'unknown'
  const details = nonBlank(payload.error_details)
  const head = details === undefined ? error : `${error}: ${details}`
  return last === undefined ? head : `${head}\n\n${last}`
}

const ownLeaves = (rawId: string): string[] =>
  registryLeaves(loadRegistry(rawId)).map((leaf) => leaf.internalId)

const interactiveMarkerPath = (rawId: string): string =>
  storePath(sessionGlobalScope(rawId), INTERACTIVE_MARKER)

const nonBlank = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
