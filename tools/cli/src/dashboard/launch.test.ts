import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The stubs stand in for `ai-workflow-app` and macOS `open`, and are the only programs these tests
// ever run in their place: the real `open` is never reachable because the stub directory leads PATH,
// and the app is selected through AI_WORKFLOW_APP_BIN.

const mainTsPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts')
const CLI_TIMEOUT_MS = 60_000
const SESSION_ID = 'sess-1234'
const HANG_SLEEP_SECONDS = '59.913'
const IGNORE_TERM_SLEEP_SECONDS = '29.917'
const LINK_URL = 'agent-session://launch?cwd=%2Ftmp%2Fwork&sig=abc123'

let tmpDir: string
let homeDir: string
let stubDir: string

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'launch-test-')))
  homeDir = join(tmpDir, 'home')
  stubDir = join(tmpDir, 'bin')
  mkdirSync(homeDir)
  mkdirSync(stubDir)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

interface AppStub {
  stdout?: string
  stderr?: string
  exitCode?: number
}

const argvFile = (name: string): string => join(tmpDir, `${name}.argv`)
const cwdFile = (name: string): string => join(tmpDir, `${name}.cwd`)

const writeExecutable = (path: string, body: string): string => {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}`)
  chmodSync(path, 0o755)
  return path
}

const writeAppStub = (stub: AppStub): string => {
  writeFileSync(join(tmpDir, 'app.stdout'), stub.stdout ?? '')
  writeFileSync(join(tmpDir, 'app.stderr'), stub.stderr ?? '')
  return writeExecutable(
    join(tmpDir, 'ai-workflow-app'),
    `printf '%s\\n' "$@" > ${JSON.stringify(argvFile('app'))}\n` +
      `pwd -P > ${JSON.stringify(cwdFile('app'))}\n` +
      `cat ${JSON.stringify(join(tmpDir, 'app.stdout'))}\n` +
      `cat ${JSON.stringify(join(tmpDir, 'app.stderr'))} >&2\n` +
      `exit ${String(stub.exitCode ?? 0)}\n`
  )
}

const writeOpenStub = (
  opts: {
    fail?: boolean
    hang?: boolean
    ignoreTerm?: boolean
    flood?: boolean
  } = {}
): void => {
  const ending =
    opts.flood === true
      ? `head -c 2097152 /dev/zero | tr '\\0' x\nexit 0\n`
      : opts.ignoreTerm === true
        ? `trap '' TERM\nexec sleep ${IGNORE_TERM_SLEEP_SECONDS}\n`
        : opts.hang === true
          ? `exec sleep ${HANG_SLEEP_SECONDS}\n`
          : opts.fail === true
            ? `printf '%s\\n' "$1" >&2\nexit 1\n`
            : `exit 0\n`
  writeExecutable(
    join(stubDir, 'open'),
    `printf '%s\\n' "$@" > ${JSON.stringify(argvFile('open'))}\n${ending}`
  )
}

const goodLink = JSON.stringify({ url: LINK_URL, sessionId: SESSION_ID }) + '\n'

const runLaunch = (
  appBin: string,
  flags: string[],
  cwd: string = tmpDir,
  extraEnv: NodeJS.ProcessEnv = {}
): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, 'dashboard', 'session', 'launch', ...flags],
    {
      encoding: 'utf8',
      cwd,
      timeout: CLI_TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
        AI_WORKFLOW_APP_BIN: appBin,
        CLAUDE_CODE_SESSION_ID: 'launch-test-session',
        DASHBOARD_INVOKE_TIMEOUT_MS: '30000',
        ...extraEnv,
      },
    }
  )
  return {
    stdout: result.stdout,
    stderr: withoutNodeWarnings(result.stderr),
    status: result.status,
  }
}

const withoutNodeWarnings = (stderr: string): string =>
  stderr
    .split('\n')
    .filter((line) => !/^\(node:\d+\) \w*Warning: /.test(line))
    .filter((line) => !line.startsWith('(Use `node --trace-warnings'))
    .join('\n')

