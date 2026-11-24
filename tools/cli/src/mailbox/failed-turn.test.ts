import { test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeRegistryNode, upsertRegistryNode } from '../dashboard/registry.ts'
import {
  loadState as loadDashboardState,
  saveState as saveDashboardState,
} from '../dashboard/state.ts'
import { sessionGlobalScope, storePath } from '../workflow-store/store.ts'
import {
  clearFailedTurn,
  loadFailedTurn,
  markTurnStarted,
  pendingResume,
  postIfNeeded,
  recordFailedTurn,
  retryStaleWithdraw,
  type BoardKind,
  type PostItem,
} from './failed-turn.ts'
import { withRecordLock } from './record-lock.ts'
import { loadTurnMarks, updateTurnMarks } from './turn-marks.ts'

const SESSION = 'failed-turn-test-session'
const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

let tmpDir: string
let origHome: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'failed-turn-test-'))
  origHome = process.env.HOME
  process.env.HOME = tmpDir
})

const spawned: ReturnType<typeof spawn>[] = []

const startupErrors = new WeakMap<ReturnType<typeof spawn>, Error>()

const track = (child: ReturnType<typeof spawn>): ReturnType<typeof spawn> => {
  spawned.push(child)
  child.once('error', (error) => startupErrors.set(child, error))

  return child
}

const assertStarted = (workers: ReturnType<typeof spawn>[]): void => {
  for (const worker of workers) {
    const error = startupErrors.get(worker)
    assert.equal(error, undefined, `a worker failed to start: ${error?.message}`)
  }
}

const WAIT_DEADLINE_MS = 30_000

const exitWithin = (
  child: ReturnType<typeof spawn>
): Promise<[number | null, NodeJS.Signals | null]> =>
  withinDeadline(exitOf(child), `pid ${child.pid} exiting`)

const exitOf = (child: ReturnType<typeof spawn>): Promise<[number | null, NodeJS.Signals | null]> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve([child.exitCode, child.signalCode])

      return
    }

    child.once('exit', (code, signal) => resolve([code, signal]))
    child.once('error', () => resolve([null, null]))
  })

