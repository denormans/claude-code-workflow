import { execFileSync } from 'node:child_process'
import { GIT_MAX_BUFFER_BYTES } from './git-exec.ts'
import type { ProofCaptureEvent, ProofLedger } from './ledger.ts'

export type SliceState = 'ok' | 'missing' | 'failing' | 'out-of-order' | 'late'

export interface SliceRow {
  task: string
  state: SliceState
  captureId?: string
  captureSha?: string
  reason?: string
}

export interface BranchCommit {
  sha: string
  committedAt: number
}

// A plan's slices, in plan order, read against the branch's own commits, oldest first. A slice is
// `ok` when every `slice` capture it has on a commit of the branch is valid — one invalid capture
// fails the slice even beside a later valid one — and the earliest of them is after the previous
// slice's and was recorded before the commit that follows it was made. The earliest is the one the
// next slice began after.
export const checkSlices = (
  ledger: ProofLedger,
  slices: string[],
  commits: BranchCommit[],
  invalidReason: (c: ProofCaptureEvent) => string | undefined
): SliceRow[] => {
  const position = new Map(commits.map((commit, index) => [commit.sha, index]))
  let previous = -1

  return slices.map((task): SliceRow => {
    const placed = placedSliceCaptures(ledger, task, position)
    const invalid = placed.find((p) => invalidReason(p.capture) !== undefined)

    if (invalid !== undefined) {
      return {
        task,
        captureId: invalid.capture.id,
        captureSha: invalid.capture.sha,
        state: 'failing',
        reason: invalidReason(invalid.capture),
      }
    }

    const earliest = placed[0]

    if (earliest === undefined) {
      return {
        task,
        state: 'missing',
        reason: 'no slice capture under this task on a commit between origin/main and --sha',
      }
    }

    const row = { task, captureId: earliest.capture.id, captureSha: earliest.capture.sha }

    if (earliest.index <= previous) {
      return {
        ...row,
        state: 'out-of-order',
        reason: "this slice's capture is not on a commit after the previous slice's capture",
      }
    }

    previous = earliest.index

    const next = commits[earliest.index + 1]
    const recordedAt = Math.floor(Date.parse(earliest.capture.at) / 1000)

    if (next !== undefined && next.committedAt < recordedAt) {
      return {
        ...row,
        state: 'late',
        reason:
          `recorded at ${earliest.capture.at}, after ${next.sha}, the next commit, was made at ` +
          new Date(next.committedAt * 1000).toISOString(),
      }
    }

    return { ...row, state: 'ok' }
  })
}

// The commits origin/main does not have, on --sha's first-parent line, oldest first, each with its
// committer time in unix seconds — git's own precision, which is why a capture's time is compared
// at whole seconds. Null when origin/main or --sha does not resolve here.
export const listBranchCommits = (repoRoot: string, sha: string): BranchCommit[] | null => {
  try {
    return execFileSync(
      'git',
      ['log', '--reverse', '--first-parent', '--format=%H %ct', `origin/main..${sha}`],
      { cwd: repoRoot, stdio: 'pipe', maxBuffer: GIT_MAX_BUFFER_BYTES }
    )
      .toString()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [commitSha = '', committedAt = ''] = line.split(' ')
        return { sha: commitSha, committedAt: Number(committedAt) }
      })
  } catch {
    return null
  }
}

interface PlacedCapture {
  capture: ProofCaptureEvent
  index: number
}

const placedSliceCaptures = (
  ledger: ProofLedger,
  task: string,
  position: ReadonlyMap<string, number>
): PlacedCapture[] =>
  ledger.captures
    .flatMap((capture): PlacedCapture[] => {
      const index = position.get(capture.sha)
      return capture.task === task && capture.capture === 'slice' && index !== undefined
        ? [{ capture, index }]
        : []
    })
    .sort((a, b) => a.index - b.index || a.capture.at.localeCompare(b.capture.at))
