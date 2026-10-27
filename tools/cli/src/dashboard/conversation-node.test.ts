import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { ensureDurableDir, storePath, sessionGlobalScope } from '../workflow-store/store.ts'
import { getRequestedExitCode } from '../runtime-exit-code.ts'
import { runItemAdd } from './item.ts'

let tmpDir: string
let homeDir: string
let origHome: string | undefined
let origBin: string | undefined
let origSessionId: string | undefined
let sessionId: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'conversation-node-test-'))
  homeDir = mkdtempSync(join(tmpdir(), 'conversation-node-home-'))
  origHome = process.env.HOME
  origBin = process.env.AI_WORKFLOW_APP_BIN
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  process.env.HOME = homeDir
  sessionId = `conversation-node-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
})

afterEach(() => {
  restoreEnv('HOME', origHome)
  restoreEnv('AI_WORKFLOW_APP_BIN', origBin)
  restoreEnv('CLAUDE_CODE_SESSION_ID', origSessionId)
  delete process.env.DASHBOARD_CONVERSATION_LOCK_WAIT_MS
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

const questionDecl = { recommend: 'Ship it', stalls: 'none', whyMine: 'scope' as const }

const captureStderr = (fn: () => void): string => {
  const original = process.stderr.write.bind(process.stderr)
  let out = ''
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    out += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = original
  }
  return out
}

const captureStdout = (fn: () => void): string => {
  const original = process.stdout.write.bind(process.stdout)
  let out = ''
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += String(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    fn()
  } finally {
    process.stdout.write = original
  }
  return out
}

// Answers `session list` with an empty board and registers slowly, so a second process that is not
// serialised behind the first reaches its own `session register` before the first has finished.
const writeSlowRegisterStub = (dir: string): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(
    path,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}\n` +
      `if [ "$1" = "session" ] && [ "$2" = "list" ]; then echo '[]'; exit 0; fi\n` +
      `if [ "$1" = "session" ] && [ "$2" = "register" ]; then\n` +
      `  sleep 0.5\n` +
      `  echo '{"id":"conv-node","parentId":null,"lifecycle":"active"}'; exit 0\n` +
      `fi\n` +
      `echo '{"itemId":"item-1"}'\nexit 0\n`
  )
  chmodSync(path, 0o755)
  return path
}

const readCalls = (dir: string): string[] => {
  const log = join(dir, 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : []
}

const runRaceChild = (
  readyPath: string,
  goPath: string
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        join(import.meta.dirname, 'test', 'conversation-race.child.ts'),
        readyPath,
        goPath,
      ],
      { env: process.env }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

const waitForFiles = async (paths: string[]): Promise<void> => {
  const deadline = Date.now() + 15_000
  while (!paths.every((p) => existsSync(p))) {
    assert.ok(Date.now() < deadline, 'both children reached the barrier')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('two concurrent first posts from one session create exactly one root', async () => {
  process.env.AI_WORKFLOW_APP_BIN = writeSlowRegisterStub(tmpDir)
  const readyPaths = [join(tmpDir, 'ready-a'), join(tmpDir, 'ready-b')]
  const goPath = join(tmpDir, 'go')

  const children = readyPaths.map((ready) => runRaceChild(ready, goPath))
  await waitForFiles(readyPaths)
  writeFileSync(goPath, '')
  const results = await Promise.all(children)

  for (const result of results) {
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { itemId: 'item-1' })
  }
  const calls = readCalls(tmpDir)
  assert.equal(calls.filter((c) => c.startsWith('session register')).length, 1)
  assert.equal(calls.filter((c) => c.startsWith('item add --session conv-node')).length, 2)
})

test('a live holder past the wait bound makes the post refuse, with no board node and no post', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeSlowRegisterStub(tmpDir)
  process.env.DASHBOARD_CONVERSATION_LOCK_WAIT_MS = '300'
  const lockFile = storePath(sessionGlobalScope(sessionId), 'conversation-node.lock')
  ensureDurableDir(dirname(lockFile))
  const now = new Date().toISOString()
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: now, heartbeatAt: now }), {
    mode: 0o600,
  })

  const stderr = captureStderr(() => {
    const out = captureStdout(() => runItemAdd('question', 'Q?', questionDecl))
    assert.equal(out, '')
  })

  assert.match(stderr, /another `item add` in this session is still opening its board node/)
  assert.equal(getRequestedExitCode(), 1)
  assert.deepEqual(readCalls(tmpDir), [])
  assert.equal(existsSync(lockFile), true, 'the live holder keeps its lock')
})

test('a blank wait override waits the default for a live holder instead of refusing at once', async () => {
  process.env.AI_WORKFLOW_APP_BIN = writeSlowRegisterStub(tmpDir)
  process.env.DASHBOARD_CONVERSATION_LOCK_WAIT_MS = ''
  const lockFile = storePath(sessionGlobalScope(sessionId), 'conversation-node.lock')
  ensureDurableDir(dirname(lockFile))
  // A separate live process takes the lock, then lets go of it after 600 ms.
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const fs = require('fs'); const now = new Date().toISOString();
       fs.writeFileSync(${JSON.stringify(lockFile)}, JSON.stringify({ pid: process.pid, startedAt: now, heartbeatAt: now }));
       setTimeout(() => fs.rmSync(${JSON.stringify(lockFile)}, { force: true }), 600);`,
    ],
    { stdio: 'ignore' }
  )
  await waitForFiles([lockFile])

  const out = captureStdout(() => runItemAdd('question', 'Q?', questionDecl))

  assert.deepEqual(JSON.parse(out), { itemId: 'item-1' })
  holder.kill()
})

test('a lock left by a dead holder is reclaimed at once, not waited out', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeSlowRegisterStub(tmpDir)
  const lockFile = storePath(sessionGlobalScope(sessionId), 'conversation-node.lock')
  ensureDurableDir(dirname(lockFile))
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid
  const now = new Date().toISOString()
  writeFileSync(lockFile, JSON.stringify({ pid: deadPid, startedAt: now, heartbeatAt: now }), {
    mode: 0o600,
  })

  const startedAt = Date.now()
  const out = captureStdout(() => runItemAdd('question', 'Q?', questionDecl))

  assert.deepEqual(JSON.parse(out), { itemId: 'item-1' })
  assert.ok(Date.now() - startedAt < 10_000, 'did not wait out the lock wait bound')
  assert.equal(existsSync(lockFile), false, 'the lock is released afterwards')
})
