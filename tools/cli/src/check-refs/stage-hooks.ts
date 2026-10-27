import { splitLines } from '../split-lines.ts'
import { MOMENT_CALL_SITES, MOMENT_IDS, isMomentId } from '../workflow-hooks/moments.ts'
import type { Finding } from './main.ts'

const CALL_RE = /workflow-hooks run --moment "?([^\s"`]+)"?/g
const REFERENCE_PATH = 'skills/workflow-guide/references/stage-hooks.md'

// A stage hook fires only where a skill's prose runs it, so a call site edited away silently stops
// that moment firing for everyone. A file MOMENT_CALL_SITES names must still run each of its
// moments, and no file may run a moment the CLI would refuse. A placeholder such as `"<moment>"` is
// documentation, not a call. A call-site file that is absent altogether is not flagged here: the
// check reads only files that exist, as every check-refs check does.
export const findStageHookFindings = (content: string, file: string): Finding[] => {
  const calls = findCalls(content)
  const unknown = calls
    .filter((call) => !isMomentId(call.moment))
    .map((call) =>
      stageHookFinding(
        file,
        call.line,
        call.col,
        call.moment,
        `use a moment id from MOMENT_IDS in tools/cli/src/workflow-hooks/moments.ts`
      )
    )
  const called = new Set(calls.map((call) => call.moment))
  const missing = MOMENT_IDS.filter(
    (id) => MOMENT_CALL_SITES[id].includes(file) && !called.has(id)
  ).map((id) =>
    stageHookFinding(
      file,
      1,
      1,
      `(no ${id} call)`,
      `run \`workflow-hooks run --moment ${id}\` at that moment in this file — ${REFERENCE_PATH}`
    )
  )
  return [...unknown, ...missing]
}

type Call = { moment: string; line: number; col: number }

const findCalls = (content: string): Call[] =>
  splitLines(content).flatMap((text, i) =>
    [...text.matchAll(CALL_RE)].flatMap((match) => {
      const moment = match[1] ?? ''
      return moment.startsWith('<') ? [] : [{ moment, line: i + 1, col: match.index + 1 }]
    })
  )

const stageHookFinding = (
  file: string,
  line: number,
  col: number,
  matched: string,
  fix: string
): Finding => ({ file, line, col, category: 'stage-hook', matched, fix })
