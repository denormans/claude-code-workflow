import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { runTurnEnd, runTurnStart, turnMessage } from './turn-outcome.ts'
import { loadRegistry, upsertRegistryNode } from './registry.ts'
import { sessionGlobalScope, storePath } from '../workflow-store/store.ts'
import { getRequestedExitCode, setRequestedExitCode } from '../runtime-exit-code.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

let tmpDir: string
let homeDir: string
let rawId: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['AI_WORKFLOW_APP_BIN', 'CLAUDE_CODE_SESSION_ID', 'HOME', 'PATH'] as const

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
  }

  tmpDir = mkdtempSync(join(tmpdir(), 'turn-outcome-test-'))
  process.env.PATH = `${writeLonePsStub(tmpDir)}:${process.env.PATH ?? ''}`
  homeDir = mkdtempSync(join(tmpdir(), 'turn-outcome-test-home-'))
  process.env.HOME = homeDir
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'no-such-ai-workflow-app')
  rawId = `turn-session-${Math.floor(Math.random() * 1e9)}`
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  setRequestedExitCode(0)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = saved[k]
    }
  }

  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
  setRequestedExitCode(0)
})

test('turnMessage: finished keeps the trimmed last message, failed leads with the error', () => {
  assert.equal(turnMessage('finished', { last_assistant_message: '  Done.\n' }), 'Done.')
  assert.equal(turnMessage('finished', {}), undefined)
  assert.equal(
    turnMessage('failed', {
      error: 'rate_limit',
      error_details: '429 Too Many Requests',
      last_assistant_message: 'Half way.',
    }),
    'rate_limit: 429 Too Many Requests\n\nHalf way.'
  )
  assert.equal(turnMessage('failed', {}), 'unknown')
})

test('turn-end finished records the outcome and message once per own leaf', () => {
  registerLeaves(['leaf-1', 'leaf-2'])
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)

  runTurnEnd(undefined, 'finished', JSON.stringify({ last_assistant_message: 'Plan written.' }))

  assert.deepEqual(readCalls(), [
    'session turn --id leaf-1 --outcome finished --message=Plan written.',
    'session turn --id leaf-2 --outcome finished --message=Plan written.',
  ])
})

test('turn-end from an in-process subagent records nothing', () => {
  registerLeaves(['leaf-1'])
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)

  runTurnEnd(
    undefined,
    'finished',
    JSON.stringify({ agent_id: 'agent-7', last_assistant_message: 'Sub done.' })
  )

  assert.deepEqual(readCalls(), [])
})

test('turn-end with no leaf and no interactive marker opens no node and records nothing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)

  runTurnEnd(undefined, 'finished', JSON.stringify({ last_assistant_message: 'Hello.' }))

  assert.deepEqual(readCalls(), [])
  assert.deepEqual(loadRegistry(rawId), [])
})

test('turn-end with no leaf and the interactive marker opens the conversation root, then records', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  runTurnStart(undefined, '2026-11-24T10:00:00.000Z', true)
  assert.ok(existsSync(storePath(sessionGlobalScope(rawId), 'interactive')))

  runTurnEnd(undefined, 'finished', JSON.stringify({ last_assistant_message: 'Hello there.' }))

  const calls = readCalls()
  const [leaf] = loadRegistry(rawId)
  assert.ok(leaf !== undefined)
  assert.deepEqual(calls.slice(0, 2), [LIST_UNCLOSED, LIST_CLOSED])
  assert.ok(calls.some((c) => c.startsWith('session register')))
  assert.equal(
    calls[calls.length - 1],
    `session turn --id ${leaf.internalId} --outcome finished --message=Hello there.`
  )
})

const openNothingWhenOnlyNode = (lifecycle: 'ended' | 'paused' | 'closed'): void => {
  const row = {
    session: {
      id: 'ended-node',
      systemId: 'claude-workflow',
      externalId: `${rawId}_0123abcd`,
      title: 'Earlier work',
      phase: 'conversation',
      lifecycle,
    },
  }
  const listed = JSON.stringify([row])
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    lifecycle === 'closed' ? { closedOut: listed } : { listOut: listed }
  )
  runTurnStart(undefined, '2026-11-24T10:00:00.000Z', true)

  runTurnEnd(undefined, 'finished', JSON.stringify({ last_assistant_message: 'Wrapped up.' }))

  assert.deepEqual(
    readCalls(),
    lifecycle === 'closed' ? [LIST_UNCLOSED, LIST_CLOSED] : [LIST_UNCLOSED]
  )
  assert.deepEqual(loadRegistry(rawId), [])
}

