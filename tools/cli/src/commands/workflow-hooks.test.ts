import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOMENT_IDS } from '../workflow-hooks/moments.ts'

const binPath = fileURLToPath(new URL('../../../../bin/workflow-hooks', import.meta.url))

type Fixture = {
  repo: string
  worktree: string
  configDir: string
  log: string
  cleanup: () => void
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
}

// A main checkout with one linked worktree. Project hook files go in the main checkout's .claude/
// only — the worktree never has them, which is the case the main-checkout rule exists for.
const makeFixture = (): Fixture => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-hooks-test-')))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'file.txt'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'worktree', 'add', '-q', '.worktrees/FLOW-1-story', '-b', 'FLOW-1-story')
  mkdirSync(join(repo, '.claude'))
  const configDir = join(root, 'config')
  mkdirSync(configDir)
  return {
    repo,
    worktree: join(repo, '.worktrees', 'FLOW-1-story'),
    configDir,
    log: join(root, 'log.txt'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, JSON.stringify(value, null, 2))
}

const userFile = (fixture: Fixture): string => join(fixture.configDir, 'workflow-hooks.json')
const projectFile = (fixture: Fixture): string =>
  join(fixture.repo, '.claude', 'workflow-hooks.json')
const localFile = (fixture: Fixture): string =>
  join(fixture.repo, '.claude', 'workflow-hooks.local.json')

const runHooks = (
  args: string[],
  cwd: string,
  configDir: string,
  extraEnv: Record<string, string> = {}
): { json: unknown; status: number | null; stderr: string } => {
  const result = spawnSync(binPath, args, {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...extraEnv, CLAUDE_CONFIG_DIR: configDir },
  })
  return { json: JSON.parse(result.stdout), status: result.status, stderr: result.stderr }
}

// The progress lines `run` writes to stderr, with the elapsed time replaced so they can be compared.
const progressLines = (stderr: string): string[] =>
  stderr
    .split('\n')
    .filter((line) => line.startsWith('✓ ') || line.startsWith('✗ '))
    .map((line) => line.replace(/ in \d+ms/, ' in <n>ms'))

const isGone = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const withoutDuration = (ran: unknown): unknown =>
  (ran as Array<Record<string, unknown>>).map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'durationMs'))
  )

test('workflow-hooks run with no steps for the moment prints an empty result and exits 0', () => {
  const fixture = makeFixture()
  try {
    const empty = { moment: 'tests.before', ran: [], instructions: [] }

    const noFiles = runHooks(
      ['run', '--moment', 'tests.before'],
      fixture.worktree,
      fixture.configDir
    )
    assert.deepEqual({ json: noFiles.json, status: noFiles.status }, { json: empty, status: 0 })

    writeJson(userFile(fixture), { version: 1, hooks: {} })
    const fileWithoutSteps = runHooks(
      ['run', '--moment', 'tests.before'],
      fixture.worktree,
      fixture.configDir
    )
    assert.deepEqual(
      { json: fileWithoutSteps.json, status: fileWithoutSteps.status },
      { json: empty, status: 0 }
    )
  } finally {
    fixture.cleanup()
  }
})

