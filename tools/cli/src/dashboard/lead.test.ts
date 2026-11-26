import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findLeadSessionId,
  findTeammateIdentity,
  parseProcessTable,
  type ProcessRow,
} from './lead.ts'

const TEAMMATE_COMMAND =
  '/usr/local/bin/claude --agent-id impl@team-x --agent-name impl --team-name team-x ' +
  '--agent-color green --parent-session-id lead-session-1 --agent-type workflow:implementer'

test('findLeadSessionId: takes the lead from the nearest teammate ancestor', () => {
  const rows: ProcessRow[] = [
    { pid: 10, ppid: 1, command: TEAMMATE_COMMAND },
    { pid: 20, ppid: 10, command: '/bin/bash -c test-lock -- pnpm test' },
    { pid: 30, ppid: 20, command: 'node main.ts dashboard session heartbeat --session s' },
  ]

  assert.equal(findLeadSessionId(rows, 30), 'lead-session-1')
})

test('findLeadSessionId: a session with no teammate ancestor has no lead', () => {
  const rows: ProcessRow[] = [
    { pid: 10, ppid: 1, command: '/usr/local/bin/claude --dangerously-skip-permissions' },
    { pid: 30, ppid: 10, command: 'node main.ts dashboard session heartbeat' },
  ]

  assert.equal(findLeadSessionId(rows, 30), undefined)
})

test('findLeadSessionId: --parent-session-id without the teammate flags is not a teammate', () => {
  const rows: ProcessRow[] = [
    { pid: 10, ppid: 1, command: 'claude --parent-session-id lead-session-1' },
    { pid: 30, ppid: 10, command: 'node main.ts dashboard session heartbeat' },
  ]

  assert.equal(findLeadSessionId(rows, 30), undefined)
})

test('findLeadSessionId: a lead id outside the session-id shape is refused', () => {
  const rows: ProcessRow[] = [
    {
      pid: 10,
      ppid: 1,
      command: 'claude --agent-id a@t --agent-name a --team-name t --parent-session-id ../../etc',
    },
    { pid: 30, ppid: 10, command: 'node main.ts dashboard session heartbeat' },
  ]

  assert.equal(findLeadSessionId(rows, 30), undefined)
})

test('findLeadSessionId: a cycle in the table ends the walk', () => {
  const rows: ProcessRow[] = [
    { pid: 0, ppid: 0, command: 'kernel_task' },
    { pid: 30, ppid: 0, command: 'node main.ts dashboard session heartbeat' },
  ]

  assert.equal(findLeadSessionId(rows, 30), undefined)
})

test('findTeammateIdentity: names the teammate row two levels up, and nothing for a non-teammate or a teammate whose lead is itself', () => {
  const rows: ProcessRow[] = [
    { pid: 10, ppid: 1, command: TEAMMATE_COMMAND },
    { pid: 20, ppid: 10, command: '/bin/bash -c test-lock -- pnpm test' },
    { pid: 30, ppid: 20, command: 'node main.ts dashboard session turn-end' },
  ]

  assert.deepEqual(findTeammateIdentity(rows, 30, 'teammate-session-1'), {
    leadSessionId: 'lead-session-1',
    label: 'impl',
    pid: 10,
  })
  assert.equal(findTeammateIdentity(rows, 30, 'lead-session-1'), undefined)
  assert.equal(
    findTeammateIdentity(
      [
        { pid: 10, ppid: 1, command: '/usr/local/bin/claude --dangerously-skip-permissions' },
        { pid: 30, ppid: 10, command: 'node main.ts dashboard session turn-end' },
      ],
      30,
      'teammate-session-1'
    ),
    undefined
  )
})

test('parseProcessTable: reads pid, ppid and the whole command, skipping blank lines', () => {
  const rows = parseProcessTable(
    `  123    45 /bin/bash -c echo  two  spaces\n\n    7     1 launchd\n`
  )

  assert.deepEqual(rows, [
    { pid: 123, ppid: 45, command: '/bin/bash -c echo  two  spaces' },
    { pid: 7, ppid: 1, command: 'launchd' },
  ])
})
