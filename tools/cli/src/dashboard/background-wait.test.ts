import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { backgroundTasksFromStopPayload, runWait, watchedPrTasks } from './background-wait.ts'
import { watchPr } from '../pr-monitor/state.ts'
import { upsertRegistryNode } from './registry.ts'
import { teammateTurnStarted } from './teammate-turns.ts'
import { getRequestedExitCode, setRequestedExitCode } from '../runtime-exit-code.ts'
import { ensureDurableDir, sessionGlobalScope, storePath } from '../workflow-store/store.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

let tmpDir: string
let homeDir: string
let rawId: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'AI_WORKFLOW_APP_BIN',
  'CLAUDE_CODE_SESSION_ID',
  'DASHBOARD_TEAMMATE_TURNS_LOCK_WAIT_MS',
  'HOME',
] as const

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
  }

  tmpDir = mkdtempSync(join(tmpdir(), 'wait-test-'))
  homeDir = mkdtempSync(join(tmpdir(), 'wait-test-home-'))
  process.env.HOME = homeDir
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'no-such-ai-workflow-app')
  rawId = `wait-session-${Math.floor(Math.random() * 1e9)}`
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  upsertRegistryNode(rawId, {
    internalId: 'leaf-1',
    externalId: `${rawId}_0123abcd`,
    key: null,
    parentId: null,
  })
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

test('maps each background task to a type and its most specific label', () => {
  assert.deepEqual(
    backgroundTasksFromStopPayload({
      background_tasks: [
        {
          id: 'a',
          type: 'shell',
          status: 'running',
          description: 'Run tests',
          command: 'pnpm test',
        },
        {
          id: 'b',
          type: 'subagent',
          status: 'running',
          description: 'Look things up',
          agent_type: 'researcher',
        },
        {
          id: 'c',
          type: 'monitor',
          status: 'running',
          description: 'Watch CI',
          server: 's',
          tool: 'ci-watch',
        },
        {
          id: 'd',
          type: 'workflow',
          status: 'running',
          description: 'Review',
          name: 'review-changes',
        },
        { id: 'e', type: 'other', status: 'running', description: 'Something else' },
        { id: 'f', type: 'subagent', status: 'running', description: '', agent_type: 'researcher' },
      ],
    }),
    [
      { type: 'shell', label: 'pnpm test' },
      { type: 'subagent', label: 'Look things up' },
      { type: 'monitor', label: 'ci-watch' },
      { type: 'workflow', label: 'review-changes' },
      { type: 'other', label: 'Something else' },
      { type: 'subagent', label: 'researcher' },
    ]
  )
})

test('clips a long label', () => {
  const [task] = backgroundTasksFromStopPayload({
    background_tasks: [{ type: 'shell', command: 'x'.repeat(500) }],
  })
  assert.equal(task?.label.length, 120)
  assert.ok(task?.label.endsWith('…'))
})

test('clipping never leaves half a surrogate pair', () => {
  const [task] = backgroundTasksFromStopPayload({
    background_tasks: [{ type: 'shell', command: `${'x'.repeat(118)}😀${'y'.repeat(10)}` }],
  })
  assert.equal(task?.label, `${'x'.repeat(118)}😀…`)
})

test('a payload with no list, or a malformed one, yields no tasks', () => {
  assert.deepEqual(backgroundTasksFromStopPayload({}), [])
  assert.deepEqual(backgroundTasksFromStopPayload({ background_tasks: 'nope' }), [])
  assert.deepEqual(backgroundTasksFromStopPayload({ background_tasks: [null, 3] }), [])
})

test('a payload whose only tasks are teammates yields no tasks', () => {
  assert.deepEqual(
    backgroundTasksFromStopPayload({
      background_tasks: [
        { id: 'tbxb8vkfo', type: 'teammate', status: 'running', description: 'Run date 25 times' },
      ],
    }),
    []
  )
})

test('a teammate is dropped from a mixed payload and the other tasks keep their order', () => {
  assert.deepEqual(
    backgroundTasksFromStopPayload({
      background_tasks: [
        { id: 'a', type: 'shell', status: 'running', command: 'pnpm test' },
        { id: 'b', type: 'teammate', status: 'running', description: 'Run date 25 times' },
        { id: 'c', type: 'subagent', status: 'running', description: 'Look things up' },
      ],
    }),
    [
      { type: 'shell', label: 'pnpm test' },
      { type: 'subagent', label: 'Look things up' },
    ]
  )
})

test('a payload of only teammates clears the wait instead of recording one', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  runWait(
    undefined,
    JSON.stringify({
      background_tasks: [
        { id: 'tbxb8vkfo', type: 'teammate', status: 'running', description: 'Run date 25 times' },
      ],
    })
  )
  assert.deepEqual(readCalls(), ['session wait --id leaf-1 --clear'])
  assert.equal(getRequestedExitCode(), 0)
})

