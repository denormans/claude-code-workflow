import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { ensureDurableDir } from '../workflow-store/store.ts'

const LOCK_RETRY_DELAY_MS = 20
const LOCK_MAX_ATTEMPTS = 500
const LOCK_STALE_MS = 10_000
// A reaper holds only one read and one remove, so a crashed one is recovered well inside the wait budget.
const REAPER_STALE_MS = 1_000
const REAPER_RETRY_DELAY_MS = 5
const RELEASE_REAPER_ATTEMPTS = 400
const PAUSE_MAX_MS = 30_000

// Runs `fn` while holding an exclusive lock file beside the record it protects. Every critical
// section is a short read-modify-write, so a holder older than LOCK_STALE_MS, or whose process is
// gone, is stolen. A lock that cannot be taken within the wait budget runs `fn` unlocked rather than
// failing the hook or check that called it; `fn` is told whether the lock is held.
export const withRecordLock = <T>(recordPath: string, fn: (held: boolean) => T): T => {
  const lockPath = `${recordPath}.lock`
  const held = acquire(lockPath)
  try {
    return fn(held)
  } finally {
    if (held) {
      release(lockPath)
    }
  }
}

const acquire = (lockPath: string): boolean => {
  try {
    ensureDurableDir(dirname(lockPath))
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
      if (tryCreate(lockPath)) {
        return true
      }

      if (isStale(lockPath)) {
        pauseBeforeSteal()
        stealIfStale(lockPath)
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_DELAY_MS)
    }
  } catch {
    return false
  }

  return false
}

// Test hook, inert unless RECORD_LOCK_PAUSE_FILE is set: a waiter that found the holder stale writes
// `<file>.paused` and goes on once `<file>` exists.
const pauseBeforeSteal = (): void => {
  const gate = process.env.RECORD_LOCK_PAUSE_FILE
  if (gate === undefined) {
    return
  }

  writeFileSync(`${gate}.paused`, '')
  const deadline = Date.now() + PAUSE_MAX_MS
  while (!existsSync(gate) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

// Test hook, inert unless RECORD_LOCK_PAUSE_AFTER_JUDGING_FILE is set: a stealer that judged the
// holder stale writes `<file>.paused` and goes on once `<file>` exists.
const pauseAfterJudgingStale = (): void => {
  const gate = process.env.RECORD_LOCK_PAUSE_AFTER_JUDGING_FILE
  if (gate === undefined) {
    return
  }

  writeFileSync(`${gate}.paused`, '')
  const deadline = Date.now() + PAUSE_MAX_MS
  while (!existsSync(gate) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

const tryCreate = (lockPath: string): boolean => {
  try {
    const fd = openSync(lockPath, 'wx')
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }))
    } finally {
      closeSync(fd)
    }

    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }

    throw error
  }
}

const readHolder = (lockPath: string): { pid: number; acquiredAt: number } | null => {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      pid?: unknown
      acquiredAt?: unknown
    }

    return typeof parsed.pid === 'number' && typeof parsed.acquiredAt === 'number'
      ? { pid: parsed.pid, acquiredAt: parsed.acquiredAt }
      : null
  } catch {
    return null
  }
}

const isStale = (lockPath: string): boolean => {
  const holder = readHolder(lockPath)
  if (holder === null) {
    return isOldFile(lockPath)
  }

  return Date.now() - holder.acquiredAt > LOCK_STALE_MS || !isAlive(holder.pid)
}

// A lock with no readable holder is either being written right now or was abandoned between its
// creation and its write; only its age tells them apart.
const isOldFile = (lockPath: string, maxAgeMs: number = LOCK_STALE_MS): boolean => {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > maxAgeMs
  } catch {
    return false
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// A lock is removed by the process holding the reaper file, whether it is stealing a stale lock or
// releasing its own, so a steal removes the holder it judged stale and not a lock created since.
// Limit: a reaper older than REAPER_STALE_MS is taken over even if its owner is alive, so an owner
// suspended for longer than that between judging and removing can remove a lock taken meanwhile.
const stealIfStale = (lockPath: string): void => {
  withReaper(lockPath, 1, () => {
    if (isStale(lockPath)) {
      pauseAfterJudgingStale()
      rmSync(lockPath, { force: true })
    }
  })
}

const release = (lockPath: string): void => {
  withReaper(lockPath, RELEASE_REAPER_ATTEMPTS, () => {
    if (readHolder(lockPath)?.pid === process.pid) {
      rmSync(lockPath, { force: true })
    }
  })
}

// Runs `run` holding the reaper file, trying `attempts` times; a reaper left by a crashed process is
// removed once it is old. Without the reaper nothing runs.
const withReaper = (lockPath: string, attempts: number, run: () => void): void => {
  const reaper = `${lockPath}.reaper`
  for (let attempt = 0; attempt < attempts; attempt++) {
    let fd: number
    try {
      fd = openSync(reaper, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return
      }

      if (isOldFile(reaper, REAPER_STALE_MS)) {
        rmSync(reaper, { force: true })
      } else if (attempt + 1 < attempts) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, REAPER_RETRY_DELAY_MS)
      }

      continue
    }

    try {
      run()
    } finally {
      closeSync(fd)
      rmSync(reaper, { force: true })
    }

    return
  }
}
