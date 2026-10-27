import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookSource, ResolvedStep } from './config.ts'

export type RanStep = {
  name: string
  source: HookSource
  outcome: 'ok' | 'failed' | 'timeout'
  blocking: boolean
  exitCode: number | null
  durationMs: number
  outputTail: string
}

const OUTPUT_TAIL_LINES = 40
const OUTPUT_TAIL_CHARS = 4000

type Exit = { status: number | null; spawnError?: Error; timedOut: boolean }

// Runs one `run` step with `sh -c` in `cwd`. Both output streams go to one file, so the tail keeps
// stdout and stderr in the order the command wrote them, and a background process the command
// leaves holding its output cannot keep this call waiting the way an open pipe would. A timeout
// kills the shell's process group; a process the step moved into its own group (`set -m`,
// `setsid`) is outside it and is not killed.
export const runCommandStep = async (
  step: ResolvedStep,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<RanStep> => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-hooks-'))
  const outputPath = join(dir, 'output')
  const fd = openSync(outputPath, 'w')
  const started = Date.now()
  try {
    const exit = await spawnShell(step, cwd, env, fd)
    const spawnFailure =
      exit.spawnError !== undefined
        ? `\n[workflow-hooks] could not run the command: ${exit.spawnError.message}`
        : ''
    return {
      name: step.name,
      source: step.source,
      outcome: exit.timedOut ? 'timeout' : exit.status === 0 ? 'ok' : 'failed',
      blocking: step.blocking,
      exitCode: exit.timedOut ? null : exit.status,
      durationMs: Date.now() - started,
      outputTail: tail(readFileSync(outputPath, 'utf8') + spawnFailure),
    }
  } finally {
    closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  }
}

const spawnShell = (
  step: ResolvedStep,
  cwd: string,
  env: NodeJS.ProcessEnv,
  fd: number
): Promise<Exit> =>
  new Promise((resolve) => {
    const child = spawn('sh', ['-c', step.text], {
      cwd,
      env,
      stdio: ['ignore', fd, fd],
      detached: true,
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid)
    }, step.timeoutSeconds * 1000)

    child.on('error', (spawnError) => {
      clearTimeout(timer)
      resolve({ status: null, spawnError, timedOut: false })
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, timedOut })
    })
  })

const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) {
    return
  }

  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group already exited.
  }
}

const tail = (output: string): string =>
  output.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n').slice(-OUTPUT_TAIL_CHARS)