const withinDeadline = <T>(promise: Promise<T>, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not finish within ${WAIT_DEADLINE_MS}ms`)),
      WAIT_DEADLINE_MS
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })

const reapSpawned = async (): Promise<void> => {
  const unfinished = spawned
    .splice(0)
    .filter(
      (child) => child.exitCode === null && child.signalCode === null && !startupErrors.has(child)
    )
  for (const child of unfinished) {
    child.kill('SIGKILL')
  }

  await Promise.all(unfinished.map((child) => once(child, 'exit')))
}

afterEach(async () => {
  await reapSpawned()
  if (origHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = origHome
  }

  rmSync(tmpDir, { recursive: true, force: true })
})

const recordingPost = (): { posted: BoardKind[]; post: PostItem } => {
  const posted: BoardKind[] = []

  return {
    posted,
    post: (kind) => {
      posted.push(kind)

      return `item-${posted.length}`
    },
  }
}

const recordPath = (): string => storePath(sessionGlobalScope(SESSION), 'failed-turn.json')

test('a first server_error records one failure, posts nothing, and is pending a resume', () => {
  const { posted, post } = recordingPost()

  const record = recordFailedTurn(
    { error: 'server_error', last_assistant_message: 'running\n the   build' },
    SESSION,
    true,
    post
  )

  assert.deepEqual(posted, [])
  assert.equal(record.consecutive, 1)
  assert.equal(record.boardItemId, null)
  assert.deepEqual(pendingResume(SESSION), loadFailedTurn(SESSION))
  assert.equal(pendingResume(SESSION)?.error, 'server_error')
})

test('each credential error posts one credential item on the first failure', () => {
  const errors = [
    'authentication_failed',
    'oauth_org_not_allowed',
    'account_on_hold',
    'verification_required',
    'billing_error',
    'cloud_credential_error',
  ]

  for (const error of errors) {
    rmSync(dirname(recordPath()), { recursive: true, force: true })
    const { posted, post } = recordingPost()

    const record = recordFailedTurn({ error }, SESSION, true, post)

    assert.deepEqual(posted, ['credential'], error)
    assert.equal(record.boardItemId, 'item-1', error)
    assert.equal(pendingResume(SESSION), null, error)
  }
})

test('rate_limit posts one checkpoint on the first failure', () => {
  const { posted, post } = recordingPost()

  recordFailedTurn({ error: 'rate_limit' }, SESSION, true, post)

  assert.deepEqual(posted, ['checkpoint'])
  assert.equal(pendingResume(SESSION), null)
})

test('a second consecutive failure posts a checkpoint and a third posts nothing further', () => {
  const { posted, post } = recordingPost()

  recordFailedTurn({ error: 'server_error' }, SESSION, true, post)
  assert.notEqual(pendingResume(SESSION), null)

  recordFailedTurn({ error: 'server_error' }, SESSION, true, post)
  assert.deepEqual(posted, ['checkpoint'])
  assert.equal(pendingResume(SESSION), null)

  const third = recordFailedTurn({ error: 'unknown' }, SESSION, true, post)
  assert.deepEqual(posted, ['checkpoint'])
  assert.equal(third.consecutive, 3)
  assert.equal(third.boardItemId, 'item-1')
})

test('a failure after the streak item was answered posts a new item, and an unreadable one posts too', () => {
  const { posted, post } = recordingPost()

  recordFailedTurn({ error: 'rate_limit' }, SESSION, true, post)
  const second = recordFailedTurn(
    { error: 'rate_limit' },
    SESSION,
    true,
    post,
    new Date(),
    () => 'closed'
  )

  assert.deepEqual(posted, ['checkpoint', 'checkpoint'])
  assert.equal(second.boardItemId, 'item-2')
  assert.deepEqual(second.staleBoardItemIds, [])

  const third = recordFailedTurn(
    { error: 'rate_limit' },
    SESSION,
    true,
    post,
    new Date(),
    () => 'unknown'
  )

  assert.deepEqual(posted, ['checkpoint', 'checkpoint', 'checkpoint'])
  assert.equal(third.boardItemId, 'item-3')
  assert.deepEqual(third.staleBoardItemIds, ['item-2'])
})

test('a failed post leaves the item unposted until postIfNeeded posts it', () => {
  const record = recordFailedTurn({ error: 'billing_error' }, SESSION, true, () => null)
  assert.equal(record.boardItemId, null)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, null)

  const { posted, post } = recordingPost()
  const retried = postIfNeeded(loadFailedTurn(SESSION)!, post)

  assert.deepEqual(posted, ['credential'])
  assert.equal(retried.boardItemId, 'item-1')
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, 'item-1')
})

test('a session that cannot post never calls post', () => {
  const { posted, post } = recordingPost()

  recordFailedTurn({ error: 'billing_error' }, SESSION, false, post)
  recordFailedTurn({ error: 'billing_error' }, SESSION, false, post)

  assert.deepEqual(posted, [])
  assert.equal(loadFailedTurn(SESSION)?.consecutive, 2)
})

test('a turn start before the failure leaves the entry pending, and a later one stops it', () => {
  recordFailedTurn(
    { error: 'server_error' },
    SESSION,
    false,
    () => null,
    new Date('2026-01-01T00:00:10Z')
  )

  markTurnStarted(SESSION, '2026-01-01T00:00:05.000Z')
  assert.notEqual(pendingResume(SESSION), null)

  markTurnStarted(SESSION, '2026-01-01T00:00:11.000Z')
  assert.equal(pendingResume(SESSION), null)
  assert.equal(loadFailedTurn(SESSION)?.turnStartedSince, true)
})

test('clearing removes the record and withdraws a posted item', () => {
  const { post } = recordingPost()
  recordFailedTurn({ error: 'billing_error' }, SESSION, true, post)
  const withdrawn: string[] = []
  const withdraw = (itemId: string): 'done' => {
    withdrawn.push(itemId)

    return 'done'
  }

  clearFailedTurn(SESSION, withdraw)

  assert.deepEqual(withdrawn, ['item-1'])
  assert.equal(loadFailedTurn(SESSION), null)

  clearFailedTurn(SESSION, withdraw)
  assert.deepEqual(withdrawn, ['item-1'])
})

test('a new failure after a failed withdraw counts as the first of its streak', () => {
  const { post } = recordingPost()
  recordFailedTurn({ error: 'billing_error' }, SESSION, true, post)
  clearFailedTurn(SESSION, () => 'failed')

  const kept = loadFailedTurn(SESSION)
  assert.deepEqual(kept?.staleBoardItemIds, ['item-1'])
  assert.equal(kept?.boardItemId, null)
  assert.equal(kept?.consecutive, 0)
  assert.equal(pendingResume(SESSION), null)

  const next = recordFailedTurn({ error: 'server_error' }, SESSION, true, post)

  assert.equal(next.consecutive, 1)
  assert.deepEqual(next.staleBoardItemIds, ['item-1'])
  assert.equal(next.boardItemId, null)
  assert.notEqual(pendingResume(SESSION), null)
})

test('an unreadable or malformed record reads as none', () => {
  mkdirSync(dirname(recordPath()), { recursive: true })

  writeFileSync(recordPath(), '{not json')
  assert.equal(loadFailedTurn(SESSION), null)

  writeFileSync(recordPath(), JSON.stringify({ sessionId: SESSION, error: 7 }))
  assert.equal(loadFailedTurn(SESSION), null)
  assert.equal(pendingResume(SESSION), null)

  rmSync(recordPath())
  mkdirSync(recordPath())
  assert.equal(loadFailedTurn(SESSION), null)
})

const MAILBOX_TIMEOUT_MS = 120_000

const runMailbox = (
  args: string[],
  input?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): { stdout: string; stderr: string; status: number | null } => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmpDir,
    CLAUDE_CONFIG_DIR: tmpDir,
  }
  delete env.CLAUDE_PLUGIN_ROOT
  delete env.CLAUDE_CODE_SESSION_ID
  Object.assign(env, extraEnv)

  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, 'mailbox', ...args, '--session', SESSION],
    { encoding: 'utf8', env, input, timeout: MAILBOX_TIMEOUT_MS }
  )

  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

test('the mailbox commands record, print, stop and clear a failed turn', () => {
  const failed = runMailbox(
    ['turn-failed'],
    JSON.stringify({
      session_id: SESSION,
      error: 'server_error',
      last_assistant_message: 'building',
    })
  )
  assert.equal(failed.status, 0, failed.stderr)

  const printed = runMailbox(['check'])
  assert.equal(printed.status, 0, printed.stderr)
  assert.match(
    printed.stdout,
    /^\[turn\] failed-turn server_error at \d{4}-\d\d-\d\dT[\d:.]+Z: your last turn was cut off\. The error detail was: building Re-read the transcript and the state of your work, because a tool call may have run with its result lost, then continue from where it stopped\. If this turn fails too, the failure goes to the board\.\n$/
  )

  const marked = runMailbox(['turn-started', '--started-at', '2999-01-01T00:00:00.000Z'])
  assert.equal(marked.status, 0, marked.stderr)
  assert.equal(runMailbox(['check']).stdout, '')

  runMailbox(['turn-failed'], JSON.stringify({ error: 'server_error' }))
  assert.notEqual(loadFailedTurn(SESSION), null)

  const cleared = runMailbox(['turn-succeeded'])
  assert.equal(cleared.status, 0, cleared.stderr)
  assert.equal(loadFailedTurn(SESSION), null)
  assert.equal(runMailbox(['check']).stdout, '')
})

const BOARD_STUB = [
  '#!/usr/bin/env bash',
  'DIR="$(cd "$(dirname "$0")" && pwd)"',
  'printf \'%s\\n\' "$*" >> "$DIR/calls.log"',
  'if [ -e "$DIR/fail" ]; then echo boom >&2; exit 1; fi',
  'if [ "$1" = "answers" ]; then echo \'[]\'; exit 0; fi',
  'echo \'{"itemId":"item-1"}\'',
  '',
].join('\n')

const registerBoardNode = (session = SESSION, nodeId = 'node-1'): void => {
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    upsertRegistryNode(session, {
      internalId: nodeId,
      externalId: nodeId,
      key: null,
      parentId: null,
    })
    saveDashboardState(nodeId, { registered: true, phase: 'implementation', openItemIds: [] })
  } finally {
    delete process.env.CLAUDE_CODE_SESSION_ID
  }
}

const marksFile = (): string => storePath(sessionGlobalScope(SESSION), 'turn-marks.json')

const STATEFUL_STUB = [
  '#!/usr/bin/env bash',
  'DIR="$(cd "$(dirname "$0")" && pwd)"',
  'printf \'%s\\n\' "$*" >> "$DIR/calls.log"',
  'if [ "$1" = "answers" ]; then echo \'[]\'; exit 0; fi',
  'if [ "$1 $2" = "item add" ]; then',
  '  [ -e "$DIR/fail-add" ] && { echo "board down" >&2; exit 1; }',
  '  n=$(( $(cat "$DIR/counter" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$DIR/counter"',
  '  echo open > "$DIR/item-$n"; echo "{\\"itemId\\":\\"item-$n\\"}"; exit 0',
  'fi',
  'if [ "$1 $2" = "item show" ]; then',
  '  [ -e "$DIR/$4" ] || { echo "Item not found" >&2; exit 1; }',
  '  echo "{\\"item\\":{\\"id\\":\\"$4\\",\\"type\\":\\"approval\\",\\"state\\":\\"$(cat "$DIR/$4")\\"}}"; exit 0',
  'fi',
  'if [ "$1 $2" = "item withdraw" ]; then',
  '  if [ -e "$DIR/answered-on-withdraw" ]; then',
  '    echo released > "$DIR/$4"',
  '    echo "item $4 is released; only open, draft or ready items can be withdrawn" >&2; exit 1',
  '  fi',
  '  state=$(cat "$DIR/$4" 2>/dev/null)',
  '  if [ "$state" != open ]; then',
  '    echo "item $4 is $state; only open, draft or ready items can be withdrawn" >&2; exit 1',
  '  fi',
  '  echo withdrawn > "$DIR/$4"; exit 0',
  'fi',
  'exit 0',
  '',
].join('\n')

const promptOrderFixture = (stubBody = BOARD_STUB) => {
  const boardDir = join(tmpDir, 'board')
  mkdirSync(boardDir)
  const stub = join(boardDir, 'ai-workflow-app')
  writeFileSync(stub, stubBody)
  chmodSync(stub, 0o755)
  registerBoardNode()
  const env = { AI_WORKFLOW_APP_BIN: stub, DASHBOARD_INVOKE_TIMEOUT_MS: '60000' }
  const earlier = Date.now() - 3_600_000
  const later = Date.now() + 3_600_000
  const startedAt = (promptId: string, instant: number): void => {
    const run = runMailbox(
      ['turn-started', '--prompt-id', promptId, '--started-at', new Date(instant).toISOString()],
      undefined,
      env
    )
    assert.equal(run.status, 0, run.stderr)
  }
  const boardLog = (): string =>
    existsSync(join(boardDir, 'calls.log')) ? readFileSync(join(boardDir, 'calls.log'), 'utf8') : ''

  return {
    started: (promptId: string, seconds: number): void =>
      startedAt(promptId, earlier + seconds * 1000),
    startedLater: (promptId: string, seconds: number): void =>
      startedAt(promptId, later + seconds * 1000),
    startedJustBeforeNow: (promptId: string): void => startedAt(promptId, Date.now() - 1000),
    failBoard: (down: boolean): void => {
      const flag = join(boardDir, 'fail')
      if (down) {
        writeFileSync(flag, '')
      } else {
        rmSync(flag, { force: true })
      }
    },
    boardLog,
    itemAddCauses: (): string[] =>
      boardLog()
        .split('\n')
        .filter((line) => line.startsWith('item add'))
        .flatMap((line) => /`([a-z_]+)`/.exec(line)?.[1] ?? []),
    failed: (promptId: string, error: string): void => {
      const run = runMailbox(['turn-failed'], JSON.stringify({ error, prompt_id: promptId }), env)
      assert.equal(run.status, 0, run.stderr)
    },
    failedRaw: (payload: unknown): void => {
      const run = runMailbox(['turn-failed'], JSON.stringify(payload), env)
      assert.equal(run.status, 0, run.stderr)
    },
    startedAtRaw: (startedAt: string): { status: number | null } =>
      runMailbox(
        ['turn-started', '--prompt-id', 'prompt-x', '--started-at', startedAt],
        undefined,
        env
      ),
    succeeded: (promptId: string): void => {
      const run = runMailbox(['turn-succeeded', '--prompt-id', promptId], undefined, env)
      assert.equal(run.status, 0, run.stderr)
    },
    startedLaterWithoutId: (): void => {
      const run = runMailbox(
        ['turn-started', '--started-at', new Date(later).toISOString()],
        undefined,
        env
      )
      assert.equal(run.status, 0, run.stderr)
    },
    startedJustBeforeNowWithoutId: (): void => {
      const run = runMailbox(
        ['turn-started', '--started-at', new Date(Date.now() - 1000).toISOString()],
        undefined,
        env
      )
      assert.equal(run.status, 0, run.stderr)
    },
    itemRemedies: (): string[] =>
      boardLog()
        .split('\n')
        .filter((line) => line.startsWith('item add'))
        .map((line) => remedyOfPrompt(line)),
    openItems: (): string[] =>
      readdirSync(boardDir)
        .filter((name) => /^item-\d+$/.test(name))
        .filter((name) => readFileSync(join(boardDir, name), 'utf8').trim() === 'open')
        .sort(),
    itemState: (itemId: string): string => readFileSync(join(boardDir, itemId), 'utf8').trim(),
    answer: (itemId: string): void => writeFileSync(join(boardDir, itemId), 'released'),
    failAdd: (down: boolean): void => {
      const flag = join(boardDir, 'fail-add')
      if (down) {
        writeFileSync(flag, '')
      } else {
        rmSync(flag, { force: true })
      }
    },
    corruptMarks: (text: string): void => writeFileSync(marksFile(), text),
    blockMarks: (): void => {
      rmSync(marksFile(), { force: true, recursive: true })
      mkdirSync(marksFile())
      writeFileSync(join(marksFile(), 'held'), '')
    },
    marksText: (): string => readFileSync(marksFile(), 'utf8'),
    damagedMarksText: (): string => readFileSync(`${marksFile()}.damaged`, 'utf8'),
    answerOnWithdraw: (): void => writeFileSync(join(boardDir, 'answered-on-withdraw'), ''),
    reset: (): void => {
      for (const name of readdirSync(boardDir)) {
        if (name !== 'ai-workflow-app') {
          rmSync(join(boardDir, name), { force: true })
        }
      }
      rmSync(recordPath(), { force: true })
      rmSync(storePath(sessionGlobalScope(SESSION), 'turn-marks.json'), { force: true })
    },
    checkOutput: (): string => runMailbox(['check'], undefined, env).stdout,
    itemAdds: (): number =>
      existsSync(join(boardDir, 'calls.log'))
        ? readFileSync(join(boardDir, 'calls.log'), 'utf8')
            .split('\n')
            .filter((line) => line.startsWith('item add')).length
        : 0,
  }
}

test('a late start mark for an older prompt leaves the failed prompt resumable until a later turn starts', () => {
  const turns = promptOrderFixture()

  turns.succeeded('prompt-0')
  turns.failed('prompt-1', 'server_error')
  turns.started('prompt-0', 0)
  assert.match(turns.checkOutput(), /^\[turn\] failed-turn server_error /)
  turns.started('prompt-1', 1)
  assert.match(turns.checkOutput(), /^\[turn\] failed-turn server_error /)
  turns.startedLater('prompt-2', 0)
  assert.equal(turns.checkOutput(), '')
})

test('a later turn stops the resume of an unmarked failed prompt as it does a marked one', () => {
  const turns = promptOrderFixture()

  turns.failed('prompt-1', 'server_error')
  assert.match(turns.checkOutput(), /^\[turn\] failed-turn server_error /)
  turns.startedLater('prompt-2', 0)
  assert.equal(turns.checkOutput(), '')

  turns.succeeded('prompt-2')
  turns.startedLater('prompt-3', 10)
  turns.failed('prompt-3', 'server_error')
  assert.match(turns.checkOutput(), /^\[turn\] failed-turn server_error /)
  turns.startedLater('prompt-4', 20)
  assert.equal(turns.checkOutput(), '')
})

test('a failure for an unmarked prompt landing after a later success leaves no resume', () => {
  const turns = promptOrderFixture()

  turns.startedLater('prompt-2', 0)
  turns.succeeded('prompt-2')
  turns.failed('prompt-1', 'server_error')

  assert.equal(loadFailedTurn(SESSION), null)
  assert.equal(turns.checkOutput(), '')
})

test('an unmarked failure whose hook ran after the next turn started is recorded and not resumed', () => {
  const turns = promptOrderFixture()

  turns.startedJustBeforeNow('prompt-2')
  turns.failed('prompt-1', 'server_error')

  assert.equal(loadFailedTurn(SESSION)?.consecutive, 1)
  assert.equal(turns.checkOutput(), '')
})

const remedyOfPrompt = (addLine: string): string => {
  if (/could not be told/.test(addLine)) {
    return 'unproven'
  }
  if (/stopped on/.test(addLine)) {
    return 'credential'
  }
  if (/usage limit/.test(addLine)) {
    return 'rate-limit'
  }

  return /times in a row/.test(addLine) ? 'repeat' : 'unknown'
}

const WITHHELD_CHECKPOINT = /item add .*was not resumed/
const withdrawCalls = (turns: ReturnType<typeof promptOrderFixture>): number =>
  turns
    .boardLog()
    .split('\n')
    .filter((line) => line.startsWith('item withdraw')).length

test('a failure withheld because the order cannot be proven posts one checkpoint', () => {
  const turns = promptOrderFixture()

  turns.started('prompt-0', 0)
  turns.failed('prompt-1', 'server_error')
  assert.equal(turns.checkOutput(), '')
  assert.deepEqual(turns.itemAddCauses(), ['server_error'])
  assert.match(turns.boardLog(), WITHHELD_CHECKPOINT)

  assert.equal(turns.checkOutput(), '')
  assert.deepEqual(turns.itemAddCauses(), ['server_error'])
})

test('an older mark landing after the failure still posts one checkpoint', () => {
  const turns = promptOrderFixture()

  turns.failed('prompt-1', 'server_error')
  turns.started('prompt-0', 0)
  assert.equal(turns.checkOutput(), '')
  assert.equal(turns.checkOutput(), '')

  assert.deepEqual(turns.itemAddCauses(), ['server_error'])
})

test('the failed prompt own mark landing after the checkpoint withdraws it and resumes', () => {
  const turns = promptOrderFixture()

  turns.started('prompt-0', 0)
  turns.failed('prompt-1', 'server_error')
  assert.equal(turns.checkOutput(), '')
  turns.started('prompt-1', 1)

  assert.match(turns.checkOutput(), /^\[turn\] failed-turn server_error /)
  assert.equal(withdrawCalls(turns), 1)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, null)
})

test('a later success clears the withheld checkpoint and withdraws it', () => {
  const turns = promptOrderFixture()

  turns.started('prompt-0', 0)
  turns.failed('prompt-1', 'server_error')
  turns.checkOutput()
  turns.started('prompt-2', 2)
  turns.succeeded('prompt-2')

  assert.equal(withdrawCalls(turns), 1)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId ?? null, null)
  assert.equal(turns.checkOutput(), '')
})

test('a turn proven later than the failure posts no checkpoint and no resume', () => {
  const turns = promptOrderFixture()

  turns.started('prompt-0', 0)
  turns.failed('prompt-1', 'server_error')
  turns.startedLater('prompt-2', 0)

  assert.equal(turns.checkOutput(), '')
  assert.deepEqual(turns.itemAddCauses(), [])
})

test('a credential failure replaces an open unproven checkpoint with the credential item', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.failed('prompt-1', 'server_error')
  turns.checkOutput()
  assert.deepEqual(turns.itemRemedies(), ['unproven'])

  turns.failed('prompt-1', 'billing_error')
  turns.checkOutput()

  assert.deepEqual(turns.itemRemedies(), ['unproven', 'credential'])
  assert.deepEqual(turns.openItems(), ['item-2'])
  assert.equal(turns.itemState('item-1'), 'withdrawn')
  assert.equal(withdrawCalls(turns), 1)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, 'item-2')
})

test('a credential failure replaces an open rate limit item with the credential item', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-1', 'rate_limit')
  assert.deepEqual(turns.itemRemedies(), ['rate-limit'])

  turns.failed('prompt-1', 'authentication_failed')
  turns.checkOutput()

  assert.deepEqual(turns.itemRemedies(), ['rate-limit', 'credential'])
  assert.deepEqual(turns.openItems(), ['item-2'])
  assert.equal(turns.itemState('item-1'), 'withdrawn')
})

test('a credential failure arriving late for an older prompt replaces an open rate limit item', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-1', 'rate_limit')
  turns.failed('prompt-0', 'billing_error')
  turns.checkOutput()

  assert.equal(loadFailedTurn(SESSION)?.promptId, 'prompt-1')
  assert.deepEqual(turns.itemRemedies(), ['rate-limit', 'credential'])
  assert.deepEqual(turns.openItems(), ['item-2'])
  assert.equal(turns.itemState('item-1'), 'withdrawn')
})

test('a repeat of the same remedy keeps one item and withdraws nothing', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-1', 'billing_error')
  turns.failed('prompt-1', 'billing_error')
  turns.failed('prompt-1', 'authentication_failed')
  turns.checkOutput()

  assert.deepEqual(turns.itemRemedies(), ['credential'])
  assert.deepEqual(turns.openItems(), ['item-1'])
  assert.equal(withdrawCalls(turns), 0)
  assert.equal(loadFailedTurn(SESSION)?.consecutive, 3)
})

test('a weaker cause after a credential item leaves that item as it is', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-1', 'billing_error')
  turns.failed('prompt-1', 'rate_limit')
  turns.failed('prompt-1', 'server_error')
  turns.checkOutput()

  assert.equal(loadFailedTurn(SESSION)?.error, 'billing_error')
  assert.deepEqual(turns.itemRemedies(), ['credential'])
  assert.deepEqual(turns.openItems(), ['item-1'])
  assert.equal(withdrawCalls(turns), 0)
})

test('a replaced item the user answered meanwhile is not withdrawn twice and the new item stands', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.failed('prompt-1', 'server_error')
  turns.checkOutput()
  turns.answerOnWithdraw()

  turns.failed('prompt-1', 'billing_error')
  turns.checkOutput()
  turns.checkOutput()

  assert.deepEqual(turns.itemRemedies(), ['unproven', 'credential'])
  assert.equal(turns.itemState('item-1'), 'released')
  assert.deepEqual(turns.openItems(), ['item-2'])
  assert.equal(withdrawCalls(turns), 1)
  assert.deepEqual(loadFailedTurn(SESSION)?.staleBoardItemIds, [])
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, 'item-2')
})

test('a later turn started without a prompt id before the check posts no unproven checkpoint', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.failed('prompt-1', 'server_error')
  turns.startedLaterWithoutId()

  assert.equal(turns.checkOutput(), '')
  assert.deepEqual(turns.itemRemedies(), [])
})

test('a later turn started without a prompt id withdraws an open unproven checkpoint', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.failed('prompt-1', 'server_error')
  turns.checkOutput()
  assert.deepEqual(turns.openItems(), ['item-1'])

  turns.startedLaterWithoutId()
  assert.equal(turns.checkOutput(), '')

  assert.deepEqual(turns.openItems(), [])
  assert.equal(withdrawCalls(turns), 1)
  assert.deepEqual(turns.itemRemedies(), ['unproven'])
})

const ARRIVAL_EVENTS = {
  A: (turns: ReturnType<typeof promptOrderFixture>) => turns.started('prompt-0', 0),
  F: (turns: ReturnType<typeof promptOrderFixture>) => turns.failed('prompt-1', 'server_error'),
  L: (turns: ReturnType<typeof promptOrderFixture>) => turns.startedLater('prompt-2', 0),
  S: (turns: ReturnType<typeof promptOrderFixture>) => turns.succeeded('prompt-2'),
  N: (turns: ReturnType<typeof promptOrderFixture>) => turns.startedJustBeforeNowWithoutId(),
}

interface ArrivalRow {
  order: string
  resumed: boolean
  checkpoints: number
  withdraws: number
  recordKept: boolean
  openItems?: number
}

const assertArrivalOrders = (rows: ArrivalRow[]): void => {
  const turns = promptOrderFixture(STATEFUL_STUB)
  for (const row of rows) {
    turns.reset()
    let resumed = false
    for (const event of row.order) {
      ARRIVAL_EVENTS[event as keyof typeof ARRIVAL_EVENTS](turns)
      resumed = turns.checkOutput().includes('[turn] failed-turn') || resumed
    }

    assert.equal(resumed, row.resumed, `${row.order}: resumed`)
    assert.equal(
      turns.itemRemedies().filter((remedy) => remedy === 'unproven').length,
      row.checkpoints,
      `${row.order}: checkpoints`
    )
    assert.equal(withdrawCalls(turns), row.withdraws, `${row.order}: withdraws`)
    assert.equal(turns.openItems().length, row.openItems ?? 0, `${row.order}: open items`)
    assert.equal(loadFailedTurn(SESSION) !== null, row.recordKept, `${row.order}: record kept`)
  }
}

// A: an older turn started and never finished. F: the failure of an unmarked prompt. L: a later
// turn started after the failure. S: that later turn succeeded. N: a turn started just before the
// failure with no prompt id. A check runs after every event.
const ARRIVAL_ORDERS: ArrivalRow[] = [
  { order: 'AFLS', resumed: false, checkpoints: 1, withdraws: 1, recordKept: false },
  { order: 'ALFS', resumed: false, checkpoints: 0, withdraws: 0, recordKept: false },
  { order: 'ALSF', resumed: false, checkpoints: 0, withdraws: 0, recordKept: false },
  { order: 'FALS', resumed: true, checkpoints: 1, withdraws: 1, recordKept: false },
  { order: 'FLAS', resumed: true, checkpoints: 0, withdraws: 0, recordKept: false },
  { order: 'LFAS', resumed: false, checkpoints: 0, withdraws: 0, recordKept: false },
  { order: 'LSFA', resumed: false, checkpoints: 0, withdraws: 0, recordKept: false },
  { order: 'AFL', resumed: false, checkpoints: 1, withdraws: 1, recordKept: true },
]

test('every arrival order of mark, failure, later start and success gives the outcome its rule gives', () => {
  assertArrivalOrders(ARRIVAL_ORDERS)
})

test('a start without a prompt id before the failure is a mark that withholds the resume', () => {
  assertArrivalOrders([
    { order: 'NF', resumed: false, checkpoints: 1, withdraws: 0, recordKept: true, openItems: 1 },
    { order: 'ANF', resumed: false, checkpoints: 1, withdraws: 0, recordKept: true, openItems: 1 },
    { order: 'NFS', resumed: false, checkpoints: 1, withdraws: 1, recordKept: false },
    { order: 'NSF', resumed: false, checkpoints: 1, withdraws: 0, recordKept: true, openItems: 1 },
  ])
})

test('malformed marks with a later interrupted turn give one checkpoint and no resume', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.corruptMarks('{not json')
  turns.failed('prompt-1', 'server_error')

  assert.equal(turns.checkOutput(), '')
  assert.equal(turns.checkOutput(), '')
  assert.deepEqual(turns.itemRemedies(), ['unproven'])
  assert.equal(turns.marksText(), '{not json')
})

test('unreadable marks with a later interrupted turn give one checkpoint and no resume', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.blockMarks()
  turns.failed('prompt-1', 'server_error')

  assert.equal(turns.checkOutput(), '')
  assert.equal(turns.checkOutput(), '')
  assert.deepEqual(turns.itemRemedies(), ['unproven'])
})

test('a failure is recorded while the marks cannot be read', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.blockMarks()
  turns.failed('prompt-1', 'server_error')

  assert.equal(loadFailedTurn(SESSION)?.error, 'server_error')
  assert.equal(loadFailedTurn(SESSION)?.consecutive, 1)
})

test('a successful stop clears the record and the item while the marks cannot be written', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.blockMarks()
  turns.failed('prompt-1', 'server_error')
  turns.checkOutput()
  assert.deepEqual(turns.openItems(), ['item-1'])

  turns.succeeded('prompt-1')

  assert.equal(loadFailedTurn(SESSION), null)
  assert.equal(turns.checkOutput(), '')
  assert.deepEqual(turns.openItems(), [])
})

test('after a damaged marks file its bytes are kept aside, the history restarts and a normal failure resumes', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.corruptMarks('{not json')
  turns.started('prompt-1', 1)
  turns.succeeded('prompt-1')
  turns.failed('prompt-2', 'server_error')

  assert.match(turns.checkOutput(), /^\[turn\] failed-turn server_error /)
  assert.deepEqual(turns.itemRemedies(), [])
  assert.equal(turns.damagedMarksText(), '{not json')
  assert.deepEqual(
    loadTurnMarks(SESSION).started.map((mark) => mark.promptId),
    ['prompt-1']
  )
})

test('a credential item the user answered no longer stands for a later ordinary failure', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-1', 'billing_error')
  assert.deepEqual(turns.itemRemedies(), ['credential'])
  turns.answer('item-1')

  turns.failed('prompt-1', 'server_error')
  turns.checkOutput()

  assert.deepEqual(turns.itemRemedies(), ['credential', 'repeat'])
  assert.equal(loadFailedTurn(SESSION)?.error, 'server_error')
  assert.deepEqual(turns.openItems(), ['item-2'])
  assert.equal(withdrawCalls(turns), 0)
})

test('a stronger cause that arrived after an answered item still decides the next item', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-1', 'billing_error')
  turns.answer('item-1')
  turns.failAdd(true)
  turns.failed('prompt-1', 'authentication_failed')
  turns.failAdd(false)
  turns.failed('prompt-1', 'server_error')

  assert.equal(turns.itemRemedies().at(-1), 'credential')
  assert.deepEqual(turns.openItems(), ['item-2'])
})

test('a late credential failure after an answered rate-limit item posts the credential item', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-1', 'rate_limit')
  turns.answer('item-1')
  turns.failed('prompt-0', 'billing_error')

  assert.deepEqual(turns.itemRemedies(), ['rate-limit', 'credential'])
  assert.deepEqual(turns.openItems(), ['item-2'])
})

test('a marks write that fails after the bytes were copied leaves the malformed file in place and unproven', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.started('prompt-0', 0)
  turns.corruptMarks('{not json')

  assert.throws(
    () =>
      updateTurnMarks(SESSION, true, () => {
        throw new Error('write failed')
      }),
    /write failed/
  )

  assert.equal(turns.marksText(), '{not json')
  assert.equal(loadTurnMarks(SESSION).damage, 'malformed')
  turns.failed('prompt-1', 'server_error')
  assert.equal(turns.checkOutput(), '')
  assert.deepEqual(turns.itemRemedies(), ['unproven'])
})

test('a started array holding one invalid entry reads as damaged and never resumes', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)
  const invalidEntries = [
    '{"started":[{"promptId":"prompt-0","at":"2026-01-01T00:00:00.000Z"},1]}',
    '{"started":[{"promptId":"prompt-0","at":"not a date"}]}',
  ]

  for (const text of invalidEntries) {
    turns.reset()
    turns.started('prompt-0', 0)
    turns.corruptMarks(text)
    assert.equal(loadTurnMarks(SESSION).damage, 'malformed')
    turns.failed('prompt-1', 'server_error')

    assert.equal(turns.checkOutput(), '')
    assert.equal(turns.itemRemedies().length, 1)
  }
})

test('a malformed marks file is not moved aside while the record lock is not held', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.corruptMarks('{not json')
  writeFileSync(
    `${recordPath()}.lock`,
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() + 600_000 })
  )
  try {
    turns.started('prompt-1', 1)
  } finally {
    rmSync(`${recordPath()}.lock`, { force: true })
  }

  assert.equal(turns.marksText(), '{not json')
  assert.equal(existsSync(`${marksFile()}.damaged`), false)
})

test('a late hook for an older prompt keeps the newest prompt and the credential cause in either order', () => {
  const turns = promptOrderFixture()
  const settled = (): string[] => {
    const record = loadFailedTurn(SESSION)

    return [record?.promptId ?? '', record?.error ?? '', String(record?.consecutive)]
  }

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-1', 'billing_error')
  turns.failed('prompt-0', 'server_error')
  assert.deepEqual(settled(), ['prompt-1', 'billing_error', '2'])
  assert.deepEqual(new Set(turns.itemAddCauses()), new Set(['billing_error']))

  turns.succeeded('prompt-1')
  turns.started('prompt-2', 2)
  turns.started('prompt-3', 3)
  turns.failed('prompt-2', 'server_error')
  turns.failed('prompt-3', 'billing_error')
  assert.deepEqual(settled(), ['prompt-3', 'billing_error', '2'])
  assert.deepEqual(new Set(turns.itemAddCauses()), new Set(['billing_error']))
})

test('a credential cause survives a newer failure while its item has not posted', () => {
  const turns = promptOrderFixture()

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failBoard(true)
  turns.failed('prompt-0', 'billing_error')
  turns.failed('prompt-1', 'server_error')
  assert.equal(loadFailedTurn(SESSION)?.error, 'billing_error')

  turns.failBoard(false)
  turns.checkOutput()
  assert.match(turns.boardLog(), /item add .*billing_error/)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, 'item-1')
})

test('a credential failure for an older prompt still posts when a later turn was interrupted', () => {
  const turns = promptOrderFixture()

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-0', 'billing_error')

  assert.equal(loadFailedTurn(SESSION)?.boardItemId, 'item-1')
  assert.equal(turns.itemAdds(), 1)
  assert.equal(turns.checkOutput(), '')
})

test('failures of two prompts count as two and post a checkpoint', () => {
  const turns = promptOrderFixture()

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-0', 'server_error')
  turns.failed('prompt-1', 'server_error')

  assert.equal(loadFailedTurn(SESSION)?.consecutive, 2)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, 'item-1')
  assert.equal(turns.itemAdds(), 1)
})

test('a failure whose hook writes after a later prompt succeeded is dropped, a newer failure still records', () => {
  const turns = promptOrderFixture()

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.succeeded('prompt-1')
  turns.failed('prompt-0', 'billing_error')
  assert.equal(loadFailedTurn(SESSION), null)
  assert.equal(turns.itemAdds(), 0)

  turns.started('prompt-2', 2)
  turns.failed('prompt-2', 'server_error')
  assert.match(turns.checkOutput(), /^\[turn\] failed-turn server_error /)
})

test('a stop for an older prompt leaves a newer failure, and a later prompt stopping clears it', () => {
  const turns = promptOrderFixture()

  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-1', 'server_error')
  turns.succeeded('prompt-0')
  assert.equal(loadFailedTurn(SESSION)?.error, 'server_error')

  turns.started('prompt-2', 2)
  turns.succeeded('prompt-2')
  assert.equal(loadFailedTurn(SESSION), null)
})

test('a board session posts an unposted item from mailbox check once and withdraws it on success', () => {
  const boardDir = join(tmpDir, 'board')
  mkdirSync(boardDir)
  const stub = join(boardDir, 'ai-workflow-app')
  writeFileSync(stub, BOARD_STUB)
  chmodSync(stub, 0o755)
  writeFileSync(join(boardDir, 'fail'), '')
  registerBoardNode()
  const env = { AI_WORKFLOW_APP_BIN: stub, DASHBOARD_INVOKE_TIMEOUT_MS: '60000' }
  const itemCalls = (): string[] =>
    readFileSync(join(boardDir, 'calls.log'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('item '))
  const addLine =
    'item add --session node-1 --type approval --prompt=**This session stopped on `billing_error`.** ' +
    'Fix the account or sign-in, then approve this item to resume it.'

  const failed = runMailbox(['turn-failed'], JSON.stringify({ error: 'billing_error' }), env)
  assert.equal(failed.status, 0, failed.stderr)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, null)
  assert.deepEqual(itemCalls(), [addLine])

  rmSync(join(boardDir, 'fail'))
  const retried = runMailbox(['check'], undefined, env)
  assert.equal(retried.status, 0, retried.stderr)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, 'item-1')
  assert.deepEqual(itemCalls(), [addLine, addLine])

  runMailbox(['check'], undefined, env)
  assert.deepEqual(itemCalls(), [addLine, addLine])

  const cleared = runMailbox(['turn-succeeded'], undefined, env)
  assert.equal(cleared.status, 0, cleared.stderr)
  assert.deepEqual(itemCalls(), [addLine, addLine, 'item withdraw --item item-1'])
  assert.equal(loadFailedTurn(SESSION), null)
})

const liveNodeRows = ['node-1', 'leaf-a', 'leaf-b']
  .map(
    (id) =>
      `{"session":{"systemId":"claude-workflow","externalId":"${SESSION}:${id}","id":"${id}","lifecycle":"active"}}`
  )
  .join(',')

const LIVE_BOARD_STUB = BOARD_STUB.replace(
  'if [ "$1" = "answers" ]',
  `if [ "$1" = "session" ] && [ "$2" = "list" ]; then echo '[${liveNodeRows}]'; exit 0; fi\n` +
    'if [ "$1" = "answers" ]'
)

const refusingWithdrawStub = (refusal: string): string =>
  BOARD_STUB.replace(
    'if [ "$1" = "answers" ]',
    `if [ "$1" = "item" ] && [ "$2" = "withdraw" ]; then echo '${refusal}' >&2; exit 1; fi\n` +
      'if [ "$1" = "answers" ]'
  )

const boardFixture = (
  stubBody: string
): { boardDir: string; env: NodeJS.ProcessEnv; itemCalls: () => string[] } => {
  const boardDir = join(tmpDir, 'board')
  mkdirSync(boardDir)
  const stub = join(boardDir, 'ai-workflow-app')
  writeFileSync(stub, stubBody)
  chmodSync(stub, 0o755)
  registerBoardNode()

  return {
    boardDir,
    env: { AI_WORKFLOW_APP_BIN: stub, DASHBOARD_INVOKE_TIMEOUT_MS: '60000' },
    itemCalls: () =>
      readFileSync(join(boardDir, 'calls.log'), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('item ')),
  }
}

test('a failed withdraw leaves no resume pending and the next check retries it', () => {
  const { boardDir, env, itemCalls } = boardFixture(BOARD_STUB)
  const withdrawLine = 'item withdraw --item item-1'
  runMailbox(['turn-failed'], JSON.stringify({ error: 'billing_error' }), env)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, 'item-1')

  writeFileSync(join(boardDir, 'fail'), '')
  const failedClear = runMailbox(['turn-succeeded'], undefined, env)
  assert.equal(failedClear.status, 0, failedClear.stderr)
  const kept = loadFailedTurn(SESSION)
  assert.deepEqual(kept?.staleBoardItemIds, ['item-1'])
  assert.equal(kept?.boardItemId, null)
  assert.equal(kept?.consecutive, 0)
  assert.equal(pendingResume(SESSION), null)
  assert.equal(itemCalls().at(-1), withdrawLine)

  rmSync(join(boardDir, 'fail'))
  const retried = runMailbox(['check'], undefined, env)
  assert.equal(retried.status, 0, retried.stderr)
  assert.equal(retried.stdout, '')
  assert.equal(itemCalls().filter((line) => line === withdrawLine).length, 2)
  assert.equal(loadFailedTurn(SESSION), null)

  runMailbox(['check'], undefined, env)
  assert.equal(itemCalls().filter((line) => line === withdrawLine).length, 2)
})

test('a withdraw the board refuses for good finishes without a retry', () => {
  const refusals = [
    'item item-1 is released; only open, draft or ready items can be withdrawn',
    'item item-1 is consumed; only open, draft or ready items can be withdrawn',
    'Error: Item not found: item-1',
    'Session is ended: node-1',
    'Session not found: node-1',
    'Session is deleted: node-1',
  ]
  for (const refusal of refusals) {
    rmSync(join(tmpDir, 'board'), { recursive: true, force: true })
    rmSync(dirname(recordPath()), { recursive: true, force: true })
    const { env, itemCalls } = boardFixture(refusingWithdrawStub(refusal))
    const withdrawLine = 'item withdraw --item item-1'
    runMailbox(['turn-failed'], JSON.stringify({ error: 'billing_error' }), env)

    const cleared = runMailbox(['turn-succeeded'], undefined, env)
    assert.equal(cleared.status, 0, cleared.stderr)
    assert.equal(loadFailedTurn(SESSION), null, refusal)

    runMailbox(['check'], undefined, env)
    assert.equal(itemCalls().filter((line) => line === withdrawLine).length, 1, refusal)
  }
})

test('a failure with a multi-line last message posts as one item carrying the whole text', () => {
  const { boardDir, env } = boardFixture(BOARD_STUB)

  const failed = runMailbox(
    ['turn-failed'],
    JSON.stringify({ error: 'billing_error', last_assistant_message: 'building\nthe app' }),
    env
  )

  assert.equal(failed.status, 0, failed.stderr)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, 'item-1')
  assert.match(
    readFileSync(join(boardDir, 'calls.log'), 'utf8'),
    /stopped on `billing_error`\.\*\* Fix the account or sign-in, then approve this item to resume it\.\n\nError detail: building the app\n/
  )
})

const withSessionEnv = (change: () => void): void => {
  process.env.CLAUDE_CODE_SESSION_ID = SESSION
  try {
    change()
  } finally {
    delete process.env.CLAUDE_CODE_SESSION_ID
  }
}

const enterLeaf = (leaf: string): void =>
  withSessionEnv(() => {
    upsertRegistryNode(SESSION, {
      internalId: leaf,
      externalId: leaf,
      key: leaf,
      parentId: 'node-1',
    })
    saveDashboardState(leaf, { registered: true, phase: 'implementation', openItemIds: [] })
  })

const ledgerOf = (node: string): string[] | undefined => {
  let ledger: string[] | undefined
  withSessionEnv(() => {
    ledger = loadDashboardState(node)?.openItemIds
  })

  return ledger
}

test('a withdraw empties the ledger of the node that holds the item when the leaf set changed', () => {
  const { env } = boardFixture(LIVE_BOARD_STUB)

  enterLeaf('leaf-a')
  runMailbox(['turn-failed'], JSON.stringify({ error: 'billing_error' }), env)
  assert.deepEqual(ledgerOf('leaf-a'), ['item-1'])
  enterLeaf('leaf-b')
  assert.equal(runMailbox(['turn-succeeded'], undefined, env).status, 0)

  assert.deepEqual(ledgerOf('leaf-a'), [])
  assert.deepEqual(ledgerOf('node-1'), [])
  assert.match(
    runMailbox(['stop-gate'], undefined, { ...env, CLAUDE_CODE_SESSION_ID: SESSION }).stdout,
    /^block\n/
  )

  rmSync(recordPath(), { force: true })
  runMailbox(['turn-failed'], JSON.stringify({ error: 'billing_error' }), env)
  assert.deepEqual(ledgerOf('node-1'), ['item-1'])
  withSessionEnv(() => removeRegistryNode(SESSION, 'leaf-b'))
  assert.equal(runMailbox(['turn-succeeded'], undefined, env).status, 0)

  assert.deepEqual(ledgerOf('node-1'), [])
  assert.deepEqual(ledgerOf('leaf-a'), [])
  assert.match(
    runMailbox(['stop-gate'], undefined, { ...env, CLAUDE_CODE_SESSION_ID: SESSION }).stdout,
    /^block\n/
  )
})

test('a saved record without item nodes loads and withdraws on the node chosen now', () => {
  const { env, itemCalls } = boardFixture(BOARD_STUB)
  runMailbox(['turn-failed'], JSON.stringify({ error: 'billing_error' }), env)
  const saved = JSON.parse(readFileSync(recordPath(), 'utf8'))
  delete saved.itemNodes
  writeFileSync(recordPath(), JSON.stringify(saved))

  assert.deepEqual(loadFailedTurn(SESSION)?.itemNodes, {})
  assert.equal(runMailbox(['turn-succeeded'], undefined, env).status, 0)

  assert.equal(itemCalls().at(-1), 'item withdraw --item item-1')
  assert.equal(loadFailedTurn(SESSION), null)
})

test('a session with two live leaves posts and withdraws on its root node', () => {
  const { env, itemCalls } = boardFixture(BOARD_STUB)
  process.env.CLAUDE_CODE_SESSION_ID = SESSION
  try {
    for (const leaf of ['leaf-a', 'leaf-b']) {
      upsertRegistryNode(SESSION, {
        internalId: leaf,
        externalId: leaf,
        key: leaf,
        parentId: 'node-1',
      })
    }
  } finally {
    delete process.env.CLAUDE_CODE_SESSION_ID
  }

  const failed = runMailbox(['turn-failed'], JSON.stringify({ error: 'billing_error' }), env)
  assert.equal(failed.status, 0, failed.stderr)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, 'item-1')

  const cleared = runMailbox(['turn-succeeded'], undefined, env)
  assert.equal(cleared.status, 0, cleared.stderr)

  const calls = itemCalls()
  assert.equal(calls.length, 2)
  assert.match(calls[0], /^item add --session node-1 --type approval /)
  assert.equal(calls[1], 'item withdraw --item item-1')
  assert.equal(loadFailedTurn(SESSION), null)
})

test('a withdraw made while the board binary is missing stays owed and is made once it is back', () => {
  const { env, itemCalls } = boardFixture(BOARD_STUB)
  const withdrawLine = 'item withdraw --item item-1'
  runMailbox(['turn-failed'], JSON.stringify({ error: 'billing_error' }), env)
  const unreachable = { AI_WORKFLOW_APP_BIN: join(tmpDir, 'no-such-board') }

  const cleared = runMailbox(['turn-succeeded'], undefined, unreachable)
  assert.equal(cleared.status, 0, cleared.stderr)
  runMailbox(['check'], undefined, unreachable)

  assert.deepEqual(loadFailedTurn(SESSION)?.staleBoardItemIds, ['item-1'])
  assert.deepEqual(loadFailedTurn(SESSION)?.withdrawAttempts, {})
  assert.equal(itemCalls().filter((line) => line === withdrawLine).length, 0)

  runMailbox(['check'], undefined, env)

  assert.equal(itemCalls().filter((line) => line === withdrawLine).length, 1)
  assert.equal(loadFailedTurn(SESSION), null)
})

test('a withdraw that keeps failing is retried a bounded number of times and then dropped', () => {
  recordFailedTurn({ error: 'billing_error' }, SESSION, true, () => 'item-1')
  let calls = 0
  const failing = (): 'failed' => {
    calls += 1

    return 'failed'
  }
  clearFailedTurn(SESSION, failing)
  assert.deepEqual(loadFailedTurn(SESSION)?.staleBoardItemIds, ['item-1'])

  for (let check = 0; check < 10; check += 1) {
    retryStaleWithdraw(SESSION, failing)
  }

  assert.equal(calls, 5)
  assert.equal(loadFailedTurn(SESSION), null)
})

test('an old lock file with no readable holder is stolen instead of waited out', () => {
  recordFailedTurn({ error: 'server_error' }, SESSION, false, recordingPost().post)
  const recordFile = storePath(sessionGlobalScope(SESSION), 'failed-turn.json')
  const lockFile = `${recordFile}.lock`
  writeFileSync(lockFile, '')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lockFile, old, old)
  const started = Date.now()
  let holder: unknown

  withRecordLock(recordFile, () => {
    holder = JSON.parse(readFileSync(lockFile, 'utf8')).pid
  })

  assert.equal(holder, process.pid)
  assert.ok(Date.now() - started < 3_000)
  assert.equal(existsSync(lockFile), false)
})

test('waiters released together on a dead holder never hold the lock at the same time', async () => {
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(gone, 'exit')

  for (let trial = 0; trial < LOCK_TRIALS; trial += 1) {
    const recordFile = join(tmpDir, `lock-${trial}.json`)
    const log = join(tmpDir, `lock-${trial}.log`)
    const goFile = join(tmpDir, `lock-${trial}.go`)
    writeFileSync(`${recordFile}.lock`, JSON.stringify({ pid: gone.pid, acquiredAt: Date.now() }))
    const waiters = Array.from({ length: LOCK_WAITERS }, (_, index) =>
      spawnLockWaiter(recordFile, join(tmpDir, `lock-${trial}-${index}.ready`), goFile, log)
    )

    const exits = waiters.map((waiter) => exitOf(waiter))
    for (let index = 0; index < waiters.length; index += 1) {
      await waitForFile(join(tmpDir, `lock-${trial}-${index}.ready`), waiters)
    }
    writeFileSync(goFile, String(Date.now() + 300))
    for (const [index, exited] of exits.entries()) {
      const [, signal] = await withinDeadline(exited, `waiter ${index} exiting`)
      assert.equal(signal, 'SIGKILL')
    }

    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.filter((line) => line === 'held').length, LOCK_WAITERS)
    assert.equal(lines.filter((line) => line === 'overlap').length, 0)
    assert.equal(existsSync(`${recordFile}.lock.reaper`), false)
  }
})

test('a waiter that read a dead holder before another process took the lock leaves that lock in place', async () => {
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(gone, 'exit')
  const recordFile = join(tmpDir, 'forced.json')
  const gate = join(tmpDir, 'forced.gate')
  const files = ['held', 'release', 'released', 'entered'].map((name) =>
    join(tmpDir, `forced.${name}`)
  )
  const [held, release, , entered] = files
  writeFileSync(`${recordFile}.lock`, JSON.stringify({ pid: gone.pid, acquiredAt: Date.now() }))

  const waiter = spawnForcedLockProcess('enter', recordFile, files, {
    RECORD_LOCK_PAUSE_FILE: gate,
  })
  await waitForFileUnlessExited(`${gate}.paused`, waiter)
  const holder = spawnForcedLockProcess('hold', recordFile, files)
  await waitForFileUnlessExited(held, holder)
  writeFileSync(gate, '')

  const settle = Date.now() + 1_500
  while (!existsSync(entered) && Date.now() < settle) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  writeFileSync(release, '')
  await waitForFileUnlessExited(entered, waiter)
  const [waiterExit, holderExit] = await Promise.all([
    withinDeadline(waiter.exited, 'the waiter'),
    withinDeadline(holder.exited, 'the holder'),
  ])

  assert.deepEqual(
    [waiterExit.code, holderExit.code],
    [0, 0],
    waiterExit.stderr + holderExit.stderr
  )
  assert.equal(readFileSync(entered, 'utf8'), 'after-release')
})

test('a steal removes only the holder it judged stale and never a lock taken after the holder released', async () => {
  const recordFile = join(tmpDir, 'steal.json')
  const gate = join(tmpDir, 'steal.gate')
  const filesFor = (name: string): string[] =>
    ['held', 'release', 'released', 'entered'].map((part) => join(tmpDir, `${name}.${part}`))
  const [oldHeld, oldRelease] = filesFor('old')
  const [newHeld, newRelease, , newEntered] = filesFor('new')
  const [, , , stealerEntered] = filesFor('stealer')

  const oldHolder = spawnForcedLockProcess('hold', recordFile, filesFor('old'))
  await waitForFileUnlessExited(oldHeld, oldHolder)
  const lockFile = `${recordFile}.lock`
  const heldBy = JSON.parse(readFileSync(lockFile, 'utf8'))
  writeFileSync(lockFile, JSON.stringify({ ...heldBy, acquiredAt: Date.now() - 60_000 }))

  const stealer = spawnForcedLockProcess('enter', recordFile, filesFor('stealer'), {
    RECORD_LOCK_PAUSE_AFTER_JUDGING_FILE: gate,
  })
  await waitForFileUnlessExited(`${gate}.paused`, stealer)
  writeFileSync(oldRelease, '')
  await new Promise((resolve) => setTimeout(resolve, 300))
  const newHolder = spawnForcedLockProcess('hold', recordFile, filesFor('new'))
  await new Promise((resolve) => setTimeout(resolve, 300))
  writeFileSync(gate, '')
  await waitForFileUnlessExited(newHeld, newHolder)

  const newer = spawnForcedLockProcess('enter', recordFile, filesFor('new'))
  const settle = Date.now() + 1_500
  while (!existsSync(newEntered) && Date.now() < settle) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const enteredWhileHeld = existsSync(newEntered)
  writeFileSync(newRelease, '')
  await waitForFileUnlessExited(newEntered, newer)
  await Promise.all([
    withinDeadline(oldHolder.exited, 'the old holder'),
    withinDeadline(stealer.exited, 'the stealer'),
    withinDeadline(newHolder.exited, 'the new holder'),
    withinDeadline(newer.exited, 'the newer waiter'),
  ])

  assert.equal(enteredWhileHeld, false)
  assert.equal(readFileSync(newEntered, 'utf8'), 'after-release')
  assert.equal(existsSync(stealerEntered), true)
})

test('a reaper file left by a crashed process does not hold up stealing a dead lock', async () => {
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(gone, 'exit')
  recordFailedTurn({ error: 'server_error' }, SESSION, false, recordingPost().post)
  const recordFile = storePath(sessionGlobalScope(SESSION), 'failed-turn.json')
  const lockFile = `${recordFile}.lock`
  writeFileSync(lockFile, JSON.stringify({ pid: gone.pid, acquiredAt: Date.now() }))
  writeFileSync(`${lockFile}.reaper`, '')
  const old = new Date(Date.now() - 5_000)
  utimesSync(`${lockFile}.reaper`, old, old)
  const started = Date.now()
  let holder: unknown

  withRecordLock(recordFile, () => {
    holder = JSON.parse(readFileSync(lockFile, 'utf8')).pid
  })

  assert.equal(holder, process.pid)
  assert.ok(Date.now() - started < 4_000)
  assert.equal(existsSync(`${lockFile}.reaper`), false)
})

test('a turn-started mark waits for the record lock instead of writing past it', async () => {
  recordFailedTurn({ error: 'server_error' }, SESSION, false, recordingPost().post)
  const recordFile = storePath(sessionGlobalScope(SESSION), 'failed-turn.json')
  let markedWhileLocked: boolean | undefined
  let child: ReturnType<typeof spawn> | undefined

  const readyFile = join(tmpDir, 'mark-ready')
  withRecordLock(recordFile, () => {
    child = spawnChild('mark', readyFile, '-', '-')
    const deadline = Date.now() + 60_000
    while (!existsSync(readyFile) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    assert.ok(existsSync(readyFile), 'the child never started')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    markedWhileLocked = loadFailedTurn(SESSION)?.turnStartedSince
  })

  assert.equal(markedWhileLocked, false)
  assert.ok(child)
  const [code] = await exitWithin(child)
  assert.equal(code, 0)
  assert.equal(loadFailedTurn(SESSION)?.turnStartedSince, true)
})

test('a clear that lands during an in-flight post leaves no live record and withdraws the posted item', () => {
  const failure = recordFailedTurn({ error: 'billing_error' }, SESSION, false, recordingPost().post)

  const landed = postIfNeeded(failure, () => {
    clearFailedTurn(SESSION, () => 'done')

    return 'item-1'
  })

  assert.deepEqual(landed.staleBoardItemIds, ['item-1'])
  const stale = loadFailedTurn(SESSION)
  assert.deepEqual(stale?.staleBoardItemIds, ['item-1'])
  assert.equal(stale?.boardItemId, null)
  assert.equal(stale?.consecutive, 0)
  assert.equal(pendingResume(SESSION), null)

  const withdrawn: string[] = []
  retryStaleWithdraw(SESSION, (itemId) => {
    withdrawn.push(itemId)

    return 'done'
  })
  assert.deepEqual(withdrawn, ['item-1'])
  assert.equal(loadFailedTurn(SESSION), null)
})

test('a post that outlives its claim lands as a stale item beside the one that took over', () => {
  const failure = recordFailedTurn({ error: 'billing_error' }, SESSION, false, recordingPost().post)

  const landed = postIfNeeded(failure, () => {
    const held = JSON.parse(readFileSync(recordPath(), 'utf8'))
    held.postingSince = new Date(Date.now() - 10 * 60_000).toISOString()
    writeFileSync(recordPath(), JSON.stringify(held))
    postIfNeeded(failure, () => 'item-B')

    return 'item-A'
  })

  assert.equal(loadFailedTurn(SESSION)?.boardItemId, 'item-B')
  assert.deepEqual(landed.staleBoardItemIds, ['item-A'])
  assert.deepEqual(loadFailedTurn(SESSION)?.staleBoardItemIds, ['item-A'])
})

test('an item the current failure still holds is never withdrawn as stale', () => {
  recordFailedTurn({ error: 'billing_error' }, SESSION, true, () => 'item-1')
  const second = recordFailedTurn({ error: 'billing_error' }, SESSION, false, () => null)

  const ids = ['item-2', 'item-3']
  postIfNeeded(
    second,
    () => {
      if (ids.length === 2) {
        recordFailedTurn(
          { error: 'billing_error' },
          SESSION,
          false,
          () => null,
          new Date(Date.now() + 5_000)
        )
      }

      return ids.shift() ?? null
    },
    () => 'unknown'
  )
  assert.deepEqual(loadFailedTurn(SESSION)?.staleBoardItemIds, ['item-1', 'item-2'])

  const withdrawn: string[] = []
  const withdraw = (id: string): 'done' => {
    withdrawn.push(id)

    return 'done'
  }
  retryStaleWithdraw(SESSION, withdraw)

  const record = loadFailedTurn(SESSION)
  assert.deepEqual(withdrawn, ['item-1', 'item-2'])
  assert.equal(record?.boardItemId, 'item-3')
  assert.equal(record?.consecutive, 3)
  assert.deepEqual(record?.staleBoardItemIds, [])

  const saved = JSON.parse(readFileSync(recordPath(), 'utf8'))
  saved.staleBoardItemIds = ['item-3', 'item-9']
  writeFileSync(recordPath(), JSON.stringify(saved))
  withdrawn.length = 0
  retryStaleWithdraw(SESSION, withdraw)

  assert.deepEqual(withdrawn, ['item-9'])
  assert.deepEqual(loadFailedTurn(SESSION)?.staleBoardItemIds, [])
})

test('three processes racing on an unposted item post it once', async () => {
  recordFailedTurn({ error: 'billing_error' }, SESSION, false, recordingPost().post)
  const goFile = join(tmpDir, 'go')
  const postLog = join(tmpDir, 'posts.log')
  const racers = [0, 1, 2].map((index) =>
    spawnChild('post', join(tmpDir, `ready-${index}`), goFile, postLog)
  )

  const exits = racers.map((racer) => exitOf(racer))
  for (let index = 0; index < racers.length; index += 1) {
    await waitForFile(join(tmpDir, `ready-${index}`), racers)
  }
  writeFileSync(goFile, '')
  for (const [index, exited] of exits.entries()) {
    const [code] = await withinDeadline(exited, `racer ${index} exiting`)
    assert.equal(code, 0)
  }

  const posts = readFileSync(postLog, 'utf8').split('\n').filter(Boolean)
  assert.equal(posts.length, 1)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, posts[0].replace('post ', ''))
  assert.deepEqual(loadFailedTurn(SESSION)?.staleBoardItemIds, [])
})

test('an invalid started-at is rejected with the history unchanged and an ISO instant still marks', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)
  turns.started('prompt-0', 0)
  const before = turns.marksText()

  const rejected = turns.startedAtRaw('not-a-time')

  assert.notEqual(rejected.status, 0)
  assert.equal(turns.marksText(), before)
  assert.equal(loadTurnMarks(SESSION).damage, undefined)
  assert.equal(turns.startedAtRaw('2026-01-01T00:00:00.000Z').status, 0)
  assert.deepEqual(
    loadTurnMarks(SESSION).started.map((mark) => mark.promptId),
    ['prompt-x', 'prompt-0']
  )
})

test('a stop failure payload with a wrong-typed optional field is still recorded', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)

  turns.failedRaw({
    error: 'server_error',
    prompt_id: 5,
    error_details: { nested: true },
    last_assistant_message: 7,
  })

  const record = loadFailedTurn(SESSION)
  assert.equal(record?.error, 'server_error')
  assert.equal(record?.promptId, null)
  assert.equal(record?.lastMessage, null)
})

test('marking an existing prompt succeeded keeps its position among equal timestamps', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)
  turns.started('prompt-a', 0)
  turns.started('prompt-b', 0)
  turns.started('prompt-c', 0)

  turns.succeeded('prompt-a')

  const marks = loadTurnMarks(SESSION).started
  assert.deepEqual(
    marks.map((mark) => mark.promptId),
    ['prompt-a', 'prompt-b', 'prompt-c']
  )
  assert.equal(marks[0].succeeded, true)
})

test('a failure with no prompt id never resumes over damaged marks and posts the checkpoint', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)
  turns.started('prompt-0', 0)
  turns.corruptMarks('{not json')

  turns.failedRaw({ error: 'server_error' })

  assert.equal(turns.checkOutput(), '')
  assert.deepEqual(turns.itemRemedies(), ['unproven'])

  turns.reset()
  turns.failedRaw({ error: 'server_error' })
  assert.match(turns.checkOutput(), /^\[turn\] failed-turn server_error /)
  assert.deepEqual(turns.itemRemedies(), [])
})

test('a failure with no prompt id is not resumable when a start at or after it is already marked', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)
  turns.startedLater('prompt-later', 0)

  turns.failedRaw({ error: 'server_error' })

  assert.equal(loadFailedTurn(SESSION)?.turnStartedSince, true)
  assert.equal(pendingResume(SESSION), null)

  turns.reset()
  turns.started('prompt-0', 0)
  turns.failedRaw({ error: 'server_error' })
  assert.equal(loadFailedTurn(SESSION)?.turnStartedSince, false)
  assert.notEqual(pendingResume(SESSION), null)
})

test('a stored record with wrong-typed optional fields loads with those fields defaulted', () => {
  recordFailedTurn({ error: 'billing_error' }, SESSION, false, () => null)
  const saved = JSON.parse(readFileSync(recordPath(), 'utf8'))
  Object.assign(saved, {
    lastMessage: 3,
    promptId: {},
    boardItemId: 4,
    priorBoardItemId: [],
    causeSincePost: 7,
    postingSince: 8,
    boardRemedy: 'bogus',
    staleBoardItemIds: 'item-1',
    withdrawAttempts: 5,
    itemNodes: [],
  })
  writeFileSync(recordPath(), JSON.stringify(saved))

  const record = loadFailedTurn(SESSION)

  assert.equal(record?.error, 'billing_error')
  assert.deepEqual(
    [record?.lastMessage, record?.promptId, record?.boardItemId, record?.priorBoardItemId],
    [null, null, null, null]
  )
  assert.deepEqual(
    [record?.causeSincePost, record?.postingSince, record?.boardRemedy],
    [null, null, null]
  )
  assert.deepEqual(
    [record?.staleBoardItemIds, record?.withdrawAttempts, record?.itemNodes],
    [[], {}, {}]
  )
})

test('a second failure during an in-flight post posts nothing and keeps the item when its remedy stands', () => {
  const failure = recordFailedTurn({ error: 'billing_error' }, SESSION, false, () => null)
  const posted: string[] = []
  let inFlight = false
  const post: PostItem = () => {
    posted.push('outer')
    if (inFlight) {
      return 'item-2'
    }

    inFlight = true
    const next = recordFailedTurn(
      { error: 'rate_limit' },
      SESSION,
      false,
      () => null,
      new Date(Date.now() + 5_000)
    )
    postIfNeeded(next, () => {
      posted.push('inner')

      return 'item-inner'
    })

    return 'item-1'
  }

  postIfNeeded(failure, post)

  const record = loadFailedTurn(SESSION)
  assert.deepEqual(posted, ['outer'])
  assert.equal(record?.boardItemId, 'item-1')
  assert.deepEqual(record?.staleBoardItemIds, [])
  assert.equal(record?.consecutive, 2)
})

test('a second failure during an in-flight post replaces the item when it needs a stronger remedy', () => {
  const failure = recordFailedTurn({ error: 'rate_limit' }, SESSION, false, () => null)
  const posted: string[] = []
  let inFlight = false
  const post: PostItem = () => {
    posted.push('outer')
    if (inFlight) {
      return 'item-2'
    }

    inFlight = true
    const next = recordFailedTurn(
      { error: 'billing_error' },
      SESSION,
      false,
      () => null,
      new Date(Date.now() + 5_000)
    )
    postIfNeeded(next, () => {
      posted.push('inner')

      return 'item-inner'
    })

    return 'item-1'
  }

  postIfNeeded(failure, post)

  const record = loadFailedTurn(SESSION)
  assert.deepEqual(posted, ['outer', 'outer'])
  assert.equal(record?.boardItemId, 'item-2')
  assert.deepEqual(record?.staleBoardItemIds, ['item-1'])
})

test('withdrawals start no later than the deadline and the unattempted ids stay in the record', () => {
  recordFailedTurn({ error: 'billing_error' }, SESSION, false, () => null)
  const saved = JSON.parse(readFileSync(recordPath(), 'utf8'))
  saved.staleBoardItemIds = ['item-a', 'item-b', 'item-c']
  writeFileSync(recordPath(), JSON.stringify(saved))
  const attempted: string[] = []

  retryStaleWithdraw(
    SESSION,
    (id) => {
      attempted.push(id)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)

      return 'done'
    },
    Date.now() + 150
  )

  assert.deepEqual(attempted, ['item-a'])
  assert.deepEqual(loadFailedTurn(SESSION)?.staleBoardItemIds, ['item-b', 'item-c'])

  retryStaleWithdraw(SESSION, (id) => {
    attempted.push(id)

    return 'done'
  })
  assert.deepEqual(attempted, ['item-a', 'item-b', 'item-c'])
})

test('a post is not started once the deadline passed during the item state read and its claim is released', () => {
  recordFailedTurn({ error: 'billing_error' }, SESSION, true, () => 'item-1')
  const failure = recordFailedTurn({ error: 'billing_error' }, SESSION, false, () => null)
  const posted: string[] = []

  postIfNeeded(
    failure,
    () => {
      posted.push('post')

      return 'item-1'
    },
    () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)

      return 'closed'
    },
    () => null,
    false,
    Date.now() + 150
  )

  const record = loadFailedTurn(SESSION)
  assert.deepEqual(posted, [])
  assert.equal(record?.boardItemId, null)
  assert.equal(record?.postingSince, null)
})

test('a late failure for an older prompt during an in-flight post keeps its cause and gets the credential item', () => {
  markTurnStarted(SESSION, '2026-01-01T00:00:00.000Z', 'p1')
  markTurnStarted(SESSION, '2026-01-01T00:00:10.000Z', 'p2')
  const failure = recordFailedTurn(
    { error: 'rate_limit', prompt_id: 'p2' },
    SESSION,
    false,
    () => null
  )
  const kinds: BoardKind[] = []
  let inFlight = false
  const post: PostItem = (kind) => {
    kinds.push(kind)
    if (inFlight) {
      return 'item-2'
    }

    inFlight = true
    const late = recordFailedTurn(
      { error: 'billing_error', prompt_id: 'p1' },
      SESSION,
      false,
      () => null,
      new Date(Date.now() + 5_000)
    )
    postIfNeeded(late, () => 'item-inner')

    return 'item-1'
  }

  postIfNeeded(failure, post)

  const record = loadFailedTurn(SESSION)
  assert.deepEqual(kinds, ['checkpoint', 'credential'])
  assert.equal(record?.error, 'billing_error')
  assert.equal(record?.boardItemId, 'item-2')
  assert.deepEqual(record?.staleBoardItemIds, ['item-1'])
})

test('the item state is not read when the deadline passes while the claim waits for the record lock', async () => {
  recordFailedTurn({ error: 'billing_error' }, SESSION, true, () => 'item-1')
  const failure = recordFailedTurn({ error: 'billing_error' }, SESSION, false, () => null)
  const files = ['held', 'release', 'released', 'entered'].map((name) =>
    join(tmpDir, `deadline.${name}`)
  )
  const holder = spawnForcedLockProcess('hold', recordPath(), files)
  await waitForFileUnlessExited(files[0], holder)
  track(
    spawn(
      process.execPath,
      [
        '-e',
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(files[1])}, ''), 400)`,
      ],
      { stdio: 'ignore' }
    )
  )
  const reads: string[] = []
  const posted: string[] = []

  postIfNeeded(
    failure,
    () => {
      posted.push('post')

      return 'item-2'
    },
    (id) => {
      reads.push(id)

      return 'closed'
    },
    () => null,
    false,
    Date.now() + 150
  )

  const record = loadFailedTurn(SESSION)
  assert.deepEqual(reads, [])
  assert.deepEqual(posted, [])
  assert.equal(record?.postingSince, null)
  assert.equal(record?.boardItemId, null)
})

