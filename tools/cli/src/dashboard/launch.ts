import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { flagValueArgs, invokeDashboardRaw } from './invoke.ts'

const LINK_PREFIX = 'agent-session://launch?'
const DEFAULT_OPEN_TIMEOUT_MS = 10_000
const NO_BOARD_EXIT_CODE = 3

export interface SessionLaunchFlags {
  directory: string
  title: string
  'prompt-file': string
}

// The signed link is a credential until it expires, so no path below prints it, including the
// failure from `open`, whose own stderr can repeat its argument.
export const runSessionLaunch = (flags: SessionLaunchFlags): void => {
  const invocation = invokeDashboardRaw([
    'launch-link',
    ...flagValueArgs('--directory', flags.directory),
    ...flagValueArgs('--title', flags.title),
    // The app runs from the home directory, so a relative path would resolve against the wrong place.
    ...flagValueArgs('--prompt-file', fromCallerDirectory(flags['prompt-file'])),
  ])

  if (invocation === null) {
    refuseLaunch('the board app is not available', NO_BOARD_EXIT_CODE)
    return
  }

  if (invocation.status !== 0) {
    refuseLaunch(invocation.detail, 1)
    return
  }

  const link = parseLaunchLink(invocation.stdout)

  if (link === null) {
    refuseLaunch('the board app returned an unreadable launch link', 1)
    return
  }

  const opened = spawnSync('open', [link.url], {
    timeout: openTimeoutMs(),
    killSignal: 'SIGKILL',
    cwd: homedir(),
    stdio: 'ignore',
  })

  if (opened.signal !== null || isTimeout(opened.error)) {
    reportUnknownOutcome(opened.signal ?? 'timed out')
    return
  }

  if (opened.status === null) {
    refuseLaunch('open could not be started', 1)
    return
  }

  if (opened.status !== 0) {
    refuseLaunch(
      `open could not hand the link to the Agent Session handler (exit ${String(opened.status)})`,
      1
    )
    return
  }

  process.stdout.write(`${JSON.stringify({ sessionId: link.sessionId })}\n`)
}

const fromCallerDirectory = (path: string): string => {
  if (isAbsolute(path)) {
    return path
  }

  return `${process.cwd().replace(/\/$/, '')}/${path}`
}

const openTimeoutMs = (): number => {
  const value = process.env.DASHBOARD_OPEN_TIMEOUT_MS ?? ''

  return /^[1-9]\d{0,8}$/.test(value) ? Number(value) : DEFAULT_OPEN_TIMEOUT_MS
}

const parseLaunchLink = (stdout: string): { url: string; sessionId: string } | null => {
  let parsed: unknown

  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }

  if (!('url' in parsed) || !('sessionId' in parsed)) {
    return null
  }

  const { url, sessionId } = parsed

  if (typeof url !== 'string' || typeof sessionId !== 'string') {
    return null
  }

  return url.startsWith(LINK_PREFIX) ? { url, sessionId } : null
}

const isTimeout = (error: Error | undefined): boolean =>
  error !== undefined && 'code' in error && error.code === 'ETIMEDOUT'

const reportUnknownOutcome = (reason: string): void => {
  process.stderr.write(
    `dashboard: session launch outcome unknown: open did not finish (${reason}). The link may ` +
      `have reached the Agent Session handler, so a session may have started; check the board ` +
      `before running this command again\n`
  )
  setRequestedExitCode(1)
}

const refuseLaunch = (reason: string, exitCode: number): void => {
  process.stderr.write(`dashboard: session launch started nothing: ${reason}\n`)
  setRequestedExitCode(exitCode)
}