test('workflow-hooks run runs user, shared and private steps from the main checkout in order', () => {
  const fixture = makeFixture()
  try {
    writeJson(userFile(fixture), {
      version: 1,
      hooks: {
        'work-start.after': [
          {
            name: 'user-a',
            run: `printf 'user-a %s %s %s %s %s\\n' "$WORKFLOW_MOMENT" "$WORKFLOW_TICKET" "$WORKFLOW_BRANCH" "\${WORKFLOW_PR_URL-unset}" "$(pwd)" >> "${fixture.log}"`,
          },
          { name: 'user-b', run: `echo user-b >> "${fixture.log}"` },
        ],
      },
    })
    writeJson(projectFile(fixture), {
      version: 1,
      disable: ['user-b'],
      hooks: {
        'work-start.after': [
          {
            name: 'shared',
            run: `printf 'shared %s %s\\n' "$WORKFLOW_PROJECT_ROOT" "$WORKFLOW_WORKTREE" >> "${fixture.log}"`,
          },
        ],
      },
    })
    writeJson(localFile(fixture), {
      version: 1,
      hooks: {
        'work-start.after': [
          { name: 'local', run: `echo local >> "${fixture.log}"` },
          { name: 'note', instruct: 'Tell the user the worktree is ready.', blocking: true },
        ],
      },
    })

    const result = runHooks(
      ['run', '--moment', 'work-start.after', '--ticket', 'FLOW-1'],
      fixture.worktree,
      fixture.configDir,
      { WORKFLOW_PR_URL: 'inherited-from-caller' }
    )

    assert.equal(result.status, 0)
    assert.deepEqual(progressLines(result.stderr), [
      '✓ workflow-hooks: work-start.after user-a (user) ok in <n>ms',
      '✓ workflow-hooks: work-start.after shared (project) ok in <n>ms',
      '✓ workflow-hooks: work-start.after local (local) ok in <n>ms',
    ])
    assert.equal(
      readFileSync(fixture.log, 'utf8'),
      `user-a work-start.after FLOW-1 FLOW-1-story unset ${fixture.worktree}\n` +
        `shared ${fixture.repo} ${fixture.worktree}\n` +
        'local\n'
    )
    const json = result.json as { ran: unknown; instructions: unknown }
    assert.deepEqual(withoutDuration(json.ran), [
      {
        name: 'user-a',
        source: 'user',
        outcome: 'ok',
        blocking: false,
        exitCode: 0,
        outputTail: '',
      },
      {
        name: 'shared',
        source: 'project',
        outcome: 'ok',
        blocking: false,
        exitCode: 0,
        outputTail: '',
      },
      {
        name: 'local',
        source: 'local',
        outcome: 'ok',
        blocking: false,
        exitCode: 0,
        outputTail: '',
      },
    ])
    assert.deepEqual(json.instructions, [
      {
        name: 'note',
        source: 'local',
        blocking: true,
        text: 'Tell the user the worktree is ready.',
      },
    ])
  } finally {
    fixture.cleanup()
  }
})

test('workflow-hooks run warns past a non-blocking failure and stops at a blocking one', () => {
  const fixture = makeFixture()
  try {
    writeJson(userFile(fixture), {
      version: 1,
      hooks: { 'cleanup.before': [{ name: 'warn-step', run: 'echo first-out; exit 4' }] },
    })
    writeJson(projectFile(fixture), {
      version: 1,
      hooks: {
        'cleanup.before': [{ name: 'gate-step', run: 'echo boom >&2; exit 2', blocking: true }],
      },
    })
    writeJson(localFile(fixture), {
      version: 1,
      hooks: {
        'cleanup.before': [
          { name: 'after-gate', run: `echo should-not-run >> "${fixture.log}"` },
          { name: 'never-returned', instruct: 'This instruction must not come back.' },
        ],
      },
    })

    const result = runHooks(
      ['run', '--moment', 'cleanup.before'],
      fixture.worktree,
      fixture.configDir
    )

    assert.equal(result.status, 3)
    assert.deepEqual(progressLines(result.stderr), [
      '✗ workflow-hooks: cleanup.before warn-step (user) failed in <n>ms, exit 4',
      '✗ workflow-hooks: cleanup.before gate-step (project) failed in <n>ms, exit 2',
    ])
    const json = result.json as { ran: unknown; instructions: unknown }
    assert.deepEqual(withoutDuration(json.ran), [
      {
        name: 'warn-step',
        source: 'user',
        outcome: 'failed',
        blocking: false,
        exitCode: 4,
        outputTail: 'first-out',
      },
      {
        name: 'gate-step',
        source: 'project',
        outcome: 'failed',
        blocking: true,
        exitCode: 2,
        outputTail: 'boom',
      },
    ])
    assert.deepEqual(json.instructions, [])
    assert.equal(existsSync(fixture.log), false)
  } finally {
    fixture.cleanup()
  }
})

