import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runHeartbeat, runPause, runResume } from './lifecycle.ts'
import { loadRegistry, upsertRegistryNode } from './registry.ts'
import { getRequestedExitCode, setRequestedExitCode } from '../runtime-exit-code.ts'

// The store is homedir()-relative and the binary resolves through AI_WORKFLOW_APP_BIN, so both
// point into per-test temp dirs and the real board is never reached (mirrors dashboard.test.ts).
let tmpDir: string
let homeDir: string
let rawId: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['AI_WORKFLOW_APP_BIN', 'CLAUDE_CODE_SESSION_ID', 'HOME'] as const

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
  }

  tmpDir = mkdtempSync(join(tmpdir(), 'pause-test-'))
  homeDir = mkdtempSync(join(tmpdir(), 'pause-test-home-'))
  process.env.HOME = homeDir
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'no-such-ai-workflow-app')
  rawId = `pause-session-${Math.floor(Math.random() * 1e9)}`
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

test('heartbeat after pause sends no board heartbeat for the paused leaf', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub('paused', 0)

  runPause()
  runHeartbeat()

  const calls = readCalls()
  assert.ok(calls.includes('session pause --id leaf-1'), 'pause reaches the board')
  assert.equal(leaf().paused, true, 'the leaf is marked')
  assert.deepEqual(
    calls,
    ['session pause --id leaf-1', 'session list'],
    'the heartbeat read the board before deciding to skip'
  )
  assert.equal(getRequestedExitCode(), 0, 'skipping is not a failure')
  assert.deepEqual(
    calls.filter((c) => c.startsWith('session heartbeat')),
    [],
    'the heartbeat after the pause does not resume the node'
  )
})

test('resume clears the mark and beats the node instead of calling session resume', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub('paused', 0)
  runPause()

  runResume()

  const calls = readCalls()
  assert.equal(leaf().paused, undefined, 'the mark is gone')
  assert.ok(calls.includes('session heartbeat --id leaf-1'), 'resume beats the node')
  assert.ok(!calls.some((c) => c.startsWith('session resume')), 'never calls session resume')
})

test('a pause the board refuses leaves the leaf unmarked and fails loudly', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub('paused', 1)

  const stderr = captureStderr(() => runPause())

  assert.equal(leaf().paused, undefined, 'no mark without a board pause')
  assert.equal(getRequestedExitCode(), 1, 'the caller sees the board’s exit code')
  assert.equal(
    stderr,
    'dashboard: ai-workflow-app session pause --id leaf-1 failed: exit 1\n',
    'the refusal names the call that failed'
  )
})

test('pause with no board is a silent no-op', () => {
  const stderr = captureStderr(() => runPause())

  assert.equal(stderr, '')
  assert.equal(leaf().paused, undefined)
  assert.ok(!existsSync(join(tmpDir, 'calls.log')), 'nothing was invoked')
})

const leaf = () => loadRegistry(rawId).find((n) => n.internalId === 'leaf-1')!

// Records argv, answers `session list` with this test's leaf in `lifecycle`, and exits
// `exitCode` on every call that is not `session list`.
const writeBoardStub = (lifecycle: string, exitCode: number): string => {
  const path = join(tmpDir, 'ai-workflow-app')
  const rows = JSON.stringify([
    {
      session: {
        id: 'leaf-1',
        systemId: 'claude-workflow',
        externalId: `${rawId}_0123abcd`,
        lifecycle,
        parentId: null,
      },
    },
  ])
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$@" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}`,
      'if [ "$1 $2" = "session list" ]; then',
      `  printf '%s\\n' ${JSON.stringify(rows)}`,
      '  exit 0',
      'fi',
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