test('a recorded wait includes each live busy teammate beside the payload’s own tasks', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  teammateTurnStarted(
    rawId,
    'mate-1',
    { leadSessionId: rawId, label: 'impl', pid: process.pid },
    '2026-11-24T10:00:00.000Z'
  )

  runWait(
    undefined,
    JSON.stringify({ background_tasks: [{ type: 'shell', command: 'pnpm test' }] })
  )

  assert.deepEqual(readCalls(), [
    'session wait --id leaf-1 --tasks [{"type":"shell","label":"pnpm test"},{"type":"teammate","label":"impl"}]',
  ])
})

test('watchedPrTasks names each watched PR', () => {
  watchPr('7', 'a/b')
  watchPr('3', 'a/b')

  assert.deepEqual(watchedPrTasks(rawId), [
    { type: 'pr-monitor', label: 'a/b#3' },
    { type: 'pr-monitor', label: 'a/b#7' },
  ])
})

test('watchedPrTasks is empty with no store', () => {
  assert.deepEqual(watchedPrTasks(rawId), [])
})

test('runWait records a watched PR as a task beside the payload’s tasks and busy teammates', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  watchPr('7', 'a/b')
  teammateTurnStarted(
    rawId,
    'mate-1',
    { leadSessionId: rawId, label: 'impl', pid: process.pid },
    '2026-11-24T10:00:00.000Z'
  )

  runWait(
    undefined,
    JSON.stringify({ background_tasks: [{ type: 'shell', command: 'pnpm test' }] })
  )

  assert.deepEqual(readCalls(), [
    'session wait --id leaf-1 --tasks [{"type":"shell","label":"pnpm test"},{"type":"pr-monitor","label":"a/b#7"},{"type":"teammate","label":"impl"}]',
  ])
})

test('records the tasks on the session’s own leaf', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  runWait(
    undefined,
    JSON.stringify({ background_tasks: [{ type: 'shell', command: 'pnpm test' }] })
  )
  assert.deepEqual(readCalls(), [
    'session wait --id leaf-1 --tasks [{"type":"shell","label":"pnpm test"}]',
  ])
  assert.equal(getRequestedExitCode(), 0)
})

test('an empty list clears, and so does --clear', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  runWait(undefined, JSON.stringify({ background_tasks: [] }))
  runWait(undefined, null)
  assert.deepEqual(readCalls(), [
    'session wait --id leaf-1 --clear',
    'session wait --id leaf-1 --clear',
  ])
})

test('a failing board call warns but does not fail the caller', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(2)
  const stderr = captureStderr(() => runWait(undefined, null))
  assert.equal(
    stderr,
    'dashboard: ai-workflow-app session wait --id leaf-1 --clear failed: exit 2\n'
  )
  assert.equal(getRequestedExitCode(), 0)
})

test('CLI: session wait records the Stop payload from stdin, and --clear clears', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  const recorded = runCli(
    [],
    JSON.stringify({ background_tasks: [{ type: 'shell', command: 'pnpm test' }] })
  )
  const cleared = runCli(['--clear'], '')

  assert.deepEqual(
    [
      recorded.status,
      recorded.stdout,
      recorded.stderr,
      cleared.status,
      cleared.stdout,
      cleared.stderr,
    ],
    [0, '', '', 0, '', '']
  )
  assert.deepEqual(readCalls(), [
    'session wait --id leaf-1 --tasks [{"type":"shell","label":"pnpm test"}]',
    'session wait --id leaf-1 --clear',
  ])
})

test('--recorded-before limits a clear and is forwarded; an empty payload clear stays unconditional', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  const instant = '2026-11-01T12:00:00.000Z'
  runWait(undefined, null, instant)
  runWait(undefined, JSON.stringify({ background_tasks: [] }))

  const cli = runCli(['--clear', '--recorded-before', instant], '')

  assert.deepEqual([cli.status, cli.stdout, cli.stderr], [0, '', ''])
  assert.deepEqual(readCalls(), [
    `session wait --id leaf-1 --clear --recorded-before ${instant}`,
    'session wait --id leaf-1 --clear',
    `session wait --id leaf-1 --clear --recorded-before ${instant}`,
  ])
})

const SHELL_STOP = JSON.stringify({ background_tasks: [{ type: 'shell', command: 'pnpm test' }] })
const SHELL_TASKS = '[{"type":"shell","label":"pnpm test"}]'

