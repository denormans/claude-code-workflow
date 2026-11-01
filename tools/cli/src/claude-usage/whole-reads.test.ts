import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectClaudeUsage } from './main.ts'
import {
  createWholeReadCollector,
  formatWholeReadTable,
  summarizeWholeReads,
  WHOLE_READ_MIN_CHARS,
  type WholeReadContext,
} from './whole-reads.ts'

test('counts whole and ranged Reads over the cut separately and skips small and image reads', () => {
  const collector = createWholeReadCollector()
  addAll(collector, [
    readCall('s1', 'a', { file_path: '/r/big.md' }),
    readResult('s1', 'a', large),
    readCall('s1', 'b', { file_path: '/r/big.md', offset: 10, limit: 20 }),
    readResult('s1', 'b', large),
    readCall('s1', 'c', { file_path: '/r/small.md' }),
    readResult('s1', 'c', 'short'),
    readCall('s1', 'd', { file_path: '/r/shot.png' }),
    readResult('s1', 'd', large),
    readCall('s1', 'e', { file_path: '/r/small.md', limit: 5 }),
    readResult('s1', 'e', 'short'),
    readCall('s1', 'f', { file_path: '/r/big.md', limit: 5 }),
    readResult('s1', 'f', 'y'.repeat(WHOLE_READ_MIN_CHARS + 10)),
  ])
  const report = summarizeWholeReads(collector.events(), () => 'solo', everyDay)
  assert.deepEqual(report.rows, [
    {
      role: 'solo',
      wholeReads: 1,
      chars: 24001,
      rangedReads: 2,
      rangedChars: 24001 + 24010,
      refusals: 0,
      filesRefusedTwice: 0,
    },
  ])
})

test('reads a result whose content is a list of text parts, and counts a repeated result once', () => {
  const collector = createWholeReadCollector()
  const parts = [{ type: 'text', text: large }]
  addAll(collector, [
    readCall('s1', 'a', { file_path: '/r/big.md' }),
    readResult('s1', 'a', parts),
    readResult('s1', 'a', parts),
  ])
  const report = summarizeWholeReads(collector.events(), () => 'solo', everyDay)
  assert.equal(report.rows[0]?.wholeReads, 1)
})

test('puts sub-agent transcripts under subagent and other sessions under their role', () => {
  const collector = createWholeReadCollector()
  addAll(collector, [
    readCall('lead', 'a', { file_path: '/r/big.md' }),
    readResult('lead', 'a', large),
  ])
  addAll(
    collector,
    [readCall('lead', 'b', { file_path: '/r/big.md' }), readResult('lead', 'b', large)],
    { subagent: true, date: day }
  )
  addAll(collector, [
    readCall('impl', 'c', { file_path: '/r/big.md' }),
    readResult('impl', 'c', large),
  ])
  const roles = { lead: 'team-lead', impl: 'implementer' } as const
  const report = summarizeWholeReads(
    collector.events(),
    (sessionId) => (sessionId === 'lead' ? roles.lead : roles.impl),
    everyDay
  )
  assert.deepEqual(
    report.rows.map((row) => [row.role, row.wholeReads]),
    [
      ['team-lead', 1],
      ['implementer', 1],
      ['subagent', 1],
    ]
  )
})

test('counts gate refusals and the files refused twice or more in one session', () => {
  const collector = createWholeReadCollector()
  addAll(collector, [
    readResult('s1', 'a', refusalText('/r/big.md'), true),
    readResult('s1', 'b', refusalText('/r/big.md'), true),
    readResult('s1', 'c', refusalText('/r/big.md'), true),
    readResult('s1', 'd', refusalText('/r/other.md'), true),
    readResult('s2', 'e', refusalText('/r/big.md'), true),
  ])
  const report = summarizeWholeReads(collector.events(), () => 'implementer', everyDay)
  assert.deepEqual(report.rows, [
    {
      role: 'implementer',
      wholeReads: 0,
      chars: 0,
      rangedReads: 0,
      rangedChars: 0,
      refusals: 5,
      filesRefusedTwice: 1,
    },
  ])
})

