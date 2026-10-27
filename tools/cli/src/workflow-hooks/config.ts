import { readFileSync } from 'node:fs'
import { MOMENT_IDS, isMomentId } from './moments.ts'
import type { MomentId } from './moments.ts'

export type HookSource = 'user' | 'project' | 'local'

export type HooksFileLocation = { source: HookSource; path: string }

export type HookStep = {
  moment: MomentId
  name: string
  source: HookSource
  kind: 'run' | 'instruct'
  // The shell command for a `run` step, the instruction for an `instruct` step.
  text: string
  blocking: boolean
  timeoutSeconds: number
}

export type HooksFile = HooksFileLocation & { steps: HookStep[]; disable: string[] }

export type ResolvedStep = HookStep & { disabledBy: HookSource[] }

export type ConfigProblem = { file: string; field: string; message: string }

export type LoadResult = { ok: true; files: HooksFile[] } | { ok: false; problems: ConfigProblem[] }

const DEFAULT_TIMEOUT_SECONDS = 300
const MAX_TIMEOUT_SECONDS = 86400
const FILE_KEYS: readonly string[] = ['version', 'hooks', 'disable']
const STEP_KEYS: readonly string[] = ['name', 'run', 'instruct', 'blocking', 'timeoutSeconds']
const SOURCE_ORDER: readonly HookSource[] = ['user', 'project', 'local']

// Every problem in every file is collected before refusing, so one run names everything to fix. An
// absent file is not a problem: it contributes no steps.
export const loadHooksFiles = (locations: readonly HooksFileLocation[]): LoadResult => {
  const problems: ConfigProblem[] = []
  const files = locations.flatMap((location) => {
    const file = loadHooksFile(location, (field, message) => {
      problems.push({ file: location.path, field, message })
    })
    return file === null ? [] : [file]
  })
  return problems.length > 0 ? { ok: false, problems } : { ok: true, files }
}

// Moment order first, then user → shared project → private project within a moment. A user step
// named in a project file's `disable` stays in the list, marked, so `list` can show it switched off;
// `run` skips it.
export const resolveSteps = (files: readonly HooksFile[], moment?: MomentId): ResolvedStep[] => {
  const disablers = files.filter((file) => file.source !== 'user')
  return MOMENT_IDS.filter((id) => moment === undefined || id === moment).flatMap((id) =>
    SOURCE_ORDER.flatMap((source) =>
      files
        .filter((file) => file.source === source)
        .flatMap((file) => file.steps.filter((step) => step.moment === id))
    ).map((step) => ({
      ...step,
      disabledBy:
        step.source === 'user'
          ? disablers.filter((file) => file.disable.includes(step.name)).map((file) => file.source)
          : [],
    }))
  )
}

type Report = (field: string, message: string) => void

const loadHooksFile = (location: HooksFileLocation, report: Report): HooksFile | null => {
  const raw = readIfPresent(location.path, report)
  if (raw === null) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    report('(file)', `is not valid JSON: ${errorMessage(error)}`)
    return null
  }
  if (!isRecord(parsed)) {
    report('(file)', 'must be a JSON object')
    return null
  }

  for (const key of Object.keys(parsed)) {
    if (!FILE_KEYS.includes(key)) {
      report(key, 'is not a known key')
    }
  }
  if (parsed.version !== 1) {
    report('version', 'must be 1')
  }
  const steps = readSteps(parsed.hooks, location.source, report)
  reportDuplicateNames(steps, report)
  const disable = readDisable(parsed.disable, location.source, report)
  return { ...location, steps, disable }
}

// Absent is the normal case and reads as no file. Present but unreadable — a directory at the path,
// say — is a problem, never silently treated as absent.
const readIfPresent = (path: string, report: Report): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      report('(file)', `could not be read: ${errorMessage(error)}`)
    }
    return null
  }
}

const readSteps = (hooks: unknown, source: HookSource, report: Report): HookStep[] => {
  if (!isRecord(hooks)) {
    report('hooks', 'must be an object mapping moment ids to lists of steps')
    return []
  }
  return Object.entries(hooks).flatMap(([moment, steps]) => {
    if (!isMomentId(moment)) {
      report(`hooks.${moment}`, `is not a moment; the moments are ${MOMENT_IDS.join(', ')}`)
      return []
    }
    if (!Array.isArray(steps)) {
      report(`hooks.${moment}`, 'must be a list of steps')
      return []
    }
    return steps.flatMap((raw: unknown, i) => {
      const step = readStep(raw, moment, source, `hooks.${moment}[${i}]`, report)
      return step === null ? [] : [step]
    })
  })
}

const readStep = (
  raw: unknown,
  moment: MomentId,
  source: HookSource,
  field: string,
  report: Report
): HookStep | null => {
  if (!isRecord(raw)) {
    report(field, 'must be an object')
    return null
  }

  const failures: Array<[key: string, message: string]> = []
  for (const key of Object.keys(raw)) {
    if (!STEP_KEYS.includes(key)) {
      failures.push([key, 'is not a known key'])
    }
  }
  const { name, run, instruct, blocking, timeoutSeconds } = raw
  if (!isNonBlankString(name)) {
    failures.push(['name', 'must be a non-blank string'])
  }
  if ((run === undefined) === (instruct === undefined)) {
    failures.push(['run', 'set exactly one of run or instruct'])
  }
  if (run !== undefined && !isNonBlankString(run)) {
    failures.push(['run', 'must be a non-blank string'])
  }
  if (instruct !== undefined && !isNonBlankString(instruct)) {
    failures.push(['instruct', 'must be a non-blank string'])
  }
  if (blocking !== undefined && typeof blocking !== 'boolean') {
    failures.push(['blocking', 'must be true or false'])
  }
  if (timeoutSeconds !== undefined && run === undefined) {
    failures.push(['timeoutSeconds', 'applies to run steps only'])
  }
  if (timeoutSeconds !== undefined && !isTimeoutSeconds(timeoutSeconds)) {
    failures.push(['timeoutSeconds', 'must be a whole number of seconds from 1 to 86400'])
  }
  for (const [key, message] of failures) {
    report(`${field}.${key}`, message)
  }

  const text = isNonBlankString(run) ? run : isNonBlankString(instruct) ? instruct : null
  if (failures.length > 0 || !isNonBlankString(name) || text === null) {
    return null
  }
  return {
    moment,
    name,
    source,
    kind: isNonBlankString(run) ? 'run' : 'instruct',
    text,
    blocking: blocking === true,
    timeoutSeconds: isTimeoutSeconds(timeoutSeconds) ? timeoutSeconds : DEFAULT_TIMEOUT_SECONDS,
  }
}

// Names are unique across the whole file, not per moment: `disable` and every report name a step
// by its name alone.
const reportDuplicateNames = (steps: readonly HookStep[], report: Report): void => {
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step.name)) {
      report(
        `hooks.${step.moment}`,
        `repeats the step name "${step.name}"; names are unique in a file`
      )
    }
    seen.add(step.name)
  }
}

// Only a project file can switch off a user step. In the user file the key could only switch off
// the user's own steps, which they can delete instead, so it is refused rather than honoured.
const readDisable = (disable: unknown, source: HookSource, report: Report): string[] => {
  if (disable === undefined) {
    return []
  }
  if (source === 'user') {
    report('disable', 'is for project files only; delete the step from this file instead')
    return []
  }
  if (!Array.isArray(disable) || !disable.every(isNonBlankString)) {
    report('disable', 'must be a list of step names')
    return []
  }
  return disable
}

const isNonBlankString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

const isTimeoutSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TIMEOUT_SECONDS

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
