import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

const MISSING_REASON = 'no slice capture under this task on a commit between origin/main and --sha'
const OUT_OF_ORDER_REASON =
  "this slice's capture is not on a commit after the previous slice's capture"

const DIGEST_CONFLICT_REASON =
  'output sidecar digest 2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df is shared by 2 captures at this (task, sha) asserting conflicting exit statuses (0, 1) — at most one can be true of one fixed output'

let ticket: string
let homeDir: string
let repoRoot: string

beforeEach(() => {
  const uniqueId = `${Date.now()}-${Math.random()}`.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  ticket = `test-proof-ledger-slices-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'proof-ledger-slices-home-'))
  repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-slices-repo-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  commit('baseline')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(repoRoot, { recursive: true, force: true })
})

test('check --slices reads each slice ok in plan order, and names a missing or out-of-order one', () => {
  const now = Math.floor(Date.now() / 1000)
  const first = commit('slice-1')
  const firstId = recordSlice('slice-1', first)
  const second = commit('slice-2', now + 3600)
  const secondId = recordSlice('slice-2', second)
  const ok1 = { task: 'slice-1', captureId: firstId, captureSha: first, state: 'ok' }
  const ok2 = { task: 'slice-2', captureId: secondId, captureSha: second, state: 'ok' }

  assert.deepEqual(checkSlices(second, 'slice-1,slice-2'), expected(0, second, [ok1, ok2]))
  assert.deepEqual(
    checkSlices(second, 'slice-1,slice-2,slice-3'),
    expected(3, second, [ok1, ok2, { task: 'slice-3', state: 'missing', reason: MISSING_REASON }])
  )
  assert.deepEqual(
    checkSlices(second, 'slice-2,slice-1'),
    expected(3, second, [ok2, { ...ok1, state: 'out-of-order', reason: OUT_OF_ORDER_REASON }])
  )
})

test('check --slices reads a slice late when its check was recorded after the next slice began', () => {
  const now = Math.floor(Date.now() / 1000)
  const first = commit('slice-1')
  const second = commit('slice-2', now - 3600)
  git('checkout', '-q', first)
  const firstId = recordSlice('slice-1', first)
  git('checkout', '-q', 'main')
  const secondId = recordSlice('slice-2', second)

  assert.deepEqual(
    checkSlices(second, 'slice-1,slice-2'),
    expected(3, second, [
      {
        task: 'slice-1',
        captureId: firstId,
        captureSha: first,
        state: 'late',
        reason:
          `recorded at ${capturedAt(firstId)}, after ${second}, the next commit, was made at ` +
          new Date((now - 3600) * 1000).toISOString(),
      },
      { task: 'slice-2', captureId: secondId, captureSha: second, state: 'ok' },
    ])
  )
})

test('check --slices reads a slice failing when its output digest conflicts with another capture at the same task and sha', () => {
  const first = commit('slice-1')
  const firstId = recordSlice('slice-1', first)
  recordConflictingSweep('slice-1', first)

  assert.deepEqual(
    checkSlices(first, 'slice-1'),
    expected(3, first, [
      {
        task: 'slice-1',
        captureId: firstId,
        captureSha: first,
        state: 'failing',
        reason: DIGEST_CONFLICT_REASON,
      },
    ])
  )
})

test('check --slices reads a slice failing, naming the invalid capture, even when a later capture of it is valid', () => {
  const first = commit('slice-1')
  const invalidId = recordSlice('slice-1', first)
  recordConflictingSweep('slice-1', first)
  const second = commit('slice-1-again')
  recordSlice('slice-1', second)

  assert.deepEqual(
    checkSlices(second, 'slice-1'),
    expected(3, second, [
      {
        task: 'slice-1',
        captureId: invalidId,
        captureSha: first,
        state: 'failing',
        reason: DIGEST_CONFLICT_REASON,
      },
    ])
  )
})

test('check refuses --slices alongside a task coverage flag rather than ignoring either', () => {
  const result = runCli([
    'proof-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    git('rev-parse', 'HEAD'),
    '--slices',
    'slice-1',
    '--task',
    'slice-1',
    '--repo-root',
    repoRoot,
  ])
  assert.equal(result.status, 6)
  assert.equal(
    result.stdout,
    JSON.stringify({
      error:
        "--slices checks a plan's slice order and takes no --task, --require or --expect-command: run a task's coverage check as its own call",
    }) + '\n'
  )
  assert.equal(result.stderr, '')

  const repoRootOnly = runCli([
    'proof-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    git('rev-parse', 'HEAD'),
    '--task',
    'slice-1',
    '--require',
    'slice',
    '--repo-root',
    repoRoot,
  ])
  assert.equal(repoRootOnly.status, 6)
  assert.equal(
    repoRootOnly.stdout,
    JSON.stringify({
      error: "--repo-root is read only by --slices: a task's coverage check reads the ledger alone",
    }) + '\n'
  )
  assert.equal(repoRootOnly.stderr, '')
})

test('check --slices refuses with exit 6 when origin/main does not resolve, though --sha is a real commit', () => {
  const first = commit('slice-1')
  git('update-ref', '-d', 'refs/remotes/origin/main')

  assert.deepEqual(checkSlices(first, 'slice-1'), {
    status: 6,
    stdout:
      JSON.stringify({
        error:
          `origin/main..${first} does not resolve in ${repoRoot}: --sha must name a commit there and ` +
          'origin/main must exist — pass --repo-root pointing at the repo the branch belongs to',
      }) + '\n',
    stderr: '',
  })
})

test('check --slices exits 4 and reports corrupted for a skipped ledger line, though the slices alone would exit 3', () => {
  const first = commit('slice-1')
  const firstId = recordSlice('slice-1', first)
  const rows = [
    { task: 'slice-1', captureId: firstId, captureSha: first, state: 'ok' },
    { task: 'slice-2', state: 'missing', reason: MISSING_REASON },
  ]

  assert.deepEqual(checkSlices(first, 'slice-1,slice-2'), expected(3, first, rows))

  appendFileSync(
    join(homeDir, '.claude', 'workflow-state', 'tickets', ticket, 'proof-ledger.jsonl'),
    '{"kind":"proof-capture","task":"slice-1"\n'
  )

  assert.deepEqual(checkSlices(first, 'slice-1,slice-2'), {
    status: 4,
    stdout:
      JSON.stringify({ ticket, sha: first, slices: rows, skippedLines: 1, corrupted: true }) + '\n',
    stderr: '',
  })
})

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()

// One commit on the branch, its committer time set to `committedAt` (unix seconds) when given, so a
// test places a commit before or after a capture's recorded time without waiting on the clock.
const commit = (name: string, committedAt?: number): string => {
  writeFileSync(join(repoRoot, `${name}.txt`), `${name}\n`)
  git('add', `${name}.txt`)
  execFileSync('git', ['commit', '-q', '-m', name], {
    cwd: repoRoot,
    stdio: 'pipe',
    env: {
      ...process.env,
      ...(committedAt !== undefined ? { GIT_COMMITTER_DATE: `@${committedAt} +0000` } : {}),
    },
  })
  return git('rev-parse', 'HEAD')
}

// Records a slice capture through the real CLI and returns the id `record` printed for it.
const recordSlice = (task: string, sha: string): string => {
  const result = runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    task,
    '--capture',
    'slice',
    '--sha',
    sha,
    '--command',
    'echo ok',
    '--exit',
    '0',
    '--output',
    'ok',
    '--repo-root',
    repoRoot,
  ])
  assert.equal(
    result.status,
    0,
    `record ${task}; stdout: ${result.stdout} stderr: ${result.stderr}`
  )
  return (JSON.parse(result.stdout) as { id: string }).id
}

const capturedAt = (id: string): string => {
  const shown = JSON.parse(
    runCli(['proof-ledger', 'show', '--ticket', ticket, '--capture', 'slice']).stdout
  ) as { captures: { id: string; at: string }[] }
  const found = shown.captures.find((c) => c.id === id)
  assert.notEqual(found, undefined, `capture ${id} is in the ledger`)
  return found!.at
}

// A sweep that reports exit 1 for the same output a slice capture reported exit 0 for: one fixed
// output cannot be true of both exit statuses, so both captures read invalid.
const recordConflictingSweep = (task: string, sha: string): void => {
  const result = runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    task,
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn x .',
    '--exit',
    '1',
    '--output',
    'ok',
    '--sha-is-label',
    '--repo-root',
    repoRoot,
  ])
  assert.equal(result.status, 0, `record the conflicting sweep; stdout: ${result.stdout}`)
}

// The exact bytes `check --slices` prints for these rows: the whole stdout, newline included.
const expected = (
  status: number,
  sha: string,
  slices: unknown[]
): { status: number; stdout: string; stderr: string } => ({
  status,
  stdout: JSON.stringify({ ticket, sha, slices, skippedLines: 0 }) + '\n',
  stderr: '',
})

const checkSlices = (
  sha: string,
  slices: string
): { status: number | null; stdout: string; stderr: string } => {
  const result = runCli([
    'proof-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    sha,
    '--slices',
    slices,
    '--repo-root',
    repoRoot,
  ])
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const runCli = (args: string[]): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, ...args],
    { encoding: 'utf8', env: { ...process.env, HOME: homeDir, NODE_NO_WARNINGS: '1' } }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}