test('workflow-hooks run reports a step that outlives its timeout as timeout and kills what it started', async () => {
  const fixture = makeFixture()
  try {
    const pidFile = join(fixture.configDir, 'child.pid')
    writeJson(localFile(fixture), {
      version: 1,
      hooks: {
        'tests.before': [
          {
            name: 'slow',
            run: `sleep 30 & echo $! > "${pidFile}"; wait`,
            blocking: true,
            timeoutSeconds: 3,
          },
        ],
      },
    })

    const result = runHooks(
      ['run', '--moment', 'tests.before'],
      fixture.worktree,
      fixture.configDir
    )

    assert.equal(result.status, 3)
    const json = result.json as { ran: Array<{ outcome: string; exitCode: number | null }> }
    assert.equal(json.ran[0]?.outcome, 'timeout')
    assert.equal(json.ran[0]?.exitCode, null)
    assert.deepEqual(progressLines(result.stderr), [
      '✗ workflow-hooks: tests.before slow (local) timeout in <n>ms',
    ])
    assert.equal(existsSync(pidFile), true, 'the step never wrote its pidfile before it timed out')
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.equal(await isGone(childPid), true, `process ${childPid} outlived the step's timeout`)
  } finally {
    fixture.cleanup()
  }
})

test('workflow-hooks run passes --pr and --tests-outcome to commands as environment variables', () => {
  const fixture = makeFixture()
  try {
    writeJson(localFile(fixture), {
      version: 1,
      hooks: {
        'tests.after': [
          {
            name: 'env',
            run: `printf '%s|%s\\n' "\${WORKFLOW_PR_URL-unset}" "\${WORKFLOW_TESTS_OUTCOME-unset}" >> "${fixture.log}"`,
          },
        ],
      },
    })

    const withFlags = runHooks(
      [
        'run',
        '--moment',
        'tests.after',
        '--pr',
        'https://example.test/pull/7',
        '--tests-outcome',
        'fail',
      ],
      fixture.worktree,
      fixture.configDir,
      { WORKFLOW_PR_URL: 'inherited', WORKFLOW_TESTS_OUTCOME: 'inherited' }
    )
    const withoutFlags = runHooks(
      ['run', '--moment', 'tests.after'],
      fixture.worktree,
      fixture.configDir,
      {
        WORKFLOW_PR_URL: 'inherited',
        WORKFLOW_TESTS_OUTCOME: 'inherited',
      }
    )

    assert.equal(withFlags.status, 0)
    assert.equal(withoutFlags.status, 0)
    assert.equal(
      readFileSync(fixture.log, 'utf8'),
      'https://example.test/pull/7|fail\nunset|unset\n'
    )
  } finally {
    fixture.cleanup()
  }
})

test('workflow-hooks run exits the same for one argument vector with or without a hooks file', () => {
  const fixture = makeFixture()
  try {
    const vectors = [
      ['run', '--moment', 'tests.after', '--tests-outcome', 'passed'],
      ['run', '--moment', 'tests.after', '--tests-outcome'],
      ['run', '--moment', 'tests.after', '--bogus', 'x'],
      ['run', '--moment', 'tests.after', '--ticket', 'A', '--ticket', 'B'],
      ['run', '--moment', 'tests.after', 'extra'],
      ['run', '--moment', 'tests.before', '--ticket', '-x'],
      ['run', '--moment', 'tests.before', '--ticket', '--pr'],
      ['run', '--moment', 'tests.before', '--ticket', '--tests-outcome'],
      ['run', '--moment', 'tests.before', '--ticket', '--bogus'],
      ['run', '--moment', 'tests.before', '--pr', '--moment'],
    ]
    const exitFor = (args: string[]): number | null =>
      spawnSync(binPath, args, {
        encoding: 'utf8',
        cwd: fixture.worktree,
        env: { ...process.env, CLAUDE_CONFIG_DIR: fixture.configDir },
      }).status

    const withoutFile = vectors.map(exitFor)
    writeJson(userFile(fixture), { version: 1, hooks: {} })
    const withFile = vectors.map(exitFor)

    assert.deepEqual(withoutFile, withFile)
    assert.equal(
      withFile.every((status) => status !== 0),
      true,
      `statuses with a hooks file: ${withFile.join(', ')}`
    )
  } finally {
    fixture.cleanup()
  }
})

