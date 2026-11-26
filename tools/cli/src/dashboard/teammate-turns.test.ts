import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'

import {
  busyTeammateLabels,
  forgetLeadStopTasks,
  leadStopped,
  teammateTurnEnded,
  teammateTurnStarted,
} from './teammate-turns.ts'
import { upsertRegistryNode } from './registry.ts'
import type { TeammateIdentity } from './lead.ts'
import { sessionGlobalScope, storePath } from '../workflow-store/store.ts'

let tmpDir: string
let homeDir: string
let leadId: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['AI_WORKFLOW_APP_BIN', 'HOME'] as const
const SHELL = { type: 'shell', label: 'pnpm test' }
const TEAMMATE = { type: 'teammate', label: 'impl' }
const STARTED = '2026-11-24T10:00:00.000Z'
const LATER_THAN_ANY_END = '2999-01-01T00:00:00.000Z'

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
  }

  tmpDir = mkdtempSync(join(tmpdir(), 'teammate-turns-test-'))
  homeDir = mkdtempSync(join(tmpdir(), 'teammate-turns-test-home-'))
  process.env.HOME = homeDir
  process.env.AI_WORKFLOW_APP_BIN = writeLoggingStub()
  leadId = `lead-session-${Math.floor(Math.random() * 1e9)}`
  upsertRegistryNode(leadId, {
    internalId: 'lead-leaf',
    externalId: `${leadId}_0123abcd`,
    key: null,
    parentId: null,
  })
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
})

test('a lead at rest is re-recorded with its stop tasks plus the busy teammate, then without it', () => {
  leadStopped(leadId, [SHELL])

  teammateTurnStarted(leadId, 'mate-1', aliveIdentity(), STARTED)
  teammateTurnEnded(leadId, 'mate-1', aliveIdentity())

  assert.deepEqual(readCalls(), [
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL])}`,
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL, TEAMMATE])}`,
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL])}`,
  ])
})

test('a lead at rest with no stop tasks is cleared when the last busy teammate ends', () => {
  leadStopped(leadId, [])

  teammateTurnStarted(leadId, 'mate-1', aliveIdentity(), STARTED)
  teammateTurnEnded(leadId, 'mate-1', aliveIdentity())

  assert.deepEqual(readCalls(), [
    'session wait --id lead-leaf --clear',
    `session wait --id lead-leaf --tasks ${JSON.stringify([TEAMMATE])}`,
    'session wait --id lead-leaf --clear',
  ])
})

test('a lead mid-turn (no stop tasks) is not re-recorded; the busy file still tracks the teammate', () => {
  teammateTurnStarted(leadId, 'mate-1', aliveIdentity(), STARTED)
  const busy = readBusyFile()
  assert.deepEqual(Object.keys(busy), ['mate-1'])
  assert.equal(busy['mate-1']?.label, 'impl')
  assert.equal(busy['mate-1']?.pid, process.pid)
  assert.equal(busy['mate-1']?.startedAt, STARTED)
  assert.equal(busy['mate-1']?.endedAt, undefined)

  teammateTurnEnded(leadId, 'mate-1', aliveIdentity())

  assert.equal(typeof readBusyFile()['mate-1']?.endedAt, 'string')
  assert.deepEqual(readCalls(), [])
})

test('a start processed after its own turn’s end leaves the teammate unlisted; a later turn lists it', () => {
  leadStopped(leadId, [SHELL])

  teammateTurnEnded(leadId, 'mate-1', aliveIdentity())
  teammateTurnStarted(leadId, 'mate-1', aliveIdentity(), STARTED)

  assert.deepEqual(readCalls(), [
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL])}`,
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL])}`,
  ])

  teammateTurnStarted(leadId, 'mate-1', aliveIdentity(), LATER_THAN_ANY_END)

  assert.deepEqual(
    readCalls().at(-1),
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL, TEAMMATE])}`
  )
})

