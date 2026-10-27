import { homedir } from 'node:os'
import { join } from 'node:path'
import { canonicalPath, checkoutTopLevel, currentBranch, mainCheckoutRoot } from '../git-paths.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { loadHooksFiles, resolveSteps } from './config.ts'
import type { ConfigProblem, HooksFileLocation, ResolvedStep } from './config.ts'
import { MOMENT_IDS } from './moments.ts'
import type { MomentId } from './moments.ts'
import { runCommandStep } from './run.ts'
import type { RanStep } from './run.ts'

export type RunOptions = {
  moment: string
  ticket?: string
  pr?: string
  testsOutcome?: 'pass' | 'fail'
}

export type ListOptions = { moment?: string; json: boolean }

const HOOKS_FILE_NAME = 'workflow-hooks.json'
const LOCAL_HOOKS_FILE_NAME = 'workflow-hooks.local.json'
const CONFIG_INVALID_EXIT = 1
const BLOCKING_FAILURE_EXIT = 3

// Commands run first, in resolution order; instructions come back only once every blocking command
// passed, because the agent carries them out after this process has exited. A blocking failure
// stops the moment there: no later command runs and no instruction is returned.
export const runWorkflowHooksRun = async (options: RunOptions): Promise<void> => {
  const moment = MOMENT_IDS.find((id) => id === options.moment)
  if (moment === undefined) {
    refuseUnknownMoment(options.moment)
    return
  }
  const place = locate(process.cwd())
  const loaded = loadHooksFiles(place.files)
  if (!loaded.ok) {
    refuseInvalidConfig(loaded.problems)
    return
  }

  const steps = resolveSteps(loaded.files, moment).filter((step) => step.disabledBy.length === 0)
  const env = hookEnv(moment, place, options)
  const ran: RanStep[] = []
  for (const step of steps.filter((candidate) => candidate.kind === 'run')) {
    const result = await runCommandStep(step, place.workingDir, env)
    ran.push(result)
    console.error(formatRanLine(moment, result))
    if (result.blocking && result.outcome !== 'ok') {
      emitJson({ moment, ran, instructions: [] })
      setRequestedExitCode(BLOCKING_FAILURE_EXIT)
      return
    }
  }

  const instructions = steps
    .filter((step) => step.kind === 'instruct')
    .map((step) => ({
      name: step.name,
      source: step.source,
      blocking: step.blocking,
      text: step.text,
    }))
  emitJson({ moment, ran, instructions })
  setRequestedExitCode(0)
}

export const runWorkflowHooksList = (options: ListOptions): void => {
  const moment = MOMENT_IDS.find((id) => id === options.moment)
  if (options.moment !== undefined && moment === undefined) {
    refuseUnknownMoment(options.moment)
    return
  }
  const place = locate(process.cwd())
  const loaded = loadHooksFiles(place.files)
  if (!loaded.ok) {
    refuseInvalidConfig(loaded.problems)
    return
  }

  const files = place.files.map((location) => ({
    ...location,
    present: loaded.files.some((file) => file.path === location.path),
  }))
  const steps = resolveSteps(loaded.files, moment).map((step) => ({
    moment: step.moment,
    name: step.name,
    source: step.source,
    kind: step.kind,
    blocking: step.blocking,
    disabledBy: step.disabledBy,
  }))
  if (options.json) {
    emitJson({ files, steps })
  } else {
    process.stdout.write(formatList(files, resolveSteps(loaded.files, moment)))
  }
  setRequestedExitCode(0)
}

type Place = {
  files: HooksFileLocation[]
  workingDir: string
  projectRoot: string
  worktree: string | null
  branch: string | null
}

// Project files come from the MAIN checkout, never the worktree: `.claude/` is git-ignored in many
// repos, and a git-ignored file never reaches a linked worktree. Outside git there is no main
// checkout, so both come from the launch directory. bin/workflow-hooks resolves the same three
// paths for its no-hooks short-circuit; a change here is a change there.
const locate = (cwd: string): Place => {
  const launchDir = canonicalPath(cwd) ?? cwd
  const projectRoot = mainCheckoutRoot(launchDir) ?? launchDir
  const worktree = checkoutTopLevel(launchDir)
  return {
    files: [
      { source: 'user', path: join(userConfigDir(), HOOKS_FILE_NAME) },
      { source: 'project', path: join(projectRoot, '.claude', HOOKS_FILE_NAME) },
      { source: 'local', path: join(projectRoot, '.claude', LOCAL_HOOKS_FILE_NAME) },
    ],
    workingDir: worktree ?? launchDir,
    projectRoot,
    worktree,
    branch: currentBranch(launchDir),
  }
}

