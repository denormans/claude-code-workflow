import { parseTeammateArgv, readPsOutput } from '../process-table.ts'

// A teammate's Claude process is launched with the session id of the lead that spawned it on its
// command line (`--parent-session-id`). Whatever this CLI is run by inside a teammate session (the
// wake mod's beat, or a Bash call such as test-lock) descends from that process, so walking up the
// process tree finds it. The id names the lead's session as of the teammate's spawn: it does not
// follow the lead into a later session id.

const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]+$/

export interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

export interface TeammateIdentity {
  leadSessionId: string
  label: string
  pid: number
}

// null when the process table could not be read, which is not the same as having no lead.
export const resolveLeadSessionId = (): string | undefined | null => {
  const rows = readProcessRows()
  return rows === null ? null : findLeadSessionId(rows, process.pid)
}

// The teammate this process runs under: the nearest ancestor whose command line carries the teammate
// flags, unless its recorded lead is `rawId` itself. undefined when there is no such ancestor or its
// lead is `rawId`; no further ancestor is consulted. null when the process table could not be read.
export const resolveTeammateIdentity = (rawId: string): TeammateIdentity | undefined | null => {
  const rows = readProcessRows()
  return rows === null ? null : findTeammateIdentity(rows, process.pid, rawId)
}

// Exported for the unit test, which hands it a process table rather than a real one.
export const findLeadSessionId = (rows: ProcessRow[], startPid: number): string | undefined =>
  findTeammateAncestor(rows, startPid)?.leadSessionId

// Exported for the unit test.
export const findTeammateIdentity = (
  rows: ProcessRow[],
  startPid: number,
  rawId: string
): TeammateIdentity | undefined => {
  const ancestor = findTeammateAncestor(rows, startPid)
  return ancestor !== undefined && ancestor.leadSessionId !== rawId ? ancestor : undefined
}

// Exported for the unit test.
export const parseProcessTable = (psOutput: string): ProcessRow[] =>
  psOutput.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) {
      return []
    }

    const [, pid, ppid, command] = match
    return [{ pid: Number(pid), ppid: Number(ppid), command }]
  })

const readProcessRows = (): ProcessRow[] | null => {
  const psOutput = readPsOutput('pid=,ppid=,command=')
  return psOutput === null ? null : parseProcessTable(psOutput)
}

// The nearest process, starting at `startPid` and walking up, whose command line names a lead.
const findTeammateAncestor = (
  rows: ProcessRow[],
  startPid: number
): TeammateIdentity | undefined => {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const visited = new Set<number>()
  let row = byPid.get(startPid)
  while (row !== undefined && !visited.has(row.pid)) {
    visited.add(row.pid)
    const argv = parseTeammateArgv(row.command)
    const lead = teammateLeadId(row.command)
    if (argv !== undefined && lead !== undefined) {
      return {
        leadSessionId: lead,
        label: argv.agentId.split('@')[0] ?? argv.agentId,
        pid: row.pid,
      }
    }

    row = byPid.get(row.ppid)
  }

  return undefined
}

const teammateLeadId = (command: string): string | undefined => {
  const lead = parseTeammateArgv(command)?.parentSessionId
  return lead !== undefined && SESSION_ID_SHAPE.test(lead) ? lead : undefined
}