test('an unseen prompt succeeding after a running turn does not make a later failure resumable', () => {
  markTurnStarted(SESSION, '2026-01-01T00:00:04.000Z', 'running')
  clearFailedTurn(SESSION, () => 'done', 'unseen', new Date('2026-01-01T00:00:04.500Z'))
  recordFailedTurn(
    { error: 'server_error', prompt_id: 'failed' },
    SESSION,
    false,
    () => null,
    new Date('2026-01-01T00:00:05.000Z')
  )

  assert.equal(pendingResume(SESSION), null)

  clearFailedTurn(SESSION, () => 'done', 'running', new Date('2026-01-01T00:00:06.000Z'))
  recordFailedTurn(
    { error: 'server_error', prompt_id: 'failed-2' },
    SESSION,
    false,
    () => null,
    new Date('2026-01-01T00:00:07.000Z')
  )

  assert.equal(pendingResume(SESSION)?.promptId, 'failed-2')
})

test('a success with no start mark of its own does not discard the failure of a marked turn', () => {
  const turns = promptOrderFixture(STATEFUL_STUB)
  turns.started('prompt-3', 0)
  turns.startedJustBeforeNowWithoutId()

  turns.succeeded('prompt-2')
  turns.failed('prompt-3', 'billing_error')

  assert.equal(loadFailedTurn(SESSION)?.promptId, 'prompt-3')
  assert.deepEqual(turns.itemRemedies(), ['credential'])
  assert.deepEqual(turns.openItems(), ['item-1'])
})