const REFUSAL_PREFIX = 'dashboard: session launch started nothing: '

const baseFlags = (promptFile: string): string[] => [
  '--directory',
  '/tmp/work',
  '--title',
  'Renovate sweep',
  '--prompt-file',
  promptFile,
]

const readLines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter(Boolean)

test('launch hands the app a launch-link request and open exactly the link, printing only the session id', () => {
  writeOpenStub()
  const promptFile = join(tmpDir, 'prompt.txt')
  writeFileSync(promptFile, 'do the thing')
  const app = writeAppStub({ stdout: goodLink })

  const { stdout, stderr, status } = runLaunch(app, baseFlags(promptFile))

  assert.equal(status, 0)
  assert.equal(stderr, '')
  assert.deepEqual(readLines(argvFile('app')), [
    'launch-link',
    '--directory=/tmp/work',
    '--title=Renovate sweep',
    `--prompt-file=${promptFile}`,
  ])
  assert.equal(readLines(cwdFile('app'))[0], realpathSync(homeDir), 'the app runs from home')
  assert.deepEqual(readLines(argvFile('open')), [LINK_URL])
  assert.equal(stdout, `{"sessionId":"${SESSION_ID}"}\n`)
})

test('launch resolves a relative prompt file against the caller directory', () => {
  writeOpenStub()
  const callerDir = join(tmpDir, 'caller')
  mkdirSync(callerDir)
  writeFileSync(join(callerDir, 'prompt.txt'), 'do the thing')
  const app = writeAppStub({ stdout: goodLink })

  const { stdout, stderr, status } = runLaunch(app, baseFlags('prompt.txt'), callerDir)

  assert.equal(status, 0)
  assert.equal(stdout, `{"sessionId":"${SESSION_ID}"}\n`)
  assert.equal(stderr, '')
  assert.ok(
    readLines(argvFile('app')).includes(`--prompt-file=${resolve(callerDir, 'prompt.txt')}`),
    'the app received the absolute path'
  )
})

test('launch hands the app a prompt path with no component collapsed, even through a symlink', () => {
  writeOpenStub()
  const work = join(tmpDir, 'work')
  const child = join(tmpDir, 'other', 'child')
  mkdirSync(work)
  mkdirSync(child, { recursive: true })
  symlinkSync(child, join(work, 'alias'))
  writeFileSync(join(work, 'prompt.txt'), 'decoy')
  writeFileSync(join(tmpDir, 'other', 'prompt.txt'), 'approved')
  const viaSymlink = `${work}/alias/../prompt.txt`

  const relative = runLaunch(
    writeAppStub({ stdout: goodLink }),
    baseFlags('alias/../prompt.txt'),
    work
  )
  const relativeArg = readLines(argvFile('app')).find((line) => line.startsWith('--prompt-file='))

  assert.equal(relative.status, 0)
  assert.equal(relative.stdout, `{"sessionId":"${SESSION_ID}"}\n`)
  assert.equal(relative.stderr, '')
  assert.equal(relativeArg, `--prompt-file=${viaSymlink}`)
  assert.equal(readFileSync(viaSymlink, 'utf8'), 'approved')

  const absolute = runLaunch(writeAppStub({ stdout: goodLink }), baseFlags(viaSymlink), work)
  const absoluteArg = readLines(argvFile('app')).find((line) => line.startsWith('--prompt-file='))

  assert.equal(absolute.status, 0)
  assert.equal(absolute.stdout, `{"sessionId":"${SESSION_ID}"}\n`)
  assert.equal(absolute.stderr, '')
  assert.equal(absoluteArg, `--prompt-file=${viaSymlink}`)
})