test('workflow-hooks run answers the same for a dash-shaped value the CLI accepts, with or without a hooks file', () => {
  const fixture = makeFixture()
  try {
    const vectors = [
      ['run', '--moment', 'tests.before', '--ticket', '-'],
      ['run', '--moment', 'tests.before', '--ticket', '--'],
      ['run', '--moment', 'tests.before', '--pr', '-'],
      ['run', '--moment', 'tests.before', '--ticket=A'],
      ['run', '--moment', 'tests.before', '--ticket=-x'],
    ]
    const resultFor = (args: string[]): { status: number | null; stdout: string } => {
      const result = spawnSync(binPath, args, {
        encoding: 'utf8',
        cwd: fixture.worktree,
        env: { ...process.env, CLAUDE_CONFIG_DIR: fixture.configDir },
      })
      return { status: result.status, stdout: result.stdout }
    }

    const withoutFile = vectors.map(resultFor)
    writeJson(userFile(fixture), { version: 1, hooks: {} })
    const withFile = vectors.map(resultFor)

    assert.deepEqual(withoutFile, withFile)
    assert.deepEqual(
      withFile.map((result) => result.status),
      [0, 0, 0, 0, 0]
    )
  } finally {
    fixture.cleanup()
  }
})

test('workflow-hooks run refuses an invalid hooks file or moment with exit 1', () => {
  const cases: Array<{ file: unknown; field: string }> = [
    {
      file: { version: 1, hooks: { 'prd.befor': [{ name: 'a', run: 'true' }] } },
      field: 'hooks.prd.befor',
    },
    {
      file: { version: 1, hooks: { 'prd.before': [{ name: 'a', run: 'true', instruct: 'x' }] } },
      field: 'hooks.prd.before[0].run',
    },
    {
      file: {
        version: 1,
        hooks: {
          'prd.before': [{ name: 'a', run: 'true' }],
          'prd.after': [{ name: 'a', run: 'true' }],
        },
      },
      field: 'hooks.prd.after',
    },
    { file: { version: 1, hooks: {}, disable: ['a'] }, field: 'disable' },
    {
      file: {
        version: 1,
        hooks: { 'prd.before': [{ name: 'a', instruct: 'x', timeoutSeconds: 5 }] },
      },
      field: 'hooks.prd.before[0].timeoutSeconds',
    },
    {
      file: {
        version: 1,
        hooks: { 'prd.before': [{ name: 'a', run: 'true', timeoutSeconds: 16.1 }] },
      },
      field: 'hooks.prd.before[0].timeoutSeconds',
    },
    {
      file: {
        version: 1,
        hooks: { 'prd.before': [{ name: 'a', run: 'true', timeoutSeconds: 86401 }] },
      },
      field: 'hooks.prd.before[0].timeoutSeconds',
    },
    { file: 'not json', field: '(file)' },
  ]
  const fixture = makeFixture()
  try {
    for (const { file, field } of cases) {
      if (typeof file === 'string') {
        writeFileSync(userFile(fixture), file)
      } else {
        writeJson(userFile(fixture), file)
      }

      const result = runHooks(
        ['run', '--moment', 'prd.before'],
        fixture.worktree,
        fixture.configDir
      )

      assert.equal(result.status, 1, field)
      const problems = (result.json as { problems: Array<{ file: string; field: string }> })
        .problems
      assert.deepEqual(
        problems.map((problem) => [problem.file, problem.field]),
        [[userFile(fixture), field]]
      )
    }

    rmSync(userFile(fixture))
    const unknownMoment = runHooks(['run', '--moment', 'nope'], fixture.worktree, fixture.configDir)
    assert.equal(unknownMoment.status, 1)
    assert.equal((unknownMoment.json as { error: string }).error, 'unknown moment "nope"')
    const refusal = unknownMoment.stderr.split('\n').find((line) => line.startsWith('‼ '))
    assert.equal(
      refusal,
      `‼ workflow-hooks: unknown moment "nope" — the moments are ${MOMENT_IDS.join(', ')}`
    )

    const wellShapedUnknown = runHooks(
      ['run', '--moment', 'work-start.before'],
      fixture.worktree,
      fixture.configDir
    )
    assert.equal(wellShapedUnknown.status, 1)
    assert.equal(
      (wellShapedUnknown.json as { error: string }).error,
      'unknown moment "work-start.before"'
    )
  } finally {
    fixture.cleanup()
  }
})