test('an unseen prompt succeeding during an in-flight post still lets the next failure reach the board', () => {
  markTurnStarted(SESSION, '2026-01-01T00:00:00.000Z', 'p1')
  const failure = recordFailedTurn(
    { error: 'rate_limit', prompt_id: 'p1' },
    SESSION,
    false,
    () => null
  )
  const kinds: BoardKind[] = []
  let inFlight = false
  const post: PostItem = (kind) => {
    kinds.push(kind)
    if (inFlight) {
      return 'item-2'
    }

    inFlight = true
    clearFailedTurn(SESSION, () => 'done', 'unseen')
    recordFailedTurn(
      { error: 'billing_error', prompt_id: 'p2' },
      SESSION,
      true,
      (kindOfNext) => {
        kinds.push(kindOfNext)

        return 'item-credential'
      },
      new Date(Date.now() + 5_000)
    )

    return 'item-1'
  }

  postIfNeeded(failure, post)

  const record = loadFailedTurn(SESSION)
  assert.deepEqual(kinds, ['checkpoint', 'credential'])
  assert.equal(record?.error, 'billing_error')
  assert.equal(record?.boardItemId, 'item-credential')
  assert.deepEqual(record?.staleBoardItemIds, ['item-1'])
})

test('a stored record still carrying the removed unordered-success field loads and counts on', () => {
  recordFailedTurn({ error: 'server_error' }, SESSION, false, () => null)
  const saved = JSON.parse(readFileSync(recordPath(), 'utf8'))
  saved.hasUnorderedSuccess = true
  writeFileSync(recordPath(), JSON.stringify(saved))

  const next = recordFailedTurn(
    { error: 'server_error' },
    SESSION,
    false,
    () => null,
    new Date(Date.now() + 5_000)
  )

  assert.equal(next.consecutive, 2)
})