test('turn-end opens no node for an interactive session whose own node the board lists as ended', () => {
  openNothingWhenOnlyNode('ended')
})

test('turn-end opens no node for an interactive session whose own node the board lists as paused', () => {
  openNothingWhenOnlyNode('paused')
})

test('turn-end opens no node for an interactive session whose own node the board lists as closed', () => {
  openNothingWhenOnlyNode('closed')
})

test('turn-end opens no node when the closed list cannot be read', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub({ closedExit: 2 })
  runTurnStart(undefined, '2026-11-24T10:00:00.000Z', true)

  runTurnEnd(undefined, 'finished', JSON.stringify({ last_assistant_message: 'Wrapped up.' }))

  assert.deepEqual(readCalls(), [LIST_UNCLOSED, LIST_CLOSED])
  assert.deepEqual(loadRegistry(rawId), [])
})

test('CLI: turn-end exits 0 with nothing on stdout when the board fails reading or opening the node', () => {
  const startedAt = '2026-11-24T10:00:00.000Z'

  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub({ listExit: 2 })
  const interactiveStart = runCli(['turn-start', '--started-at', startedAt, '--interactive'], '')
  const unreadable = runCli(
    ['turn-end', '--outcome', 'finished'],
    JSON.stringify({ last_assistant_message: 'Hi.' })
  )

  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub({ registerExit: 2 })
  const unopenable = runCli(
    ['turn-end', '--outcome', 'finished'],
    JSON.stringify({ last_assistant_message: 'Hi.' })
  )

  assert.deepEqual(
    [
      interactiveStart.status,
      interactiveStart.stdout,
      interactiveStart.stderr,
      unreadable.status,
      unreadable.stdout,
      unreadable.stderr,
      unopenable.status,
      unopenable.stdout,
      unopenable.stderr,
    ],
    [
      0,
      '',
      '',
      0,
      '',
      `dashboard: ai-workflow-app ${LIST_UNCLOSED} failed: exit 2\n`,
      0,
      '',
      `dashboard: ai-workflow-app session register --system-id claude-workflow --external-id ${unopenableExternalId()} --phase conversation --title=Hi. failed: exit 2\n`,
    ]
  )
  assert.deepEqual(
    readCalls().map((call) => call.split(' ').slice(0, 2).join(' ')),
    ['session list', 'session list', 'session list', 'session list', 'session register']
  )
})

test('turn-start clears with --recorded-before on each leaf, and --interactive writes the marker', () => {
  registerLeaves(['leaf-1', 'leaf-2'])
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  const startedAt = '2026-11-24T10:00:00.000Z'

  runTurnStart(undefined, startedAt, false)
  assert.equal(existsSync(storePath(sessionGlobalScope(rawId), 'interactive')), false)

  runTurnStart(undefined, startedAt, true)

  assert.deepEqual(readCalls(), [
    `session turn --id leaf-1 --clear --recorded-before ${startedAt}`,
    `session turn --id leaf-2 --clear --recorded-before ${startedAt}`,
    `session turn --id leaf-1 --clear --recorded-before ${startedAt}`,
    `session turn --id leaf-2 --clear --recorded-before ${startedAt}`,
  ])
  assert.equal(
    readFileSync(storePath(sessionGlobalScope(rawId), 'interactive'), 'utf8'),
    `${startedAt}\n`
  )
})

test('CLI: a board that fails every call still leaves both verbs exiting 0', () => {
  registerLeaves(['leaf-1'])
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(2)

  const end = runCli(['turn-end', '--outcome', 'failed'], JSON.stringify({ error: 'server_error' }))
  const start = runCli(['turn-start', '--started-at', '2026-11-24T10:00:00.000Z'], '')

  assert.deepEqual(
    [end.status, end.stdout, end.stderr, start.status, start.stdout, start.stderr],
    [
      0,
      '',
      'dashboard: ai-workflow-app session turn --id leaf-1 --outcome failed --message=server_error failed: exit 2\n',
      0,
      '',
      'dashboard: ai-workflow-app session turn --id leaf-1 --clear --recorded-before 2026-11-24T10:00:00.000Z failed: exit 2\n',
    ]
  )
  assert.equal(getRequestedExitCode(), 0)
  assert.deepEqual(readCalls(), [
    'session turn --id leaf-1 --outcome failed --message=server_error',
    'session turn --id leaf-1 --clear --recorded-before 2026-11-24T10:00:00.000Z',
  ])
})

