import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

// The MAIN checkout's root for a path inside a repo or any of its linked worktrees, or null outside
// git. `--git-common-dir` is what maps a linked worktree back to the main checkout: from every
// worktree it names the main checkout's `.git`. A bare repo's common dir is not named `.git` and has
// no checkout, so it is null too.
export const mainCheckoutRoot = (path: string): string | null => {
  const commonDir = gitOutput(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (commonDir === null || basename(commonDir) !== '.git') {
    return null
  }
  return canonicalPath(dirname(commonDir))
}

// The top level of the checkout `path` is in — a linked worktree's own root, not the main
// checkout's — or null outside git.
export const checkoutTopLevel = (path: string): string | null => {
  const topLevel = gitOutput(path, ['rev-parse', '--show-toplevel'])
  return topLevel === null ? null : canonicalPath(topLevel)
}

// The branch checked out at `path`, or null outside git and on a detached HEAD.
export const currentBranch = (path: string): string | null => {
  const branch = gitOutput(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return branch === null || branch === 'HEAD' ? null : branch
}

// realpath so a symlinked path and its target produce one answer. Returns null — never a lexical
// stand-in — when the path can't be resolved on disk: a lexical fallback would let a caller act on
// a location nothing has confirmed exists.
export const canonicalPath = (path: string): string | null => {
  try {
    return realpathSync(resolve(path))
  } catch {
    return null
  }
}

const gitOutput = (path: string, args: readonly string[]): string | null => {
  try {
    return execFileSync('git', ['-C', path, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}