test('while the marks file cannot be written a failure is resumed once and its resumed turn clears it', (context) => {
  if (process.platform !== 'darwin') {
    context.skip('the unwritable marks file is made with chflags uchg, which only macOS has')

    return
  }

  const turns = promptOrderFixture(STATEFUL_STUB)
  turns.started('prompt-0', 0)
  turns.started('prompt-1', 1)
  turns.failed('prompt-1', 'server_error')
  const locked = spawnSync('chflags', ['uchg', marksFile()], { encoding: 'utf8' })
  assert.equal(locked.status, 0, `chflags uchg failed: ${locked.stderr}`)
  let resumes = 0
  try {
    resumes += turns.checkOutput().includes('[turn] failed-turn') ? 1 : 0
    for (let turn = 0; turn < 4; turn += 1) {
      turns.started(`prompt-r${turn}`, 2 + turn)
      turns.succeeded(`prompt-r${turn}`)
      resumes += turns.checkOutput().includes('[turn] failed-turn') ? 1 : 0
    }
  } finally {
    const unlocked = spawnSync('chflags', ['nouchg', marksFile()], { encoding: 'utf8' })
    assert.equal(unlocked.status, 0, `chflags nouchg failed: ${unlocked.stderr}`)
  }

  assert.equal(resumes, 1)
  assert.equal(loadFailedTurn(SESSION), null)
  assert.deepEqual(turns.openItems(), [])
})

