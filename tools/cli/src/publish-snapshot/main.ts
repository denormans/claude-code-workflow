import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { git, run, PublishCheckCannotRun } from '../publish-check/git.ts'
import { publishCheck, reportFindings } from '../publish-check/main.ts'
import type { Finding } from '../publish-check/scan.ts'
import { privateTextMatches } from '../publish-check/scan.ts'
import { readPrivateTerms } from '../publish-check/terms.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

export interface PublishSnapshotFlags {
  to: string
  repo: string
  url?: string
}

export const runPublishSnapshot = (flags: PublishSnapshotFlags): void => {
  try {
    const outcome = publishSnapshot(flags)
    if (outcome.kind === 'findings') {
      reportFindings(outcome.findings)
      return
    }

    process.stdout.write(JSON.stringify(outcome.result) + '\n')
    setRequestedExitCode(0)
  } catch (error) {
    const reason = error instanceof PublishCheckCannotRun ? error.message : String(error)
    console.error(`publish-snapshot: refused: ${reason.replace(/\s+/g, ' ')}`)
    setRequestedExitCode(REFUSED_EXIT)
  }
}

interface Release {
  sha: string
  version: string
}

interface PublishResult {
  ok: true
  published: boolean
  to: string
  version: string
  commit: string
}

type Outcome = { kind: 'findings'; findings: Finding[] } | { kind: 'done'; result: PublishResult }

const publishSnapshot = (flags: PublishSnapshotFlags): Outcome => {
  if (!TARGET_PATTERN.test(flags.to)) {
    throw refused(`--to must be owner/name, got ${flags.to}`)
  }

  const url = flags.url ?? snapshotUrl(flags.repo, flags.to)
  refuseOwnOrigin(flags.repo, flags.to, url)
  const release = confirmRelease(flags.repo)

  const check = publishCheck(flags.repo, release.sha)
  if (check.findings.length > 0) {
    return { kind: 'findings', findings: check.findings }
  }

  return { kind: 'done', result: replaceSnapshot(flags, url, release) }
}

// The command overwrites the target's whole tree, so pointing it at the source would be destructive.
// The url is compared by what it names, not how it is spelled.
const refuseOwnOrigin = (repo: string, to: string, url: string): void => {
  const origin = originUrl(repo)
  const targetRepo = ownerRepo(url)?.toLowerCase()
  const originRepo = ownerRepo(origin)?.toLowerCase()
  const namesOrigin =
    url === origin ||
    originRepo === to.toLowerCase() ||
    (targetRepo !== undefined && targetRepo === originRepo) ||
    namesSourceRepository(repo, origin, url)
  if (namesOrigin) {
    throw refused(`${to} is this repository's own origin`)
  }
}

const namesSourceRepository = (repo: string, origin: string, url: string): boolean => {
  const target = realLocalPath(url)
  if (target === undefined) {
    return false
  }

  const own = [
    realLocalPath(resolve(repo, origin)),
    realLocalPath(git(repo, ['rev-parse', '--show-toplevel'], 'not a work tree').trim()),
    realLocalPath(
      resolve(repo, git(repo, ['rev-parse', '--git-common-dir'], 'no git directory').trim())
    ),
  ]

  return own.includes(target)
}