// Claude Code's own config directory: CLAUDE_CONFIG_DIR when set, else ~/.claude. An empty value
// counts as unset, matching the `${CLAUDE_CONFIG_DIR:-…}` expansion in bin/workflow-hooks.
const userConfigDir = (): string => {
  const configured = process.env.CLAUDE_CONFIG_DIR
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.claude')
}

// Every WORKFLOW_* variable this tool owns is cleared first, so a value inherited from the caller is
// never mistaken for one this moment supplied. A value the tool doesn't know stays unset, never
// empty.
const hookEnv = (moment: MomentId, place: Place, options: RunOptions): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const values: Record<HookEnvName, string | null | undefined> = {
    WORKFLOW_MOMENT: moment,
    WORKFLOW_TICKET: options.ticket,
    WORKFLOW_BRANCH: place.branch,
    WORKFLOW_WORKTREE: place.worktree,
    WORKFLOW_PROJECT_ROOT: place.projectRoot,
    WORKFLOW_PR_URL: options.pr,
    WORKFLOW_TESTS_OUTCOME: options.testsOutcome,
  }
  for (const name of HOOK_ENV_NAMES) {
    const value = values[name]
    if (value === null || value === undefined) {
      delete env[name]
    } else {
      env[name] = value
    }
  }
  return env
}

const HOOK_ENV_NAMES = [
  'WORKFLOW_MOMENT',
  'WORKFLOW_TICKET',
  'WORKFLOW_BRANCH',
  'WORKFLOW_WORKTREE',
  'WORKFLOW_PROJECT_ROOT',
  'WORKFLOW_PR_URL',
  'WORKFLOW_TESTS_OUTCOME',
] as const

type HookEnvName = (typeof HOOK_ENV_NAMES)[number]

const refuseUnknownMoment = (moment: string): void => {
  console.error(
    `‼ workflow-hooks: unknown moment "${moment}" — the moments are ${MOMENT_IDS.join(', ')}`
  )
  emitJson({ error: `unknown moment "${moment}"`, moments: MOMENT_IDS })
  setRequestedExitCode(CONFIG_INVALID_EXIT)
}

const refuseInvalidConfig = (problems: readonly ConfigProblem[]): void => {
  for (const problem of problems) {
    console.error(`‼ workflow-hooks: ${problem.file}: ${problem.field} ${problem.message}`)
  }
  emitJson({ error: 'invalid workflow hooks config', problems })
  setRequestedExitCode(CONFIG_INVALID_EXIT)
}

const formatRanLine = (moment: MomentId, ran: RanStep): string => {
  const marker = ran.outcome === 'ok' ? '✓' : '✗'
  const exit = ran.outcome === 'failed' && ran.exitCode !== null ? `, exit ${ran.exitCode}` : ''
  return `${marker} workflow-hooks: ${moment} ${ran.name} (${ran.source}) ${ran.outcome} in ${ran.durationMs}ms${exit}`
}

const formatList = (
  files: ReadonlyArray<HooksFileLocation & { present: boolean }>,
  steps: readonly ResolvedStep[]
): string => {
  const fileLines = files.map(
    (file) => `  ${file.source.padEnd(8)} ${file.path}${file.present ? '' : ' (not present)'}`
  )
  const stepLines = MOMENT_IDS.flatMap((id) => {
    const forMoment = steps.filter((step) => step.moment === id)
    return forMoment.length === 0 ? [] : ['', id, ...forMoment.map(formatStepLine)]
  })
  const body = stepLines.length === 0 ? ['', 'No steps configured.'] : stepLines
  return ['Hook files:', ...fileLines, ...body].join('\n') + '\n'
}

const formatStepLine = (step: ResolvedStep): string => {
  const disabled =
    step.disabledBy.length === 0 ? '' : `  (disabled by ${step.disabledBy.join(' and ')})`
  const blocking = step.blocking ? 'blocking' : 'warn'
  return `  ${step.source.padEnd(8)} ${step.kind.padEnd(9)} ${blocking.padEnd(9)} ${step.name}${disabled}`
}

const emitJson = (value: unknown): void => {
  process.stdout.write(JSON.stringify(value) + '\n')
}
