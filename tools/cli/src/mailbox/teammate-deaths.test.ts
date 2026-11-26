import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  existsSync,
} from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionGlobalScope, storePath } from '../workflow-store/store.ts'
import {
  scanTeammates,
  scanTeammateDeaths,
  recordTeammateDeathsReported,
  formatTeammateDeath,
  scanTeammatesNeverStarted,
  recordTeammatesNeverStartedReported,
  formatTeammateNeverStarted,
  parseAgentProcesses,
  SPAWN_GRACE_MS,
  type RunningAgent,
} from './teammate-deaths.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

// storeRoot() is homedir()-relative — override HOME so the ledger never touches a real operator's
// state. loadTeamConfig separately reads CLAUDE_CONFIG_DIR (or homedir()) — override both to the
// same temp dir and restore both, matching monitor-deaths.test.ts's own per-file fixture shape.
let tmpDir: string
let origHome: string | undefined
let origConfigDir: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'teammate-deaths-test-'))
  origHome = process.env.HOME
  process.env.HOME = tmpDir
  origConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = origHome
  }

  if (origConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = origConfigDir
  }

  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const RAW = 'abcdef12-0000-4000-8000-000000000000'
const NOW = 10 * 60_000 + 1_000_000

// Members default to `iterm2` (pane-backed, scannable) unless a test overrides `backendType` to
// exercise an in-process one, an absent one, or an unrecognized one instead. team-lead's own entry
// hardcodes `in-process` here for brevity; real configs often omit it, and the exclusion below
// matches team-lead by name regardless of its backendType.
const writeTeam = (
  rawId: string,
  members: { name: string; agentId: string; joinedAt: number; backendType?: string }[],
  leadSessionId: string = rawId
): void => {
  const dir = join(tmpDir, 'teams', `session-${rawId.slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      name: `session-${rawId.slice(0, 8)}`,
      leadSessionId,
      members: [
        {
          name: 'team-lead',
          agentId: `team-lead@session-${rawId.slice(0, 8)}`,
          backendType: 'in-process',
        },
        ...members.map((m) => ({ backendType: 'iterm2', ...m })),
      ],
    })
  )
}

// What the harness does once a team's last teammate exits: the whole team directory goes.
const removeTeam = (rawId: string): void => {
  rmSync(join(tmpDir, 'teams', `session-${rawId.slice(0, 8)}`), { recursive: true, force: true })
}

test('dead: member with no process past the grace window is reported', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])

  const scan = scanTeammateDeaths(RAW, NOW, [])

  assert.equal(scan.unreported.length, 1)
  assert.equal(scan.unreported[0]!.name, 'impl')
  const message = formatTeammateDeath(scan.unreported[0]!)
  assert.equal(
    message,
    '[team] dead-teammate impl — no process is running for impl@session-abcdef12 ' +
      `(joined ${new Date(NOW - 6 * 60_000).toISOString()}), so nothing can arrive from it; its pane ` +
      'may still be open and SendMessage still reports delivery. If you were waiting on its shutdown ' +
      'acknowledgment, the shutdown is complete — nothing else needed. Otherwise, if its work is ' +
      'unfinished, respawn it — if the respawn dies too, the client needs a restart (usually after an ' +
      'update).'
  )
})

test('in-process: a member past the grace window is not reported dead', () => {
  writeTeam(RAW, [
    {
      name: 'impl',
      agentId: 'impl@session-abcdef12',
      joinedAt: NOW - 6 * 60_000,
      backendType: 'in-process',
    },
  ])

  assert.deepEqual(scanTeammates(RAW, [])?.members, [])
  assert.deepEqual(scanTeammateDeaths(RAW, NOW, []).all, [])
})

test('unknown backendType: absent or unrecognized backendType past the grace window is reported dead', () => {
  writeTeam(RAW, [
    {
      name: 'impl',
      agentId: 'impl@session-abcdef12',
      joinedAt: NOW - 6 * 60_000,
      backendType: undefined,
    },
    {
      name: 'other',
      agentId: 'other@session-abcdef12',
      joinedAt: NOW - 6 * 60_000,
      backendType: 'some-future-backend',
    },
  ])

  const scan = scanTeammateDeaths(RAW, NOW, [])

  assert.equal(scan.unreported.length, 2)
  assert.deepEqual(scan.unreported.map((m) => m.name).sort(), ['impl', 'other'])
})

test('grace: member with no process inside the grace window is not dead', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 60_000 }])

  const scan = scanTeammateDeaths(RAW, NOW, [])

  assert.deepEqual(scan.all, [])
})

test('alive: member with a running process is not dead', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  const processes: RunningAgent[] = [
    { pid: 42, agentId: 'impl@session-abcdef12', teamName: 'session-abcdef12' },
  ]

  const scan = scanTeammateDeaths(RAW, NOW, processes)

  assert.deepEqual(scan.all, [])
  assert.equal(scanTeammates(RAW, processes)?.members[0]?.pid, 42)
})

test('ledger: a reported death is silent; a respawn reports again', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  const first = scanTeammateDeaths(RAW, NOW, [])
  recordTeammateDeathsReported(first.all, RAW)

  const second = scanTeammateDeaths(RAW, NOW, [])
  assert.deepEqual(second.unreported, [])

  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 7 * 60_000 }])
  const third = scanTeammateDeaths(RAW, NOW, [])
  assert.equal(third.unreported.length, 1)
})

test('orphan: a running process of this team missing from members', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  const processes: RunningAgent[] = [
    { pid: 42, agentId: 'impl@session-abcdef12', teamName: 'session-abcdef12' },
    { pid: 43, agentId: 'ghost@session-abcdef12', teamName: 'session-abcdef12' },
    { pid: 44, agentId: 'other@session-99999999', teamName: 'session-99999999' },
  ]

  const scan = scanTeammates(RAW, processes)

  assert.deepEqual(scan?.orphans, [
    { pid: 43, agentId: 'ghost@session-abcdef12', teamName: 'session-abcdef12' },
  ])
})

test('foreign team: config whose leadSessionId differs is ignored', () => {
  writeTeam(
    RAW,
    [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }],
    'someone-else'
  )

  assert.equal(scanTeammates(RAW, [])?.team, null)
  assert.deepEqual(scanTeammateDeaths(RAW, NOW, []).all, [])
})

test('ps failure: unreadable process table reports nothing', () => {
  const scan = scanTeammateDeaths(RAW, NOW, null)

  assert.deepEqual(scan.all, [])
  assert.equal(scanTeammates(RAW, null), null)
})

test('dissolved: a removed team reports the roster last seen, each member with its process state', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  const live = scanTeammates(RAW, [
    { pid: 42, agentId: 'impl@session-abcdef12', teamName: 'session-abcdef12' },
  ])
  assert.equal(live?.dissolved, false)

  removeTeam(RAW)
  const scan = scanTeammates(RAW, [])

  assert.equal(scan?.team, 'session-abcdef12')
  assert.equal(scan?.dissolved, true)
  assert.deepEqual(scan?.members, [
    { name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000, pid: null },
  ])
})

test('dissolved: the saved roster follows the config as members leave it', () => {
  writeTeam(RAW, [
    { name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 },
    { name: 'senior', agentId: 'senior@session-abcdef12', joinedAt: NOW - 6 * 60_000 },
  ])
  scanTeammates(RAW, [])
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  scanTeammates(RAW, [])

  removeTeam(RAW)

  assert.deepEqual(
    scanTeammates(RAW, [])?.members.map((m) => m.name),
    ['impl']
  )
})

test('dissolved: a member with no process is dead at once, inside the grace window too', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 60_000 }])
  scanTeammates(RAW, [])
  removeTeam(RAW)

  const scan = scanTeammateDeaths(RAW, NOW, [])

  assert.deepEqual(
    scan.unreported.map((m) => m.name),
    ['impl']
  )
})

test('dissolved: a member still running is alive, and a stray process of the team is an orphan', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  scanTeammates(RAW, [])
  removeTeam(RAW)
  const processes: RunningAgent[] = [
    { pid: 42, agentId: 'impl@session-abcdef12', teamName: 'session-abcdef12' },
    { pid: 43, agentId: 'ghost@session-abcdef12', teamName: 'session-abcdef12' },
  ]

  const scan = scanTeammates(RAW, processes)

  assert.equal(scan?.members[0]?.pid, 42)
  assert.deepEqual(scan?.orphans, [
    { pid: 43, agentId: 'ghost@session-abcdef12', teamName: 'session-abcdef12' },
  ])
  assert.deepEqual(scanTeammateDeaths(RAW, NOW, processes).all, [])
})

test('torn config: a config that fails to parse is not a dissolved team, and no grace-free death follows', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 60_000 }])
  scanTeammates(RAW, [])
  writeFileSync(join(tmpDir, 'teams', 'session-abcdef12', 'config.json'), '{"name": "sess')

  const scan = scanTeammates(RAW, [])

  assert.equal(scan?.dissolved, false)
  assert.equal(scan?.team, null)
  assert.deepEqual(scanTeammateDeaths(RAW, NOW, []).unreported, [])
})

test('malformed roster: a saved member missing its fields reports no team instead of throwing', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  scanTeammates(RAW, [])
  const rosterFile = storePath(sessionGlobalScope(RAW), 'teammate-roster.json')
  assert.ok(existsSync(rosterFile), rosterFile)
  writeFileSync(
    rosterFile,
    JSON.stringify({ name: 'session-abcdef12', members: [{ name: 'impl' }] })
  )
  removeTeam(RAW)

  const scan = scanTeammates(RAW, [])

  assert.equal(scan?.team, null)
  assert.equal(scan?.emptyReason, 'roster-unusable')
})

test('no saved roster: a session that never saw its team still reports no team', () => {
  assert.equal(scanTeammates(RAW, [])?.team, null)
  assert.equal(scanTeammates(RAW, [])?.dissolved, false)
})

// What a teammate's own turn start writes into its lead's turn list (teammate-turns.ts).
const writeStartedTurns = (rawId: string, pids: number[]): void => {
  const path = storePath(sessionGlobalScope(rawId), 'teammate-turns.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      Object.fromEntries(
        pids.map((pid, i) => [
          `teammate-session-${i}`,
          { label: `t${i}`, pid, startedAt: '2026-11-25T00:00:00.000Z' },
        ])
      )
    )
  )
}

const runningImpl: RunningAgent[] = [
  { pid: 42, agentId: 'impl@session-abcdef12', teamName: 'session-abcdef12' },
]

test('never started: a running member past the grace with no turn is reported once', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])

  const scan = scanTeammatesNeverStarted(RAW, NOW, runningImpl)

  assert.equal(scan.unreported.length, 1)
  assert.equal(
    formatTeammateNeverStarted(scan.unreported[0]!),
    '[team] teammate-never-started impl — impl@session-abcdef12 has a running process ' +
      `(pid 42, joined ${new Date(NOW - 6 * 60_000).toISOString()}) but has recorded no turn ` +
      'since it joined. If you have had any message from it since you spawned it, it did start ' +
      'and this report is a missed write — ignore it. Otherwise end its process with ' +
      '`kill 42`, then confirm it exited: `kill -0 42` fails once it is gone, so re-check for up ' +
      'to 10 seconds, since a process handling SIGTERM can linger. If it is still running after ' +
      'that, post a board blocker naming the pid. Once it is confirmed gone: if you were ' +
      'waiting on its shutdown acknowledgment, the shutdown is complete — nothing else ' +
      'needed; if its work is unfinished, respawn it with the same instructions — if the ' +
      'respawn is reported teammate-never-started too, the client needs a restart.'
  )

  recordTeammatesNeverStartedReported(scan.all, RAW)
  assert.deepEqual(scanTeammatesNeverStarted(RAW, NOW, runningImpl), {
    all: scan.all,
    unreported: [],
  })
})

test('never started: a respawn under the same name reports again', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  recordTeammatesNeverStartedReported(scanTeammatesNeverStarted(RAW, NOW, runningImpl).all, RAW)

  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 5 * 60_000 }])

  assert.equal(scanTeammatesNeverStarted(RAW, NOW, runningImpl).unreported.length, 1)
})

test('recorded: a running member whose pid has a turn entry is not reported', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  writeStartedTurns(RAW, [42])

  assert.deepEqual(scanTeammatesNeverStarted(RAW, NOW, runningImpl).all, [])
})

test('recorded: a turn entry for another pid does not count for this member', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  writeStartedTurns(RAW, [41])

  assert.equal(scanTeammatesNeverStarted(RAW, NOW, runningImpl).all.length, 1)
})

test('never started: inside the grace window is not reported', () => {
  writeTeam(RAW, [
    { name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - SPAWN_GRACE_MS + 1 },
  ])

  assert.deepEqual(scanTeammatesNeverStarted(RAW, NOW, runningImpl).all, [])
})

test('never started: exactly at the grace boundary is reported', () => {
  writeTeam(RAW, [
    { name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - SPAWN_GRACE_MS },
  ])

  assert.equal(scanTeammatesNeverStarted(RAW, NOW, runningImpl).all.length, 1)
})

test('never started: a member with no process is left to the dead-teammate report', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])

  assert.deepEqual(scanTeammatesNeverStarted(RAW, NOW, []).all, [])
})

test('never started: an unreadable turn list reports nothing', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  mkdirSync(storePath(sessionGlobalScope(RAW), 'teammate-turns.json'), { recursive: true })

  assert.deepEqual(scanTeammatesNeverStarted(RAW, NOW, runningImpl).all, [])
})

test('never started: a malformed turn list reports nothing', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  const path = storePath(sessionGlobalScope(RAW), 'teammate-turns.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ 'teammate-session-0': { label: 't0' } }))

  assert.deepEqual(scanTeammatesNeverStarted(RAW, NOW, runningImpl).all, [])
})

test('argv: only the full teammate flag triple parses', () => {
  const psOutput = [
    '  101 /Users/x/.local/share/claude/versions/2.1.282 --agent-id impl-375@session-4a6e3605 --agent-name impl-375 --team-name session-4a6e3605 --agent-color blue',
    '  102 node tools/cli/src/main.ts review-ledger senior shutdown --ticket FLOW-1 --round 2 --agent-id impl-375@session-4a6e3605',
  ].join('\n')

  assert.deepEqual(parseAgentProcesses(psOutput), [
    { pid: 101, agentId: 'impl-375@session-4a6e3605', teamName: 'session-4a6e3605' },
  ])
})

test('argv: flag order does not matter', () => {
  const psOutput =
    '  101 /path/claude --team-name session-4a6e3605 --agent-name impl-375 --agent-id impl-375@session-4a6e3605'

  assert.deepEqual(parseAgentProcesses(psOutput), [
    { pid: 101, agentId: 'impl-375@session-4a6e3605', teamName: 'session-4a6e3605' },
  ])
})

const runTeammatesCli = (
  envOverrides: Record<string, string | undefined>
): { stdout: string; stderr: string; status: number | null } => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }

  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, 'mailbox', 'teammates'],
    { encoding: 'utf8', env }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

test('CLI: mailbox teammates prints JSON and exits 0 for a matching team', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])

  const { stdout, stderr, status } = runTeammatesCli({
    HOME: tmpDir,
    CLAUDE_CONFIG_DIR: tmpDir,
    CLAUDE_CODE_SESSION_ID: RAW,
  })

  assert.equal(status, 0, stderr)
  const parsed = JSON.parse(stdout) as { team: string; members: unknown[]; orphans: unknown[] }
  assert.equal(parsed.team, 'session-abcdef12')
  assert.equal(parsed.members.length, 1)
  assert.deepEqual(parsed.orphans, [])
})

const cliEnv = (): Record<string, string> => ({
  HOME: tmpDir,
  CLAUDE_CONFIG_DIR: tmpDir,
  CLAUDE_CODE_SESSION_ID: RAW,
  NODE_NO_WARNINGS: '1',
})

const implMember = { name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }

test('CLI: mailbox check reports a running teammate with no recorded turn, then prints nothing on the next run', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'setInterval(() => {}, 1000)',
      '--',
      '--agent-id',
      'impl@session-abcdef12',
      '--agent-name',
      'impl',
      '--team-name',
      'session-abcdef12',
    ],
    { stdio: 'ignore' }
  )
  try {
    const member = {
      name: 'impl',
      agentId: 'impl@session-abcdef12',
      joinedAt: Date.now() - 6 * 60_000,
    }
    writeTeam(RAW, [member])
    const runCheck = () => {
      const result = spawnSync(
        process.execPath,
        ['--experimental-transform-types', mainTsPath, 'mailbox', 'check', '--session', RAW],
        { encoding: 'utf8', env: { ...process.env, ...cliEnv() }, timeout: 30_000 }
      )
      return { stdout: result.stdout, stderr: result.stderr, status: result.status }
    }
    const reportedKeys = (): unknown =>
      JSON.parse(
        readFileSync(
          storePath(sessionGlobalScope(RAW), 'teammate-never-started-reported.json'),
          'utf8'
        )
      )

    assert.deepEqual(runCheck(), {
      stdout: `${formatTeammateNeverStarted({ ...member, pid: child.pid! })}\n`,
      stderr: '',
      status: 0,
    })
    assert.deepEqual(reportedKeys(), [`${member.agentId}:${member.joinedAt}`])

    assert.deepEqual(runCheck(), { stdout: '', stderr: '', status: 0 })
  } finally {
    child.kill()
  }
})

const scanJson = (dissolved: boolean): string =>
  `${JSON.stringify(
    {
      team: 'session-abcdef12',
      emptyReason: null,
      dissolved,
      members: [{ ...implMember, pid: null }],
      orphans: [],
    },
    null,
    2
  )}\n`

test('CLI: mailbox teammates exits 0 with dissolved true once the team directory is gone', () => {
  writeTeam(RAW, [implMember])
  const first = runTeammatesCli(cliEnv())
  assert.deepEqual(first, { stdout: scanJson(false), stderr: '', status: 0 })

  removeTeam(RAW)

  assert.deepEqual(runTeammatesCli(cliEnv()), { stdout: scanJson(true), stderr: '', status: 0 })
})

test('CLI: mailbox teammates warns on stderr naming the roster path when the roster cannot be saved, and still exits 0', () => {
  writeTeam(RAW, [implMember])
  assert.equal(runTeammatesCli(cliEnv()).status, 0)
  const savedAt = storePath(sessionGlobalScope(RAW), 'teammate-roster.json')
  rmSync(savedAt)
  mkdirSync(savedAt)

  assert.deepEqual(runTeammatesCli(cliEnv()), {
    stdout: scanJson(false),
    stderr: `mailbox: could not save the teammate roster to ${savedAt}: EISDIR\n`,
    status: 0,
  })
})

test('CLI: mailbox teammates exits 1 naming the unusable config when a saved roster exists beside a torn config', () => {
  writeTeam(RAW, [implMember])
  assert.equal(runTeammatesCli(cliEnv()).status, 0)
  writeFileSync(join(tmpDir, 'teams', 'session-abcdef12', 'config.json'), '{"name": "sess')

  assert.deepEqual(runTeammatesCli(cliEnv()), {
    stdout: '',
    stderr:
      "mailbox teammates: this session's team config is unreadable, malformed or another session's\n",
    status: 1,
  })
})

const rosterUnusableStderr =
  "mailbox teammates: the team config is gone and this session's saved roster is unreadable or malformed\n"

test('CLI: mailbox teammates exits 1 naming the unusable roster when the saved roster cannot be read', () => {
  writeTeam(RAW, [implMember])
  assert.equal(runTeammatesCli(cliEnv()).status, 0)
  const savedAt = storePath(sessionGlobalScope(RAW), 'teammate-roster.json')
  rmSync(savedAt)
  mkdirSync(savedAt)
  removeTeam(RAW)

  assert.deepEqual(runTeammatesCli(cliEnv()), {
    stdout: '',
    stderr: rosterUnusableStderr,
    status: 1,
  })
})

test('CLI: mailbox teammates exits 1 naming the unusable roster when the saved roster parses but is malformed', () => {
  writeTeam(RAW, [implMember])
  assert.equal(runTeammatesCli(cliEnv()).status, 0)
  writeFileSync(
    storePath(sessionGlobalScope(RAW), 'teammate-roster.json'),
    JSON.stringify({ name: 'session-abcdef12', members: [{ name: 'impl' }] })
  )
  removeTeam(RAW)

  assert.deepEqual(runTeammatesCli(cliEnv()), {
    stdout: '',
    stderr: rosterUnusableStderr,
    status: 1,
  })
})

test('CLI: mailbox teammates exits 2 with no session id', () => {
  const { stderr, status } = runTeammatesCli({
    HOME: tmpDir,
    CLAUDE_CONFIG_DIR: tmpDir,
    CLAUDE_CODE_SESSION_ID: undefined,
  })

  assert.equal(status, 2)
  assert.match(stderr, /no session id/)
})

test('CLI: mailbox teammates exits 1 with no team config and no saved roster', () => {
  assert.deepEqual(runTeammatesCli(cliEnv()), {
    stdout: '',
    stderr: 'mailbox teammates: no team config for this session, and no roster saved from one\n',
    status: 1,
  })
})

test('CLI: mailbox teammates exits 1 when the process table cannot be read', () => {
  writeTeam(RAW, [{ name: 'impl', agentId: 'impl@session-abcdef12', joinedAt: NOW - 6 * 60_000 }])
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'teammate-deaths-fakebin-'))
  writeFileSync(join(fakeBinDir, 'ps'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(fakeBinDir, 'ps'), 0o755)

  const { stderr, status } = runTeammatesCli({
    HOME: tmpDir,
    CLAUDE_CONFIG_DIR: tmpDir,
    CLAUDE_CODE_SESSION_ID: RAW,
    PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
  })

  assert.equal(status, 1)
  assert.match(stderr, /could not read the process table/)
})