test('unplaced successes never evict a placed start and the stored marks stay sorted by time', () => {
  markTurnStarted(SESSION, '2026-01-01T00:00:01.000Z', 'running')
  for (let index = 0; index < 8; index += 1) {
    clearFailedTurn(
      SESSION,
      () => 'done',
      `unseen-${index}`,
      new Date(`2026-01-01T00:00:0${index + 2}.000Z`)
    )
  }

  recordFailedTurn(
    { error: 'server_error', prompt_id: 'failed' },
    SESSION,
    false,
    () => null,
    new Date('2026-01-01T00:00:20.000Z')
  )

  const stored = loadTurnMarks(SESSION).started
  assert.equal(
    stored.some((mark) => mark.promptId === 'running'),
    true
  )
  assert.equal(stored.filter((mark) => mark.unplaced === true).length, 8)
  assert.deepEqual(
    stored.map((mark) => mark.at),
    stored.map((mark) => mark.at).sort()
  )
  assert.equal(pendingResume(SESSION), null)

  for (let index = 0; index < 9; index += 1) {
    markTurnStarted(SESSION, `2026-01-01T00:01:0${index}.000Z`, `later-${index}`)
  }

  const kept = loadTurnMarks(SESSION).started
  assert.equal(kept.filter((mark) => mark.unplaced !== true).length, 8)
  assert.equal(kept.filter((mark) => mark.unplaced === true).length, 8)
})