test('launch refusal from the app is reported and open never runs', () => {
  writeOpenStub()
  const app = writeAppStub({
    stderr: 'The directory is not an existing absolute path.',
    exitCode: 1,
  })

  const { stdout, stderr, status } = runLaunch(app, baseFlags('prompt.txt'))

  assert.equal(status, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, `${REFUSAL_PREFIX}The directory is not an existing absolute path.\n`)
  assert.equal(existsSync(argvFile('open')), false, 'open never ran')
})

test('launch with no app binary exits 3 and open never runs', () => {
  writeOpenStub()

  const { stdout, stderr, status } = runLaunch(join(tmpDir, 'missing-app'), baseFlags('p.txt'))

  assert.equal(status, 3)
  assert.equal(stdout, '')
  assert.equal(stderr, `${REFUSAL_PREFIX}the board app is not available\n`)
  assert.equal(existsSync(argvFile('open')), false, 'open never ran')
})

test('launch against an app without the verb fails and open never runs', () => {
  writeOpenStub()
  const app = writeAppStub({ stderr: "error: unknown command 'launch-link'", exitCode: 2 })

  const { stdout, stderr, status } = runLaunch(app, baseFlags('p.txt'))

  assert.equal(status, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, `${REFUSAL_PREFIX}error: unknown command 'launch-link'\n`)
  assert.equal(existsSync(argvFile('open')), false, 'open never ran')
})

test('launch refuses malformed output and a foreign scheme without running open', () => {
  writeOpenStub()
  const malformed = runLaunch(writeAppStub({ stdout: 'not json' }), baseFlags('p.txt'))
  assert.equal(malformed.status, 1)
  assert.equal(malformed.stdout, '')
  assert.equal(
    malformed.stderr,
    `${REFUSAL_PREFIX}the board app returned an unreadable launch link\n`
  )
  assert.equal(existsSync(argvFile('open')), false, 'open never ran for malformed output')

  const foreign = runLaunch(
    writeAppStub({ stdout: JSON.stringify({ url: 'https://example.com/x', sessionId: 's' }) }),
    baseFlags('p.txt')
  )
  assert.equal(foreign.status, 1)
  assert.equal(foreign.stdout, '')
  assert.equal(
    foreign.stderr,
    `${REFUSAL_PREFIX}the board app returned an unreadable launch link\n`
  )
  assert.equal(existsSync(argvFile('open')), false, 'open never ran for a foreign scheme')
})

test('launch keeps the link out of both streams when open fails', () => {
  writeOpenStub({ fail: true })
  const app = writeAppStub({ stdout: goodLink })

  const { stdout, stderr, status } = runLaunch(app, baseFlags('p.txt'))

  assert.equal(status, 1)
  assert.deepEqual(readLines(argvFile('open')), [LINK_URL], 'open did receive the link')
  assert.equal(stdout, '')
  assert.equal(
    stderr,
    `${REFUSAL_PREFIX}open could not hand the link to the Agent Session handler (exit 1)\n`
  )
})

test('launch reports an unknown outcome, never a refusal, when open hangs after receiving the link', () => {
  writeOpenStub({ hang: true })
  const app = writeAppStub({ stdout: goodLink })

  const { stdout, stderr, status } = runLaunch(app, baseFlags('p.txt'), tmpDir, {
    DASHBOARD_OPEN_TIMEOUT_MS: '3000',
  })

  assert.equal(status, 1)
  assert.deepEqual(readLines(argvFile('open')), [LINK_URL], 'open did receive the link')
  assert.equal(stdout, '')
  assert.equal(
    stderr,
    'dashboard: session launch outcome unknown: open did not finish (SIGKILL). The link may ' +
      'have reached the Agent Session handler, so a session may have started; check the board ' +
      'before running this command again\n'
  )
})

