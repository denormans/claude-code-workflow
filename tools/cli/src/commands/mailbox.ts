import { readFileSync } from 'node:fs'
import { buildCommand, buildRouteMap } from '@stricli/core'
import { isBoardSession, runCheck } from '../mailbox/check.ts'
import {
  clearFailedTurn,
  markTurnStarted,
  boardItemState,
  boardNodeOf,
  postBoardItem,
  recordFailedTurn,
  type StopFailureInput,
  withdrawBoardItem,
} from '../mailbox/failed-turn.ts'
import { runStopGate } from '../mailbox/stop-gate.ts'
import { runTeammates } from '../mailbox/teammate-deaths.ts'

const sessionFlag = {
  kind: 'parsed' as const,
  parse: String,
  brief: 'Session id (defaults to CLAUDE_CODE_SESSION_ID)',
  optional: true as const,
}

const checkCommand = buildCommand({
  docs: {
    brief:
      'Run every wake source once — released board answers, dead monitors, dead teammates — print what to wake for, and exit (called by the wake mod)',
  },
  parameters: { flags: { session: sessionFlag }, positional: { kind: 'tuple', parameters: [] } },
  func(flags: { session?: string }) {
    runCheck(flags.session)
  },
})

const stopGateCommand = buildCommand({
  docs: {
    brief: 'Print allow/block: bounded gate the Stop hook calls (does not loop forever)',
  },
  parameters: {
    flags: {
      session: sessionFlag,
      'payload-stdin': {
        kind: 'boolean',
        default: false,
        brief:
          'Read the Stop hook payload from stdin, so a non-teammate background task it lists counts as a wait',
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { session?: string; 'payload-stdin': boolean }) {
    runStopGate(flags.session, flags['payload-stdin'] ? readFileSync(0, 'utf8') : undefined)
  },
})

const teammatesCommand = buildCommand({
  docs: {
    brief:
      "Print this session's teammates as JSON — pid null means no process (dead) — plus orphan teammate processes that left the roster; after the harness removes the team, the roster last seen, with dissolved: true",
  },
  parameters: { flags: { session: sessionFlag }, positional: { kind: 'tuple', parameters: [] } },
  func(flags: { session?: string }) {
    runTeammates(flags.session)
  },
})

const requiredSessionFlag = {
  kind: 'parsed' as const,
  parse: String,
  brief: 'Raw session id',
}

const turnFailedCommand = buildCommand({
  docs: {
    brief:
      'Record a failed turn from the StopFailure hook payload on stdin, so the next check resumes the session; called by the StopFailure hook',
  },
  parameters: {
    flags: { session: requiredSessionFlag },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { session: string }) {
    process.env.CLAUDE_CODE_SESSION_ID = flags.session
    recordFailedTurn(
      parseStopFailure(readFileSync(0, 'utf8')),
      flags.session,
      isBoardSession(flags.session),
      postBoardItem(flags.session),
      new Date(),
      boardItemState(flags.session),
      boardNodeOf(flags.session)
    )
  },
})

const turnStartedCommand = buildCommand({
  docs: {
    brief:
      'Record that a turn started, under its prompt id or one generated here; a failure that turn is later than stops printing its failed-turn entry; called by the wake mod',
  },
  parameters: {
    flags: {
      session: requiredSessionFlag,
      'started-at': {
        kind: 'parsed' as const,
        parse: (value: string) => parseInstant(value),
        brief: 'ISO instant the turn began',
      },
      'prompt-id': {
        kind: 'parsed' as const,
        parse: String,
        brief: 'Id of the prompt the turn belongs to',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { session: string; 'started-at': string; 'prompt-id'?: string }) {
    markTurnStarted(flags.session, flags['started-at'], flags['prompt-id'])
  },
})

const turnSucceededCommand = buildCommand({
  docs: {
    brief:
      'Record the stopped turn as succeeded and, unless its prompt is provably older than the failed one, clear the failed-turn record and withdraw the board items it holds; called by the Stop hook',
  },
  parameters: {
    flags: {
      session: requiredSessionFlag,
      'prompt-id': {
        kind: 'parsed' as const,
        parse: String,
        brief: 'Id of the prompt whose turn stopped',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { session: string; 'prompt-id'?: string }) {
    clearFailedTurn(flags.session, withdrawBoardItem(flags.session), flags['prompt-id'])
  },
})

const parseStopFailure = (raw: string): StopFailureInput => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }

    return {
      session_id: stringField(parsed.session_id),
      error: stringField(parsed.error),
      error_details: stringField(parsed.error_details),
      prompt_id: stringField(parsed.prompt_id),
      last_assistant_message: stringField(parsed.last_assistant_message),
    }
  } catch {
    return {}
  }
}

const stringField = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const parseInstant = (value: string): string => {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`not a timestamp: ${value}`)
  }

  return value
}

export const mailboxRoutes = buildRouteMap({
  routes: {
    check: checkCommand,
    'stop-gate': stopGateCommand,
    teammates: teammatesCommand,
    'turn-failed': turnFailedCommand,
    'turn-started': turnStartedCommand,
    'turn-succeeded': turnSucceededCommand,
  },
  docs: {
    brief: 'Wake-source check for the wake mod, the Stop hook gate, and the teammate roster',
  },
})