test("ignores another hook's error result", () => {
  const collector = createWholeReadCollector()
  addAll(collector, [
    readCall('s1', 'a', { file_path: '/r/shot.png' }),
    readResult(
      's1',
      'a',
      'PreToolUse:Read hook error: [/plugin/hooks/artifact-read-guard.sh]: Reading /r/shot.png is blocked',
      true
    ),
  ])
  assert.deepEqual(summarizeWholeReads(collector.events(), () => 'solo', everyDay).rows, [])
})

test('drops events outside the window', () => {
  const collector = createWholeReadCollector()
  addAll(collector, [readCall('s1', 'a', { file_path: '/r/big.md' }), readResult('s1', 'a', large)])
  const report = summarizeWholeReads(
    collector.events(),
    () => 'solo',
    (date) => date > day
  )
  assert.deepEqual(report.rows, [])
})

test('the table lists each role with its whole-read and ranged-read counts', () => {
  const collector = createWholeReadCollector()
  addAll(collector, [
    readCall('s1', 'a', { file_path: '/r/big.md' }),
    readResult('s1', 'a', large),
    readCall('s1', 'b', { file_path: '/r/big.md', limit: 100 }),
    readResult('s1', 'b', large),
  ])
  const table = formatWholeReadTable(
    summarizeWholeReads(collector.events(), () => 'solo', everyDay)
  )
  assert.equal(
    table,
    [
      '╭───────────────────────────────────────────────────────────────╮',
      '│                                                               │',
      '│  Whole-File and Ranged Reads over 24,000 Characters, by Role  │',
      '│                                                               │',
      '╰───────────────────────────────────────────────────────────────╯',
      '',
      '┌──────┬─────────────┬────────────┬──────────────┬───────────────────┬──────────┬──────────────────┐',
      '│ Role │ Whole Reads │ Characters │ Ranged Reads │ Ranged Characters │ Refusals │ Files Refused 2+ │',
      '├──────┼─────────────┼────────────┼──────────────┼───────────────────┼──────────┼──────────────────┤',
      '│ solo │           1 │     24,001 │            1 │            24,001 │        0 │                0 │',
      '└──────┴─────────────┴────────────┴──────────────┴───────────────────┴──────────┴──────────────────┘',
      '',
    ].join('\n')
  )
})

test('collectClaudeUsage reports whole reads by role when asked', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'whole-reads-test-'))
  const projectDir = join(claudeDir, 'projects', 'project-one')
  const subagentDir = join(projectDir, 'session-one', 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  writeRecords(join(projectDir, 'session-one.jsonl'), [
    readCall('session-one', 'a', { file_path: '/r/big.md' }),
    readResult('session-one', 'a', large),
  ])
  writeRecords(join(subagentDir, 'agent-one.jsonl'), [
    readCall('session-one', 'b', { file_path: '/r/big.md' }),
    readResult('session-one', 'b', large),
  ])

  try {
    const report = await collectClaudeUsage({
      claudeDir,
      projectDirectory: claudeDir,
      allProjects: true,
      utc: true,
      wholeReads: true,
      stderr: () => {},
    })
    assert.deepEqual(
      report.wholeReads?.rows.map((row) => [row.role, row.wholeReads]),
      [
        ['solo', 1],
        ['subagent', 1],
      ]
    )
  } finally {
    rmSync(claudeDir, { recursive: true, force: true })
  }
})

const day = '2026-11-01'
const timestamp = `${day}T12:00:00Z`
const large = 'x'.repeat(WHOLE_READ_MIN_CHARS + 1)
const everyDay = (): boolean => true

const readCall = (sessionId: string, id: string, input: Record<string, unknown>): object => ({
  type: 'assistant',
  sessionId,
  timestamp,
  message: { content: [{ type: 'tool_use', id, name: 'Read', input }] },
})

const readResult = (sessionId: string, id: string, content: unknown, isError = false): object => ({
  type: 'user',
  sessionId,
  timestamp,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
})

const refusalText = (path: string): string =>
  `PreToolUse:Read hook error: [/plugin/hooks/large-read-gate.sh]: Reading ${path} whole is ` +
  'refused by the large-read gate: it is 41000 bytes, over the 20000-byte\nlimit'

const addAll = (
  collector: ReturnType<typeof createWholeReadCollector>,
  records: object[],
  context: WholeReadContext = { subagent: false, date: day }
): void => {
  for (const record of records) {
    collector.add(record, context)
  }
}

const writeRecords = (path: string, records: object[]): void => {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}