test('launch returns promptly with an unknown outcome when open ignores TERM', () => {
  writeOpenStub({ ignoreTerm: true })
  const app = writeAppStub({ stdout: goodLink })

  const startedAt = Date.now()
  const { stdout, stderr, status } = runLaunch(app, baseFlags('p.txt'), tmpDir, {
    DASHBOARD_OPEN_TIMEOUT_MS: '1000',
  })
  const elapsedMs = Date.now() - startedAt

  assert.ok(
    elapsedMs < 15_000,
    `launch waited ${String(elapsedMs)} ms for an open that ignores TERM`
  )
  assert.equal(status, 1)
  assert.deepEqual(readLines(argvFile('open')), [LINK_URL], 'open did receive the link')
  assert.equal(stdout, '')
  assert.equal(
    stderr,
    'dashboard: session launch outcome unknown: open did not finish (SIGKILL). The link may ' +
      'have reached the Agent Session handler, so a session may have started; check the board ' +
      'before running this command again\n'
  )
})

test('launch passes a directory and prompt path with surrounding whitespace to the app unchanged', () => {
  writeOpenStub()
  const app = writeAppStub({ stdout: goodLink })

  const { stdout, stderr, status } = runLaunch(app, [
    '--directory',
    ' /tmp/work ',
    '--title',
    'Renovate sweep',
    '--prompt-file',
    ' p.txt ',
  ])

  assert.equal(status, 0)
  assert.equal(stdout, `{"sessionId":"${SESSION_ID}"}\n`)
  assert.equal(stderr, '')
  assert.deepEqual(readLines(argvFile('app')), [
    'launch-link',
    '--directory= /tmp/work ',
    '--title=Renovate sweep',
    `--prompt-file=${resolve(tmpDir, ' p.txt ')}`,
  ])
})

test('launch runs open without throwing for a DASHBOARD_OPEN_TIMEOUT_MS that is not a positive integer', () => {
  writeOpenStub()

  for (const value of ['-1', '0', '1.5']) {
    const app = writeAppStub({ stdout: goodLink })

    const { stdout, stderr, status } = runLaunch(app, baseFlags('p.txt'), tmpDir, {
      DASHBOARD_OPEN_TIMEOUT_MS: value,
    })

    assert.equal(status, 0, `DASHBOARD_OPEN_TIMEOUT_MS=${value}`)
    assert.equal(stdout, `{"sessionId":"${SESSION_ID}"}\n`, `DASHBOARD_OPEN_TIMEOUT_MS=${value}`)
    assert.equal(stderr, '', `DASHBOARD_OPEN_TIMEOUT_MS=${value}`)
  }
})

test('launch still bounds a hung open when DASHBOARD_OPEN_TIMEOUT_MS is zero', () => {
  writeOpenStub({ hang: true })
  const app = writeAppStub({ stdout: goodLink })

  const startedAt = Date.now()
  const { stdout, stderr, status } = runLaunch(app, baseFlags('p.txt'), tmpDir, {
    DASHBOARD_OPEN_TIMEOUT_MS: '0',
  })
  const elapsedMs = Date.now() - startedAt

  assert.ok(
    elapsedMs < 30_000,
    `launch waited ${String(elapsedMs)} ms for a hung open with DASHBOARD_OPEN_TIMEOUT_MS=0`
  )
  assert.equal(status, 1)
  assert.deepEqual(readLines(argvFile('open')), [LINK_URL], 'open did receive the link')
  assert.equal(stdout, '')
  assert.equal(
    stderr,
    'dashboard: session launch outcome unknown: open did not finish (SIGKILL). The link may ' +
      'have reached the Agent Session handler, so a session may have started; check the board ' +
      'before running this command again\n'
  )
})

test('launch succeeds when open writes more than a buffer of output', () => {
  writeOpenStub({ flood: true })
  const app = writeAppStub({ stdout: goodLink })

  const { stdout, stderr, status } = runLaunch(app, baseFlags('p.txt'))

  assert.equal(status, 0)
  assert.deepEqual(readLines(argvFile('open')), [LINK_URL], 'open did receive the link')
  assert.equal(stdout, `{"sessionId":"${SESSION_ID}"}\n`)
  assert.equal(stderr, '')
})