const teammateTurnStartsAfterStopAndClear = (recordedBefore: string | undefined): string[] => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)

  runWait(undefined, SHELL_STOP)
  runWait(undefined, null, recordedBefore)
  teammateTurnStarted(
    rawId,
    'mate-1',
    { leadSessionId: rawId, label: 'impl', pid: process.pid },
    '2026-11-24T10:00:00.000Z'
  )

  const busy: Record<string, { label: string }> = JSON.parse(
    readFileSync(storePath(sessionGlobalScope(rawId), 'teammate-turns.json'), 'utf8')
  )
  assert.equal(busy['mate-1']?.label, 'impl', 'the teammate start was processed')
  return readCalls()
}

test('a clear removes the Stop record, so a later teammate turn change does not restore its tasks', () => {
  assert.deepEqual(teammateTurnStartsAfterStopAndClear(undefined), [
    `session wait --id leaf-1 --tasks ${SHELL_TASKS}`,
    'session wait --id leaf-1 --clear',
  ])
})

test('a clear bounded after the Stop removes it', () => {
  const after = '2999-01-01T00:00:00.000Z'
  assert.deepEqual(teammateTurnStartsAfterStopAndClear(after), [
    `session wait --id leaf-1 --tasks ${SHELL_TASKS}`,
    'session wait --id leaf-1 --clear',
  ])
})

test('an unbounded clear removes a Stop record whatever its timestamp', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  const scope = sessionGlobalScope(rawId)
  const stopFile = storePath(scope, 'stop-tasks.json')
  ensureDurableDir(dirname(stopFile))
  writeFileSync(
    stopFile,
    `${JSON.stringify({ at: '2999-01-01T00:00:00.000Z', tasks: [{ type: 'shell', label: 'pnpm test' }] })}\n`
  )

  runWait(undefined, null)
  teammateTurnStarted(
    rawId,
    'mate-1',
    { leadSessionId: rawId, label: 'impl', pid: process.pid },
    '2026-11-24T10:00:00.000Z'
  )

  assert.equal(existsSync(stopFile), false)
  assert.equal(existsSync(storePath(scope, 'teammate-turns.json')), true)
  assert.deepEqual(readCalls(), ['session wait --id leaf-1 --clear'])
})

test('a clear that cannot take the lead lock clears no leaf and keeps the Stop record', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  process.env.DASHBOARD_TEAMMATE_TURNS_LOCK_WAIT_MS = '200'
  runWait(undefined, SHELL_STOP)
  const scope = sessionGlobalScope(rawId)
  const now = new Date().toISOString()
  writeFileSync(
    storePath(scope, 'teammate-turns.lock'),
    JSON.stringify({ pid: process.pid, startedAt: now, heartbeatAt: now }),
    { mode: 0o600 }
  )

  const stderr = captureStderr(() => runWait(undefined, null))

  assert.equal(stderr, 'dashboard: teammate turns are locked by another writer; skipped\n')
  assert.deepEqual(readCalls(), [`session wait --id leaf-1 --tasks ${SHELL_TASKS}`])
  assert.equal(existsSync(storePath(scope, 'stop-tasks.json')), true)
  assert.equal(getRequestedExitCode(), 0)
})

test('a clear bounded before the Stop keeps the Stop record for the next teammate re-record', () => {
  const before = '2000-01-01T00:00:00.000Z'
  assert.deepEqual(teammateTurnStartsAfterStopAndClear(before), [
    `session wait --id leaf-1 --tasks ${SHELL_TASKS}`,
    `session wait --id leaf-1 --clear --recorded-before ${before}`,
    `session wait --id leaf-1 --tasks [{"type":"shell","label":"pnpm test"},{"type":"teammate","label":"impl"}]`,
  ])
})

test('--recorded-before without --clear is refused and calls no board verb', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  const cli = runCli(
    ['--recorded-before', '2026-11-01T12:00:00.000Z'],
    JSON.stringify({ background_tasks: [{ type: 'shell', command: 'pnpm test' }] })
  )

  assert.deepEqual(
    [cli.status, cli.stdout, cli.stderr],
    [1, '', '--recorded-before needs --clear\n']
  )
  assert.deepEqual(readCalls(), [])
})

test('no registry leaves means no board call', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub(0)
  process.env.CLAUDE_CODE_SESSION_ID = `${rawId}-unregistered`
  runWait(undefined, null)
  assert.deepEqual(readCalls(), [])

  process.env.CLAUDE_CODE_SESSION_ID = rawId
  runWait(undefined, null)
  assert.deepEqual(readCalls(), ['session wait --id leaf-1 --clear'])
})

const runCli = (args: string[], input: string) =>
  spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, 'dashboard', 'session', 'wait', ...args],
    { encoding: 'utf8', input, env: { ...process.env, NODE_NO_WARNINGS: '1' } }
  )

const writeLoggingStub = (exitCode: number): string => {
  const path = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$*" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}`,
      `exit ${exitCode}`,
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

const captureStderr = (fn: () => void): string => {
  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    fn()
  } finally {
    process.stderr.write = orig
  }
  return chunks.join('')
}