test('a teammate turn start released while the lead’s Stop is recording leaves the teammate on the lead’s final record', async () => {
  const releaseBoard = join(tmpDir, 'release-board')
  assert.equal(spawnSync('mkfifo', [releaseBoard], { timeout: 5_000 }).status, 0)
  const stub = join(tmpDir, 'blocking-app')
  const log = join(tmpDir, 'blocking-calls.log')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      `exec 3<> ${JSON.stringify(releaseBoard)}`,
      `if mkdir ${JSON.stringify(join(tmpDir, 'first-call'))} 2>/dev/null; then`,
      `  : > ${JSON.stringify(join(tmpDir, 'lead-in-board'))}`,
      '  read -r _ <&3',
      `  echo "$*" >> ${JSON.stringify(log)}`,
      'else',
      `  echo "$*" >> ${JSON.stringify(log)}`,
      `  : > ${JSON.stringify(join(tmpDir, 'second-board-call'))}`,
      'fi',
      'exit 0',
      '',
    ].join('\n')
  )
  chmodSync(stub, 0o755)
  const env = {
    ...process.env,
    HOME: homeDir,
    AI_WORKFLOW_APP_BIN: stub,
    DASHBOARD_INVOKE_TIMEOUT_MS: '60000',
  }
  const module = new URL('./teammate-turns.ts', import.meta.url).href
  const run = (code: string, ...args: string[]) =>
    runChild(['--experimental-transform-types', '--input-type=module', '-e', code, ...args], env)

  const lead = run(
    `import { leadStopped } from '${module}'
     leadStopped(process.argv[1], [{ type: 'shell', label: 'pnpm test' }])`,
    leadId
  )
  await expectFileFrom(
    join(tmpDir, 'lead-in-board'),
    CHILD_START_DEADLINE_MS,
    'board call from the lead',
    lead
  )

  const teammate = run(
    `import { writeFileSync } from 'node:fs'
     import { teammateTurnStarted } from '${module}'
     writeFileSync(process.argv[2], 'ready')
     teammateTurnStarted(process.argv[1], 'mate-1',
       { leadSessionId: process.argv[1], label: 'impl', pid: process.pid }, process.argv[3])`,
    leadId,
    join(tmpDir, 'teammate-ready'),
    STARTED
  )
  await expectFileFrom(
    join(tmpDir, 'teammate-ready'),
    TEAMMATE_READY_DEADLINE_MS,
    'readiness from the teammate',
    lead,
    teammate
  )

  // A teammate that reaches the board while the lead is still inside its call shows the lead's
  // record is not under the lock. Under the lock it can only arrive after the release, so the wait
  // for it ends at the settle deadline instead.
  await fileAppearsWithin(join(tmpDir, 'second-board-call'), SETTLE_DEADLINE_MS)
  const release = openSync(releaseBoard, constants.O_WRONLY | constants.O_NONBLOCK)
  writeSync(release, 'go\n')
  closeSync(release)

  await Promise.all([
    exitsCleanlyWithin(lead, CHILD_EXIT_DEADLINE_MS),
    exitsCleanlyWithin(teammate, CHILD_EXIT_DEADLINE_MS),
  ])

  assert.deepEqual(readFileSync(log, 'utf-8').split('\n').filter(Boolean), [
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL])}`,
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL, TEAMMATE])}`,
  ])
})

test('an entry whose process has exited is not counted and is dropped on the next write', () => {
  leadStopped(leadId, [SHELL])
  const exited = spawnSync(process.execPath, ['-e', ''])
  assert.equal(exited.status, 0)
  assert.ok(exited.pid !== undefined)

  teammateTurnStarted(
    leadId,
    'gone',
    { ...aliveIdentity(), pid: exited.pid, label: 'gone' },
    STARTED
  )
  teammateTurnStarted(leadId, 'mate-1', aliveIdentity(), STARTED)

  assert.deepEqual(Object.keys(readBusyFile()), ['mate-1'])
  assert.deepEqual(
    readCalls().at(-1),
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL, TEAMMATE])}`
  )
})

test('forgetLeadStopTasks deletes stop tasks older than the turn start and keeps newer ones', () => {
  leadStopped(leadId, [SHELL])
  const stopFile = storePath(sessionGlobalScope(leadId), 'stop-tasks.json')

  forgetLeadStopTasks(leadId, '2000-01-01T00:00:00.000Z')
  assert.ok(existsSync(stopFile))

  forgetLeadStopTasks(leadId, '2999-01-01T00:00:00.000Z')
  assert.equal(existsSync(stopFile), false)
})

test('a turn start that removes the stop tasks clears the lead’s wait outright, including a re-record made after the start', () => {
  leadStopped(leadId, [SHELL])
  teammateTurnStarted(leadId, 'mate-1', aliveIdentity(), STARTED)

  forgetLeadStopTasks(leadId, '2999-01-01T00:00:00.000Z')
  teammateTurnEnded(leadId, 'mate-1', aliveIdentity())

  assert.deepEqual(readCalls(), [
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL])}`,
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL, TEAMMATE])}`,
    'session wait --id lead-leaf --clear',
  ])
})

test('busyTeammateLabels returns [] for an unparseable list', () => {
  teammateTurnStarted(leadId, 'mate-1', aliveIdentity(), STARTED)
  assert.deepEqual(busyTeammateLabels(leadId), ['impl'])

  writeFileSync(storePath(sessionGlobalScope(leadId), 'teammate-turns.json'), '{')

  assert.deepEqual(busyTeammateLabels(leadId), [])
})

test('unparseable busy or stop files read as empty: the lead’s Stop still records and a turn start still runs', () => {
  leadStopped(leadId, [])
  const scope = sessionGlobalScope(leadId)

  writeFileSync(storePath(scope, 'teammate-turns.json'), 'not json')
  leadStopped(leadId, [SHELL])
  assert.deepEqual(
    readCalls().at(-1),
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL])}`
  )

  writeFileSync(storePath(scope, 'stop-tasks.json'), '{{')
  forgetLeadStopTasks(leadId, '2999-01-01T00:00:00.000Z')
  teammateTurnStarted(leadId, 'mate-1', aliveIdentity(), STARTED)

  assert.deepEqual(Object.keys(readBusyFile()), ['mate-1'])
})