test('workflow-hooks run outside git reads project files from the launch directory', () => {
  const fixture = makeFixture()
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-hooks-plain-')))
  try {
    mkdirSync(join(plain, '.claude'))
    writeJson(join(plain, '.claude', 'workflow-hooks.json'), {
      version: 1,
      hooks: {
        'prd.before': [
          {
            name: 'plain',
            run: `printf '%s|%s|%s\\n' "$(pwd)" "$WORKFLOW_PROJECT_ROOT" "\${WORKFLOW_BRANCH-unset}" >> "${fixture.log}"`,
          },
        ],
      },
    })

    const result = runHooks(['run', '--moment', 'prd.before'], plain, fixture.configDir)

    assert.equal(result.status, 0)
    assert.equal(readFileSync(fixture.log, 'utf8'), `${plain}|${plain}|unset\n`)
  } finally {
    rmSync(plain, { recursive: true, force: true })
    fixture.cleanup()
  }
})

test('workflow-hooks list shows each step with its source and what disabled it', () => {
  const fixture = makeFixture()
  try {
    writeJson(userFile(fixture), {
      version: 1,
      hooks: {
        'tests.before': [{ name: 'user-a', run: 'true' }],
        'tests.after': [{ name: 'user-b', run: 'true', blocking: true }],
      },
    })
    writeJson(projectFile(fixture), {
      version: 1,
      disable: ['user-b'],
      hooks: { 'tests.before': [{ name: 'shared', instruct: 'Say hello.' }] },
    })
    writeJson(localFile(fixture), { version: 1, disable: ['user-b'], hooks: {} })

    const result = runHooks(['list', '--json'], fixture.worktree, fixture.configDir)

    assert.equal(result.status, 0)
    assert.deepEqual(result.json, {
      files: [
        { source: 'user', path: userFile(fixture), present: true },
        { source: 'project', path: projectFile(fixture), present: true },
        { source: 'local', path: localFile(fixture), present: true },
      ],
      steps: [
        {
          moment: 'tests.before',
          name: 'user-a',
          source: 'user',
          kind: 'run',
          blocking: false,
          disabledBy: [],
        },
        {
          moment: 'tests.before',
          name: 'shared',
          source: 'project',
          kind: 'instruct',
          blocking: false,
          disabledBy: [],
        },
        {
          moment: 'tests.after',
          name: 'user-b',
          source: 'user',
          kind: 'run',
          blocking: true,
          disabledBy: ['project', 'local'],
        },
      ],
    })

    const text = spawnSync(binPath, ['list'], {
      encoding: 'utf8',
      cwd: fixture.worktree,
      env: { ...process.env, CLAUDE_CONFIG_DIR: fixture.configDir },
    })
    assert.equal(text.status, 0)
    assert.equal(
      text.stdout,
      [
        'Hook files:',
        `  user     ${userFile(fixture)}`,
        `  project  ${projectFile(fixture)}`,
        `  local    ${localFile(fixture)}`,
        '',
        'tests.before',
        '  user     run       warn      user-a',
        '  project  instruct  warn      shared',
        '',
        'tests.after',
        '  user     run       blocking  user-b  (disabled by project and local)',
        '',
      ].join('\n')
    )
  } finally {
    fixture.cleanup()
  }
})