test('a failed lock metadata write leaves a lock another holder has since taken in place', () => {
  const recordFile = join(tmpDir, 'failed-write.json')
  const lockFile = `${recordFile}.lock`
  const otherHolder = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })
  const nodeFs = createRequire(import.meta.url)('node:fs')
  const realWrite = nodeFs.writeSync
  let held: boolean | null = null
  mock.method(nodeFs, 'writeSync', () => {
    mock.restoreAll()
    syncBuiltinESMExports()
    writeFileSync(lockFile, otherHolder)

    throw new Error('ENOSPC: no space left on device, write')
  })
  syncBuiltinESMExports()
  try {
    withRecordLock(recordFile, (lockHeld) => {
      held = lockHeld
    })
  } finally {
    mock.restoreAll()
    nodeFs.writeSync = realWrite
    syncBuiltinESMExports()
  }

  assert.equal(held, false)
  assert.equal(readFileSync(lockFile, 'utf8'), otherHolder)
})

test('a marks file whose flags are not exactly true reads as malformed', () => {
  mkdirSync(dirname(marksFile()), { recursive: true })
  for (const flags of [{ unplaced: 'false' }, { succeeded: 1 }, { succeeded: false }]) {
    writeFileSync(
      marksFile(),
      JSON.stringify({
        started: [{ promptId: 'prompt-1', at: '2026-01-01T00:00:00.000Z', ...flags }],
      })
    )

    assert.equal(loadTurnMarks(SESSION).damage, 'malformed', JSON.stringify(flags))
  }

  writeFileSync(
    marksFile(),
    JSON.stringify({
      started: [
        { promptId: 'prompt-1', at: '2026-01-01T00:00:00.000Z', succeeded: true, unplaced: true },
      ],
    })
  )

  assert.equal(loadTurnMarks(SESSION).damage, undefined)
})

