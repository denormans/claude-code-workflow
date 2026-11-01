import type { Role } from './attribution.ts'
import { formatNumber, formatTitle, renderTable } from './table.ts'

// A Read whose returned text is longer than this counts as large, whole and ranged Reads alike. The
// FLOW-455 baseline scan used the same cut for whole Reads only, so the whole-read figures of a run
// before the large-read gate and a run after it measure the same thing.
export const WHOLE_READ_MIN_CHARS = 24000

export type WholeReadRole = Role | 'subagent'

export type WholeReadRow = {
  role: WholeReadRole
  wholeReads: number
  chars: number
  rangedReads: number
  rangedChars: number
  refusals: number
  filesRefusedTwice: number
}

export type WholeReadReport = {
  minChars: number
  rows: WholeReadRow[]
}

export type WholeReadEvent =
  | { kind: 'whole-read'; sessionId: string; subagent: boolean; date: string; chars: number }
  | { kind: 'ranged-read'; sessionId: string; subagent: boolean; date: string; chars: number }
  | { kind: 'refusal'; sessionId: string; subagent: boolean; date: string; path: string }

type ReadCallKind = 'whole-read' | 'ranged-read'

export type WholeReadContext = { subagent: boolean; date: string | undefined }

export type WholeReadCollector = {
  add: (record: unknown, context: WholeReadContext) => void
  events: () => readonly WholeReadEvent[]
}

// Pairs each text-file Read call with its result, whole or ranged, and records every large-read
// gate refusal. Records are passed in as parsed and unchecked; anything not shaped like a tool call
// or result is skipped.
export const createWholeReadCollector = (): WholeReadCollector => {
  const readCalls = new Map<string, ReadCallKind>()
  const seenResults = new Set<string>()
  const events: WholeReadEvent[] = []

  const add = (record: unknown, context: WholeReadContext): void => {
    if (!isObject(record) || !isObject(record.message)) {
      return
    }

    const sessionId = record.sessionId ?? record.session_id
    const content = record.message.content
    if (typeof sessionId !== 'string' || !Array.isArray(content)) {
      return
    }

    for (const block of content) {
      if (!isObject(block)) {
        continue
      }

      const callKind = record.type === 'assistant' ? textReadKind(block) : undefined
      if (callKind !== undefined && typeof block.id === 'string') {
        readCalls.set(callKey(sessionId, block.id), callKind)
        continue
      }

      if (
        record.type !== 'user' ||
        block.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string' ||
        context.date === undefined
      ) {
        continue
      }

      const key = callKey(sessionId, block.tool_use_id)
      if (seenResults.has(key)) {
        continue
      }

      seenResults.add(key)
      const origin = { sessionId, subagent: context.subagent, date: context.date }
      const event = resultEvent(block, readCalls.get(key), origin)
      if (event !== undefined) {
        events.push(event)
      }
    }
  }

  return { add, events: () => events }
}

export const summarizeWholeReads = (
  events: readonly WholeReadEvent[],
  roleOf: (sessionId: string) => Role,
  inWindow: (date: string) => boolean
): WholeReadReport => {
  const rows = new Map<WholeReadRole, WholeReadRow>()
  const refusalsPerFile = new Map<string, number>()

  for (const event of events) {
    if (!inWindow(event.date)) {
      continue
    }

    const role: WholeReadRole = event.subagent ? 'subagent' : roleOf(event.sessionId)
    const row = rows.get(role) ?? emptyRow(role)
    rows.set(role, row)
    if (event.kind === 'whole-read') {
      row.wholeReads += 1
      row.chars += event.chars
      continue
    }

    if (event.kind === 'ranged-read') {
      row.rangedReads += 1
      row.rangedChars += event.chars
      continue
    }

    row.refusals += 1
    const fileKey = `${role}\u0000${event.sessionId}\u0000${event.path}`
    const refusals = (refusalsPerFile.get(fileKey) ?? 0) + 1
    refusalsPerFile.set(fileKey, refusals)
    if (refusals === 2) {
      row.filesRefusedTwice += 1
    }
  }

  const ordered = ROLE_ORDER.flatMap((role) => {
    const row = rows.get(role)
    return row === undefined ? [] : [row]
  })
  return { minChars: WHOLE_READ_MIN_CHARS, rows: ordered }
}

export const formatWholeReadTable = (report: WholeReadReport): string => {
  const headers = [
    'Role',
    'Whole Reads',
    'Characters',
    'Ranged Reads',
    'Ranged Characters',
    'Refusals',
    'Files Refused 2+',
  ]
  const values = report.rows.map((row) => [
    row.role,
    formatNumber(row.wholeReads),
    formatNumber(row.chars),
    formatNumber(row.rangedReads),
    formatNumber(row.rangedChars),
    formatNumber(row.refusals),
    formatNumber(row.filesRefusedTwice),
  ])
  const title = formatTitle(
    `Whole-File and Ranged Reads over ${formatNumber(report.minChars)} Characters, by Role`
  )
  return `${title}\n\n${renderTable(headers, values, WHOLE_READ_NUMERIC_COLUMNS)}\n`
}

export const formatWholeReadJson = (report: WholeReadReport): string =>
  `${JSON.stringify(report, null, 2)}\n`

// The harness prefixes a hook's refusal with "PreToolUse:<Tool> hook error: [<hook path>]: ", so the
// hook's own file name marks a refusal as this gate's.
const GATE_HOOK_MARKER = '/large-read-gate.sh]: '
const REFUSED_PATH = /Reading (.+?) whole is refused by the large-read gate/
// The extensions artifact-read-guard.sh owns; those reads are not this report's subject.
const ARTIFACT_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico|heic|avif|pdf)$/i
const ROLE_ORDER: readonly WholeReadRole[] = [
  'solo',
  'team-lead',
  'implementer',
  'senior-engineer',
  'other',
  'subagent',
]
const WHOLE_READ_NUMERIC_COLUMNS = new Set([1, 2, 3, 4, 5, 6])

const textReadKind = (block: Record<string, unknown>): ReadCallKind | undefined => {
  if (block.type !== 'tool_use' || block.name !== 'Read' || !isObject(block.input)) {
    return undefined
  }
  const input = block.input
  const filePath = input.file_path
  if (typeof filePath !== 'string' || ARTIFACT_EXTENSION.test(filePath)) {
    return undefined
  }
  const ranged =
    (input.offset !== undefined && input.offset !== null) ||
    (input.limit !== undefined && input.limit !== null)
  return ranged ? 'ranged-read' : 'whole-read'
}

const resultEvent = (
  block: Record<string, unknown>,
  callKind: ReadCallKind | undefined,
  origin: { sessionId: string; subagent: boolean; date: string }
): WholeReadEvent | undefined => {
  const text = resultText(block.content)
  if (block.is_error === true) {
    if (!text.includes(GATE_HOOK_MARKER)) {
      return undefined
    }
    const path = REFUSED_PATH.exec(text)?.[1]
    return path === undefined ? undefined : { kind: 'refusal', ...origin, path }
  }
  return callKind !== undefined && text.length > WHOLE_READ_MIN_CHARS
    ? { kind: callKind, ...origin, chars: text.length }
    : undefined
}

const resultText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

const emptyRow = (role: WholeReadRole): WholeReadRow => ({
  role,
  wholeReads: 0,
  chars: 0,
  rangedReads: 0,
  rangedChars: 0,
  refusals: 0,
  filesRefusedTwice: 0,
})

const callKey = (sessionId: string, toolUseId: string): string => `${sessionId}\u0000${toolUseId}`

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
