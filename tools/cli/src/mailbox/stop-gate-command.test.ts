import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveState as saveDashboardState } from '../dashboard/state.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

const SESSION = 'stop-gate-command-session'
const MAILBOX_TIMEOUT_MS = 120_000

let tmpDir: string
let origHome: string | undefined
let origSessionId: string | undefined

// The session id is set here too: dashboard state is stored under the ambient
// CLAUDE_CODE_SESSION_ID, so the planted node must be written under the id the command runs with.
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stop-gate-command-test-'))
  origHome = process.env.HOME
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  process.env.HOME = tmpDir
  process.env.CLAUDE_CODE_SESSION_ID = SESSION
})

afterEach(() => {
  restoreEnv('HOME', origHome)
  restoreEnv('CLAUDE_CODE_SESSION_ID', origSessionId)
  rmSync(tmpDir, { recursive: true, force: true })
})

test('stop-gate command: --payload-stdin hands the Stop payload on stdin to the gate', () => {
  saveDashboardState(SESSION, { registered: true, phase: 'review', openItemIds: [] })
  const env = { AI_WORKFLOW_APP_BIN: writeLiveBoardStub() }
  const payload = JSON.stringify({ background_tasks: [{ type: 'shell', command: 'sleep 100' }] })

  const withFlag = runStopGateCommand(['--payload-stdin'], payload, env)
  const withoutFlag = runStopGateCommand([], payload, env)

  assert.equal(withFlag.status, 0, withFlag.stderr)
  assert.equal(withFlag.stdout, 'allow\n')
  assert.equal(withoutFlag.status, 0, withoutFlag.stderr)
  assert.equal(withoutFlag.stdout.split('\n')[0], 'block')
})

const runStopGateCommand = (
  flags: string[],
  input: string,
  extraEnv: NodeJS.ProcessEnv
): { stdout: string; stderr: string; status: number | null } => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: tmpDir,
    DASHBOARD_INVOKE_TIMEOUT_MS: '60000',
  }
  delete env.CLAUDE_PLUGIN_ROOT
  Object.assign(env, extraEnv)

  const result = spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      mainTsPath,
      'mailbox',
      'stop-gate',
      '--session',
      SESSION,
      ...flags,
    ],
    { encoding: 'utf8', env, input, timeout: MAILBOX_TIMEOUT_MS }
  )

  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

// A stub ai-workflow-app that lists this session's node as active, so the gate answers for it.
const writeLiveBoardStub = (): string => {
  const rows = [
    {
      session: {
        id: SESSION,
        systemId: 'claude-workflow',
        externalId: SESSION,
        title: SESSION,
        phase: 'review',
        lifecycle: 'active',
        parentId: null,
      },
      status: 'ok',
      openItemCount: 0,
    },
  ]
  const path = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `if echo "$@" | grep -q 'session list'; then`,
      `  echo ${JSON.stringify(JSON.stringify(rows))}`,
      'else',
      `  echo '{}'`,
      'fi',
      '',
    ].join('\n')
  )
  chmodSync(path, 0o755)
  return path
}

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