test('a stored board remedy that is an inherited property name loads as no remedy', () => {
  recordFailedTurn({ error: 'billing_error' }, SESSION, false, () => null)
  const saved = JSON.parse(readFileSync(recordPath(), 'utf8'))
  saved.boardRemedy = 'constructor'
  writeFileSync(recordPath(), JSON.stringify(saved))

  assert.equal(loadFailedTurn(SESSION)?.boardRemedy, null)

  saved.boardRemedy = 'credential'
  writeFileSync(recordPath(), JSON.stringify(saved))

  assert.equal(loadFailedTurn(SESSION)?.boardRemedy, 'credential')
})

const CHILD_SCRIPT = (modulePath: string): string =>
  [
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs'",
    `import { loadFailedTurn, markTurnStarted, postIfNeeded } from ${JSON.stringify(modulePath)}`,
    'const [mode, session, readyFile, goFile, logFile] = process.argv.slice(2)',
    'const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)',
    'const record = loadFailedTurn(session)',
    'writeFileSync(readyFile, "")',
    'while (goFile !== "-" && !existsSync(goFile)) pause(10)',
    "if (mode === 'mark') markTurnStarted(session, new Date(Date.now() + 60000).toISOString())",
    'else postIfNeeded(record, () => {',
    '  pause(300)',
    '  appendFileSync(logFile, `post item-${process.pid}\\n`)',
    '  return `item-${process.pid}`',
    '})',
    '',
  ].join('\n')

const LOCK_TRIALS = 6
const LOCK_WAITERS = 8

const LOCK_WAITER_SCRIPT = (lockModule: string): string =>
  [
    "import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'",
    `import { withRecordLock } from ${JSON.stringify(lockModule)}`,
    'const [recordFile, readyFile, goFile, logFile] = process.argv.slice(2)',
    'const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)',
    'writeFileSync(readyFile, "")',
    'let startAt = Number.NaN',
    'while (Number.isNaN(startAt)) {',
    '  startAt = existsSync(goFile) ? Number.parseInt(readFileSync(goFile, "utf8"), 10) : Number.NaN',
    '  if (Number.isNaN(startAt)) pause(2)',
    '}',
    'while (Date.now() < startAt) {}',
    'withRecordLock(recordFile, (held) => {',
    '  if (!held) {',
    '    appendFileSync(logFile, "unheld\\n")',
    '    return',
    '  }',
    '  const inside = `${logFile}.inside`',
    '  try {',
    '    closeSync(openSync(inside, "wx"))',
    '  } catch {',
    '    appendFileSync(logFile, "overlap\\n")',
    '  }',
    '  appendFileSync(logFile, "held\\n")',
    '  pause(100)',
    '  rmSync(inside, { force: true })',
    '  process.kill(process.pid, "SIGKILL")',
    '})',
    '',
  ].join('\n')

const FORCED_LOCK_SCRIPT = (lockModule: string): string =>
  [
    "import { existsSync, writeFileSync } from 'node:fs'",
    `import { withRecordLock } from ${JSON.stringify(lockModule)}`,
    'const [role, recordFile, heldFile, releaseFile, releasedFile, enteredFile] = process.argv.slice(2)',
    'const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)',
    'withRecordLock(recordFile, () => {',
    '  if (role === "enter") {',
    '    writeFileSync(enteredFile, existsSync(releasedFile) ? "after-release" : "while-held")',
    '    return',
    '  }',
    '  writeFileSync(heldFile, "")',
    '  while (!existsSync(releaseFile)) pause(10)',
    '  writeFileSync(releasedFile, "")',
    '})',
    '',
  ].join('\n')

const spawnForcedLockProcess = (
  role: 'enter' | 'hold',
  recordFile: string,
  files: string[],
  extraEnv: Record<string, string> = {}
): WatchedProcess => {
  const lockModule = fileURLToPath(new URL('./record-lock.ts', import.meta.url))
  const script = writeWorkerScript('forced-lock', FORCED_LOCK_SCRIPT(lockModule))

  const child = track(
    spawn(
      process.execPath,
      ['--experimental-transform-types', script, role, recordFile, ...files],
      {
        env: { ...process.env, HOME: tmpDir, CLAUDE_CONFIG_DIR: tmpDir, ...extraEnv },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    )
  )
  const watched: WatchedProcess = { result: null, exited: Promise.resolve(null as never) }
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  watched.exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      watched.result = { code, signal, stderr }
      resolve(watched.result)
    })
    child.once('error', (error) => {
      watched.result = { code: null, signal: null, stderr: `failed to start: ${error.message}` }
      resolve(watched.result)
    })
  })

  return watched
}

interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

interface WatchedProcess {
  result: ProcessExit | null
  exited: Promise<ProcessExit>
}

const waitForFileUnlessExited = async (path: string, watched: WatchedProcess): Promise<void> => {
  const deadline = Date.now() + WAIT_DEADLINE_MS
  while (!existsSync(path)) {
    if (watched.result !== null) {
      assert.fail(
        `process exited (code ${watched.result.code}, signal ${watched.result.signal}) before ${path} appeared: ${watched.result.stderr}`
      )
    }

    assert.ok(Date.now() < deadline, `${path} did not appear within ${WAIT_DEADLINE_MS}ms`)

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const spawnLockWaiter = (
  recordFile: string,
  readyFile: string,
  goFile: string,
  logFile: string
): ReturnType<typeof spawn> => {
  const lockModule = fileURLToPath(new URL('./record-lock.ts', import.meta.url))
  const script = writeWorkerScript('lock-waiter', LOCK_WAITER_SCRIPT(lockModule))

  return track(
    spawn(
      process.execPath,
      ['--experimental-transform-types', script, recordFile, readyFile, goFile, logFile],
      {
        env: { ...process.env, HOME: tmpDir, CLAUDE_CONFIG_DIR: tmpDir },
        stdio: ['ignore', 'ignore', 'inherit'],
      }
    )
  )
}

const spawnChild = (
  mode: 'mark' | 'post',
  readyFile: string,
  goFile: string,
  logFile: string
): ReturnType<typeof spawn> => {
  const modulePath = fileURLToPath(new URL('./failed-turn.ts', import.meta.url))
  const script = writeWorkerScript(`child-${mode}`, CHILD_SCRIPT(modulePath))

  return track(
    spawn(
      process.execPath,
      ['--experimental-transform-types', script, mode, SESSION, readyFile, goFile, logFile],
      {
        env: { ...process.env, HOME: tmpDir, CLAUDE_CONFIG_DIR: tmpDir },
        stdio: ['ignore', 'ignore', 'inherit'],
      }
    )
  )
}

let workerScriptCount = 0

const writeWorkerScript = (name: string, source: string): string => {
  workerScriptCount += 1
  const script = join(tmpDir, `${name}-${workerScriptCount}.mjs`)
  writeFileSync(script, source)

  return script
}

const waitForFile = async (path: string, workers: ReturnType<typeof spawn>[]): Promise<void> => {
  const deadline = Date.now() + WAIT_DEADLINE_MS
  while (!existsSync(path)) {
    assertStarted(workers)
    const exited = workers.find((worker) => worker.exitCode !== null || worker.signalCode !== null)
    assert.ok(
      exited === undefined,
      `pid ${exited?.pid} exited (code ${exited?.exitCode}, signal ${exited?.signalCode}) before ${path} appeared`
    )
    assert.ok(Date.now() < deadline, `${path} did not appear within ${WAIT_DEADLINE_MS}ms`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('a failed turn of a session that never entered the board does not post through another registered session', () => {
  const stubPath = join(tmpDir, 'board')
  mkdirSync(stubPath)
  const stub = join(stubPath, 'ai-workflow-app')
  writeFileSync(stub, BOARD_STUB)
  chmodSync(stub, 0o755)
  registerBoardNode('other-session', 'node-other')

  const failed = runMailbox(['turn-failed'], JSON.stringify({ error: 'billing_error' }), {
    AI_WORKFLOW_APP_BIN: stub,
    DASHBOARD_INVOKE_TIMEOUT_MS: '60000',
    CLAUDE_CODE_SESSION_ID: 'other-session',
  })

  assert.equal(failed.status, 0, failed.stderr)
  assert.equal(existsSync(join(stubPath, 'calls.log')), false)
  assert.equal(loadFailedTurn(SESSION)?.boardItemId, null)
})