const realLocalPath = (location: string): string | undefined => {
  const path = location.startsWith('file://') ? fileURLToPath(location) : location
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

// HEAD must be exactly the released commit: the tip of origin/main, clean, and named by its version's
// release tag.
const confirmRelease = (repo: string): Release => {
  git(repo, ['fetch', '--quiet', 'origin', 'main'], 'git fetch origin main failed')
  const sha = revParse(repo, 'HEAD')
  const mainSha = revParse(repo, 'refs/remotes/origin/main')
  if (sha !== mainSha) {
    throw refused(`HEAD ${sha} is not the tip of origin/main (${mainSha})`)
  }

  const status = git(repo, ['status', '--porcelain', '--untracked-files=no'], 'git status failed')
  if (status.trim().length > 0) {
    throw refused('the working tree has uncommitted changes')
  }

  const version = pluginVersion(repo, sha)
  const tag = `${RELEASE_TAG_PREFIX}${version}`
  if (!succeeds(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`])) {
    throw refused(`no release tag ${tag}`)
  }

  const tagged = revParse(repo, `refs/tags/${tag}^{commit}`)
  if (tagged !== sha) {
    throw refused(`release tag ${tag} names ${tagged}, not HEAD ${sha}`)
  }

  return { sha, version }
}

const replaceSnapshot = (
  flags: PublishSnapshotFlags,
  url: string,
  release: Release
): PublishResult => {
  const identity = maintainerConfig(flags.repo)
  const work = mkdtempSync(join(tmpdir(), 'publish-snapshot-'))
  try {
    const clone = join(work, 'snapshot')
    const tarPath = join(work, 'export.tar')
    run('git', ['clone', '--quiet', '--', url, clone], `could not clone ${url}`)

    if (succeeds(clone, ['cat-file', '-e', `${release.sha}^{commit}`])) {
      throw refused(`${flags.to} already holds this repository's history`)
    }

    checkOutMain(clone)
    git(
      clone,
      ['rm', '-r', '-q', '-f', '--ignore-unmatch', '--', '.'],
      'could not clear the snapshot tree'
    )
    git(flags.repo, ['archive', '--format=tar', '-o', tarPath, release.sha], 'git archive failed')
    run('tar', ['-xf', tarPath, '-C', clone], 'could not extract the export set')
    git(clone, ['add', '--all', '--force'], 'git add failed')

    const hasHead = succeeds(clone, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (hasHead && succeeds(clone, ['diff', '--cached', '--quiet'])) {
      return result(flags.to, release.version, false, revParse(clone, 'HEAD'))
    }

    const tag = `v${release.version}`
    const message = releaseMessage(tag, coAuthors(flags.repo, clone, hasHead, release.sha))
    git(clone, [...identity, 'commit', '-q', ...message], 'git commit failed')
    git(clone, [...identity, 'tag', tag], `could not tag ${tag}`)
    git(
      clone,
      ['push', '--atomic', '--quiet', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`],
      `could not push to ${url}`
    )

    return result(flags.to, release.version, true, revParse(clone, 'HEAD'))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// A clone checks out whatever branch the target advertises, but the snapshot's history is its main:
// continue from origin/main, or start a root commit when there is none.
const checkOutMain = (clone: string): void => {
  if (succeeds(clone, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'])) {
    git(
      clone,
      ['checkout', '-q', '-B', 'main', 'refs/remotes/origin/main'],
      'could not check out main'
    )
    return
  }

  git(clone, ['symbolic-ref', 'HEAD', 'refs/heads/main'], 'could not start main')
}

// Each -m is its own paragraph, so the trailers form the message's last paragraph, where git reads
// them.
const releaseMessage = (tag: string, trailers: readonly string[]): string[] =>
  trailers.length === 0
    ? ['-m', `release: ${tag}`]
    : [
        '-m',
        `release: ${tag}`,
        '-m',
        trailers.map((value) => `Co-authored-by: ${value}`).join('\n'),
      ]

// The co-authors of every source commit since the release the snapshot last published, so a
// release that left the snapshot unchanged still has its credit carried by the next one that
// pushes. A bot account or a Claude model is withheld, and so is a trailer naming a private term,
// and the committer, who is already the release commit's author.
const coAuthors = (repo: string, clone: string, hasHead: boolean, sha: string): string[] => {
  const since = hasHead ? lastPublishedVersion(clone) : undefined
  if (since === undefined) {
    return []
  }

  const sourceTag = `${RELEASE_TAG_PREFIX}${since}`
  if (!succeeds(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${sourceTag}^{commit}`])) {
    throw refused(`the snapshot's v${since} has no source tag ${sourceTag}`)
  }

  if (
    git(repo, ['rev-parse', '--is-shallow-repository'], 'git rev-parse failed').trim() === 'true'
  ) {
    throw refused(
      `the source repository is a shallow clone, so its history since ${sourceTag} is incomplete`
    )
  }

  const terms = readPrivateTerms(repo, sha)
  const seen = new Set([configValue(repo, 'user.email').toLowerCase()])
  const values = git(
    repo,
    ['log', '--format=%(trailers:key=Co-authored-by,valueonly,unfold)', `${sourceTag}..${sha}`],
    'git log failed'
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  return values.filter((value) => {
    const key = (EMAIL_PATTERN.exec(value)?.[1] ?? value).toLowerCase()
    if (seen.has(key) || isAutomated(value, key) || privateTextMatches(value, terms).length > 0) {
      return false
    }

    seen.add(key)
    return true
  })
}

// A bot account, which GitHub names with a `[bot]` suffix, or a Claude model, which signs with the
// same noreply address whatever its version. Neither is a person to credit.
const isAutomated = (value: string, email: string): boolean =>
  BOT_PATTERN.test(value) || email === CLAUDE_EMAIL

const lastPublishedVersion = (clone: string): string | undefined =>
  git(clone, ['tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-v:refname'], 'git tag failed')
    .split('\n')
    .map((line) => SNAPSHOT_TAG_PATTERN.exec(line.trim())?.[1])
    .find((version) => version !== undefined)

const result = (
  to: string,
  version: string,
  published: boolean,
  commit: string
): PublishResult => ({
  ok: true,
  published,
  to,
  version,
  commit,
})

const snapshotUrl = (repo: string, to: string): string =>
  originUrl(repo).startsWith('git@github.com:')
    ? `git@github.com:${to}.git`
    : `https://github.com/${to}.git`

const originUrl = (repo: string): string =>
  git(repo, ['remote', 'get-url', 'origin'], 'no origin remote').trim()

const ownerRepo = (url: string): string | undefined =>
  /github\.com[:/]([^/]+\/[^/]+?)(\.git)?\/?$/.exec(url)?.[1]

const pluginVersion = (repo: string, sha: string): string => {
  const raw = git(
    repo,
    ['show', `${sha}:${PLUGIN_MANIFEST_PATH}`],
    `no ${PLUGIN_MANIFEST_PATH} at ${sha}`
  )
  let version: unknown
  try {
    version = (JSON.parse(raw) as { version?: unknown }).version
  } catch {
    throw refused(`${PLUGIN_MANIFEST_PATH} is not valid JSON`)
  }
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw refused(`${PLUGIN_MANIFEST_PATH} has no release version`)
  }

  return version
}

const revParse = (repo: string, ref: string): string =>
  git(repo, ['rev-parse', '--verify', '--end-of-options', ref], `cannot resolve ${ref}`).trim()

// For git commands whose non-zero exit is an answer, not a failure.
const succeeds = (repo: string, args: readonly string[]): boolean =>
  spawnSync('git', ['-C', repo, ...args], { stdio: 'ignore' }).status === 0

const refused = (reason: string): PublishCheckCannotRun => new PublishCheckCannotRun(reason)

// The temp clone does not read the source repo's local config, so carry the maintainer's identity across.
const maintainerConfig = (repo: string): string[] => [
  '-c',
  `user.name=${configValue(repo, 'user.name')}`,
  '-c',
  `user.email=${configValue(repo, 'user.email')}`,
  '-c',
  'core.hooksPath=/dev/null',
]

const configValue = (repo: string, key: string): string => {
  const value = git(repo, ['config', '--get', key], `no ${key} configured`).trim()
  if (value.length === 0) {
    throw refused(`no ${key} configured`)
  }

  return value
}

const PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json'
const RELEASE_TAG_PREFIX = 'claude-workflow-v'
const TARGET_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const SNAPSHOT_TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/
const EMAIL_PATTERN = /<([^>]+)>/
const BOT_PATTERN = /\[bot\]/
const CLAUDE_EMAIL = 'noreply@anthropic.com'
const REFUSED_EXIT = 2