// The suite may itself run under a teammate's Claude process, which the process-table walk would
// find; a `ps` that lists no teammate pins the session to a lead.
const writeLonePsStub = (dir: string): string => {
  const binDir = join(dir, 'bin')
  mkdirSync(binDir)
  const path = join(binDir, 'ps')
  writeFileSync(path, '#!/usr/bin/env bash\necho "1 0 launchd"\n')
  chmodSync(path, 0o755)
  return binDir
}

const registerLeaves = (ids: string[]): void => {
  ids.forEach((id, index) => {
    upsertRegistryNode(rawId, {
      internalId: id,
      externalId: `${rawId}_000${index}abcd`,
      key: `k${index}`,
      parentId: null,
    })
  })
}

const runCli = (args: string[], input: string) =>
  spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, 'dashboard', 'session', ...args],
    { encoding: 'utf8', input, env: { ...process.env, NODE_NO_WARNINGS: '1' } }
  )

// Answers `session list` with an empty board and `session register` with a node, so a session
// with no leaf can open its conversation root; every other verb exits `exitCode`.
const writeLoggingStub = (exitCode: number): string => {
  const path = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$*" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}`,
      'if [ "$1" = "session" ] && [ "$2" = "list" ]; then',
      ...REJECT_UNKNOWN_LIFECYCLE,
      "  echo '[]'; exit 0",
      'fi',
      'if [ "$1" = "session" ] && [ "$2" = "register" ]; then',
      '  echo \'{"id":"conv-node","parentId":null,"lifecycle":"active"}\'; exit 0',
      'fi',
      `exit ${exitCode}`,
      '',
    ].join('\n')
  )
  chmodSync(path, 0o755)
  return path
}

const unopenableExternalId = (): string => {
  const register = readCalls().find((call) => call.startsWith('session register'))
  const id = register?.match(/--external-id (\S+)/)?.[1] ?? ''
  assert.match(id, new RegExp(`^${rawId}_[0-9a-f]{8}$`))
  return id
}

const LIST_UNCLOSED = 'session list'
const LIST_CLOSED = 'session list --lifecycle closed'

// The real CLI's `session list` rejects a `--lifecycle` outside active|ended|closed with exit 2 and
// no JSON: ai-review-tool `packages/cli/src/cli/commands/session/list/command.ts`
// (`sessionListCommand`'s lifecycle enum), observed with `ai-workflow-app session list --lifecycle
// paused`, which exits 2.
const REJECT_UNKNOWN_LIFECYCLE = [
  'prev=""',
  'for arg in "$@"; do',
  '  if [ "$prev" = "--lifecycle" ] && [ "$arg" != active ] && [ "$arg" != ended ] && [ "$arg" != closed ]; then',
  '    echo "Expected \\"$arg\\" to be one of (active|ended|closed)" >&2; exit 2',
  '  fi',
  '  prev="$arg"',
  'done',
]

// A board whose `session list` answers `listOut` (or exits `listExit`) with no filter and
// `closedOut` (or exits `closedExit`) for `--lifecycle closed`, whose `session register` exits
// `registerExit`, and which accepts every other verb.
const writeBoardStub = (
  opts: {
    listOut?: string
    listExit?: number
    closedOut?: string
    closedExit?: number
    registerExit?: number
  } = {}
): string => {
  const path = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$*" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}`,
      'if [ "$1" = "session" ] && [ "$2" = "list" ]; then',
      ...REJECT_UNKNOWN_LIFECYCLE,
      '  case " $* " in',
      '    *" --lifecycle closed "*)',
      `      if [ ${opts.closedExit ?? 0} -ne 0 ]; then exit ${opts.closedExit ?? 0}; fi`,
      `      echo ${JSON.stringify(opts.closedOut ?? '[]')}; exit 0 ;;`,
      '  esac',
      `  if [ ${opts.listExit ?? 0} -ne 0 ]; then exit ${opts.listExit ?? 0}; fi`,
      `  echo ${JSON.stringify(opts.listOut ?? '[]')}; exit 0`,
      'fi',
      'if [ "$1" = "session" ] && [ "$2" = "register" ]; then',
      `  if [ ${opts.registerExit ?? 0} -ne 0 ]; then exit ${opts.registerExit ?? 0}; fi`,
      '  echo \'{"id":"conv-node","parentId":null,"lifecycle":"active"}\'; exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n')
  )
  chmodSync(path, 0o755)
  return path
}

const readCalls = (): string[] => {
  const log = join(tmpDir, 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : []
}