test('leadStopped records the payload tasks plus each live busy teammate', () => {
  teammateTurnStarted(leadId, 'mate-1', aliveIdentity(), STARTED)

  leadStopped(leadId, [SHELL])

  assert.deepEqual(readCalls(), [
    `session wait --id lead-leaf --tasks ${JSON.stringify([SHELL, TEAMMATE])}`,
  ])
})

// Deadlines for the cross-process race. The lead stays inside its board call, holding the lock,
// from CHILD_START until the release, and a teammate waiting on that lock gives up after 15s
// (LOCK_WAIT_MS), so TEAMMATE_READY + SETTLE stay well below it. Node start-up under a ~15-way
// concurrent suite takes a few seconds; the settle deadline only has to cover one process spawn.
const CHILD_START_DEADLINE_MS = 20_000
const TEAMMATE_READY_DEADLINE_MS = 8_000
const SETTLE_DEADLINE_MS = 3_000
const CHILD_EXIT_DEADLINE_MS = 20_000

interface Child {
  process: ChildProcess
  exited: Promise<number | null>
  output: () => string
}

// Starts node with `args`, capturing its output so a failure can show what the child reported.
const runChild = (args: string[], env: NodeJS.ProcessEnv): Child => {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', (chunk) => (output += String(chunk)))
  child.stderr?.on('data', (chunk) => (output += String(chunk)))
  const exited = once(child, 'exit').then(([code]) => code as number | null)
  return { process: child, exited, output: () => output.trim() || '(none)' }
}

const fileAppearsWithin = (path: string, deadlineMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const done = (appeared: boolean) => {
      clearTimeout(timer)
      watcher.close()
      resolve(appeared)
    }
    const watcher = watch(tmpDir, () => existsSync(path) && done(true))
    const timer = setTimeout(() => done(false), deadlineMs)
    if (existsSync(path)) {
      done(true)
    }
  })

// A file a child is meant to produce: fails at the deadline, or as soon as a child exits without
// producing it, with what the children printed; the children are killed on failure.
const expectFileFrom = async (
  path: string,
  deadlineMs: number,
  what: string,
  ...children: Child[]
): Promise<void> => {
  const exitedEarly = Promise.race(children.map((child) => child.exited)).then(() => false)
  if (await Promise.race([fileAppearsWithin(path, deadlineMs), exitedEarly])) {
    return
  }

  for (const child of children) {
    child.process.kill()
  }

  assert.fail(
    `no ${what} within ${deadlineMs}ms or before a child exited; child output: ${children
      .map((child) => child.output())
      .join(' | ')}`
  )
}

const exitsCleanlyWithin = async (child: Child, deadlineMs: number): Promise<void> => {
  const timedOut = Symbol('timed out')
  let timer: NodeJS.Timeout | undefined
  const result = await Promise.race([
    child.exited,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), deadlineMs)
    }),
  ])
  clearTimeout(timer)
  if (result === timedOut) {
    child.process.kill()
  }

  assert.equal(result, 0, `child did not exit 0 within ${deadlineMs}ms; output: ${child.output()}`)
}

const aliveIdentity = (): TeammateIdentity => ({
  leadSessionId: leadId,
  label: 'impl',
  pid: process.pid,
})

interface BusyEntry {
  label: string
  pid: number
  startedAt: string
  endedAt?: string
}

const readBusyFile = (): Record<string, BusyEntry> => {
  const busy: Record<string, BusyEntry> = JSON.parse(
    readFileSync(storePath(sessionGlobalScope(leadId), 'teammate-turns.json'), 'utf8')
  )
  return busy
}

const writeLoggingStub = (): string => {
  const path = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$*" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}`,
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
