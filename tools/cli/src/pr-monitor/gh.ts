import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { match } from 'ts-pattern'
import { isBotLogin } from './botFilter.ts'
import type {
  BotComment,
  CiCheck,
  CoderabbitStatus,
  MainComment,
  PrState,
  Review,
  ReviewThread,
  RefusalIdentity,
  StatedReviewerWait,
  StuckCheck,
  CheckRun,
  ThreadComments,
} from './state.ts'

// --- Retry helper ---

const MAX_RETRIES = 3
const INITIAL_DELAY_MS = 1000
const GH_CALL_TIMEOUT_MS = 30_000

// The deadline of the fetchPrState call in progress (null outside one). fetchPrState is
// synchronous, so one module-level slot is enough: every gh call below clamps its timeout to the
// time left, and no retry starts past it. A call that hits the deadline fails like any other
// failed read. On a required read it is recorded in `failures`, so fetchPrState reports the poll
// as UNKNOWN; on an optional read (`runOptional`) it loses only that read's own signal.
let activeDeadlineMs: number | null = null
// Optional reads in one call may spend only the first half of its time, so the required reads and
// the caller's confirm fetch keep the rest.
let optionalDeadlineMs: number | null = null
let failures: string[] = []
let isDeadlineHit = false

const callTimeoutMs = (): number => {
  if (activeDeadlineMs === null) {
    return GH_CALL_TIMEOUT_MS
  }

  const remaining = activeDeadlineMs - Date.now()
  if (remaining <= 0) {
    isDeadlineHit = true
    throw new Error('the poll deadline passed before the gh call could start')
  }

  return Math.max(1, Math.floor(Math.min(GH_CALL_TIMEOUT_MS, remaining)))
}

// A read whose signal is optional: running out of time in it loses only that signal, so the
// deadline flag and the failures the poll reports stay as they were before it.
const runOptional = <T>(read: () => T): T => {
  const wasDeadlineHit = isDeadlineHit
  const failureCount = failures.length
  const requiredDeadlineMs = activeDeadlineMs
  if (requiredDeadlineMs !== null && optionalDeadlineMs !== null) {
    activeDeadlineMs = Math.min(requiredDeadlineMs, optionalDeadlineMs)
  }
  try {
    return read()
  } finally {
    activeDeadlineMs = requiredDeadlineMs
    isDeadlineHit = wasDeadlineHit
    failures.length = failureCount
  }
}

const isPastDeadline = (): boolean => activeDeadlineMs !== null && Date.now() >= activeDeadlineMs

const recordFailure = (context: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  failures.push(`${context}: ${message.replace(/\s+/g, ' ').trim().slice(0, 300)}`)
}

const withRetry = <T>(fn: () => T, context: string): T => {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return fn()
    } catch (error: unknown) {
      const isLastAttempt = attempt === MAX_RETRIES
      const isRetryable =
        error instanceof Error &&
        (error.message.includes('ETIMEDOUT') ||
          error.message.includes('ECONNRESET') ||
          error.message.includes('ENOTFOUND') ||
          error.message.includes('error connecting') ||
          error.message.includes('socket hang up') ||
          error.message.includes('SIGTERM') ||
          error.message.includes('SIGKILL') ||
          error.message.includes('was killed') ||
          error.message.includes('504') ||
          error.message.includes('Gateway Timeout'))

      if (isPastDeadline()) {
        isDeadlineHit = true
        throw error
      }
      if (isLastAttempt || !isRetryable) throw error

      const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1)
      if (activeDeadlineMs !== null && Date.now() + delay >= activeDeadlineMs) {
        isDeadlineHit = true
        throw error
      }
      console.error(
        `PR Monitor: ${context} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms...`
      )
      const start = Date.now()
      while (Date.now() - start < delay) {
        // busy-wait — execFileSync is already sync, so we stay sync
      }
    }
  }
  throw new Error('unreachable')
}

// --- PR view types ---

interface PrViewResult {
  state: string
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  headRefOid: string
  comments: Array<{ id: string; author: { login: string } | null; body: string }>
}

const CODERABBIT_SKIP_MARKER =
  '<!-- This is an auto-generated comment: skip review by coderabbit.ai -->'

export const CODERABBIT_RATE_LIMITED_MARKER =
  '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->'
export const CODERABBIT_PAUSED_MARKER =
  '<!-- This is an auto-generated comment: review paused by coderabbit.ai -->'

export interface CoderabbitDetection {
  status: CoderabbitStatus
  cooloffMinutes: number | null
}

// --- Consolidated PR view fetcher ---

const fetchPrView = (prNumber: string, repo: string): PrViewResult => {
  try {
    const output = withRetry(
      () =>
        execFileSync(
          'gh',
          [
            'pr',
            'view',
            prNumber,
            '--repo',
            repo,
            '--json',
            'state,isDraft,comments,mergeable,mergeStateStatus,headRefOid',
          ],
          { encoding: 'utf-8', timeout: callTimeoutMs() }
        ),
      'fetchPrView'
    )
    return JSON.parse(output) as PrViewResult
  } catch (error) {
    console.error('PR Monitor: fetchPrView failed', error)
    recordFailure('fetchPrView', error)
    return {
      state: 'UNKNOWN',
      isDraft: true,
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN',
      headRefOid: '',
      comments: [],
    }
  }
}

const isCoderabbitStatusComment = (c: PrViewResult['comments'][number]): boolean =>
  c.author?.login === 'coderabbitai' &&
  (c.body.includes(CODERABBIT_RATE_LIMITED_MARKER) || c.body.includes(CODERABBIT_PAUSED_MARKER))

export const extractBotComments = (comments: PrViewResult['comments']): BotComment[] =>
  comments.flatMap((c) =>
    c.author && isBotLogin(c.author.login) && !isCoderabbitStatusComment(c)
      ? [{ id: c.id, author: c.author.login, bodyHash: hashBody(c.body) }]
      : []
  )

const hashBody = (body: string): string => createHash('sha256').update(body).digest('hex')

// Main review comments — the two GitHub objects a reviewer's "main" comment can be, as opposed to
// an inline thread. A review's body is only a main comment when it is non-empty: an empty body has
// nothing to read, whatever else the submission carried — inline comments, a bare approval — and
// waking on one would fire on every such review. A PENDING review is a draft nobody has submitted,
// so its body is not delivered feedback however long it is. Conversation comments are
// split by author because a bot's already has a wake of its own — extractBotComments above feeds
// NEW_BOT_COMMENTS — so the split here keeps any one comment from firing two change types.
export const extractMainComments = (
  comments: PrViewResult['comments'],
  reviews: Review[]
): MainComment[] => [
  ...reviews.flatMap((r) =>
    r.id && r.state !== 'PENDING' && r.body && r.body.trim() !== ''
      ? [{ id: r.id, author: r.author }]
      : []
  ),
  ...comments.flatMap((c) =>
    c.author && !isBotLogin(c.author.login) ? [{ id: c.id, author: c.author.login }] : []
  ),
]

const detectCoderabbitSkipped = (comments: PrViewResult['comments']): boolean =>
  comments.some(
    (c) => c.author?.login === 'coderabbitai' && c.body.includes(CODERABBIT_SKIP_MARKER)
  )

const CODERABBIT_REFUSAL_TEXT = 'Review rate limited'

// GitHub's cap on the ids one GraphQL `nodes` query takes.
const MAX_NODE_IDS = 100

const SECONDS_PER_UNIT: Record<string, number> = { hour: 3600, minute: 60, second: 1 }

// Every unit of the stated time counts, so `27 minutes and 4 seconds` is 1624 seconds, not 27 minutes.
export const parseCooloffSeconds = (body: string): number | null => {
  const m = body.match(
    /next (?:included )?review (?:will be )?available in\b[^\d]{0,40}?((?:\d+\s*(?:hour|minute|second)s?(?:[\s,*]|and)*)+)/is
  )
  if (!m) {
    return null
  }

  let total = 0
  for (const part of m[1].matchAll(/(\d+)\s*(hour|minute|second)/gi)) {
    total += Number(part[1]) * SECONDS_PER_UNIT[part[2].toLowerCase()]
  }

  return Number.isFinite(total) ? total : null
}

export const parseCooloffMinutes = (body: string): number | null => {
  const seconds = parseCooloffSeconds(body)
  return seconds === null ? null : Math.ceil(seconds / 60)
}

const isRefusalBody = (body: string): boolean =>
  body.includes(CODERABBIT_RATE_LIMITED_MARKER) || body.includes(CODERABBIT_REFUSAL_TEXT)

// Every CodeRabbit refusal on the PR, oldest first. CodeRabbit edits its summary comment in place,
// so creation order does not say which refusal is current. `gh pr view` returns every comment, so a
// refusal anywhere on the PR is found.
export const findRefusalIds = (comments: PrViewResult['comments']): string[] =>
  comments
    .filter((c) => c.author?.login === 'coderabbitai' && isRefusalBody(c.body))
    .map((c) => c.id)

export interface RefusalComment {
  id: string
  body: string
  updatedAt: string
}

export interface RefusalCommentsResult {
  comments: RefusalComment[]
  fetchFailed: boolean
}

// `gh pr view` exposes no edit time, and CodeRabbit edits these comments in place: the stated wait
// runs from the last edit. Every body and edit time come from one node read, so an edit cannot pair
// an old duration with a new time. `nodes` takes at most MAX_NODE_IDS ids: past that, this reads
// the first refusal and the newest MAX_NODE_IDS - 1, skipping those in between.
export const fetchRefusalComments = (
  commentIds: string[],
  execGraphql: GraphqlExecutor = makeExecGhGraphql('fetchRefusalComments')
): RefusalCommentsResult => {
  try {
    const query = `
      query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on IssueComment { id body updatedAt }
        }
      }
    `
    const readIds =
      commentIds.length > MAX_NODE_IDS
        ? [commentIds[0], ...commentIds.slice(1 - MAX_NODE_IDS)]
        : commentIds
    const idArgs = readIds.flatMap((id) => ['-f', `ids[]=${id}`])
    const output = execGraphql(['api', 'graphql', '-f', `query=${query}`, ...idArgs])
    const { nodes } = (JSON.parse(output) as { data: { nodes: unknown[] } }).data

    return { comments: nodes.map(toRefusalComment), fetchFailed: false }
  } catch (error) {
    console.error('PR Monitor: fetchRefusalComments failed', error)
    recordFailure('fetchRefusalComments', error)
    return { comments: [], fetchFailed: true }
  }
}

const toRefusalComment = (node: unknown): RefusalComment => {
  const { id, body, updatedAt } = (node ?? {}) as Partial<Record<keyof RefusalComment, unknown>>
  if (
    typeof id !== 'string' ||
    typeof body !== 'string' ||
    typeof updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw new Error(`fetchRefusalComments: a node lacks id, body or updatedAt (${id ?? 'no id'})`)
  }

  return { id, body, updatedAt }
}

export interface ReviewerWaitRead {
  wait: StatedReviewerWait | undefined
  // The most recently edited refusal when it states no time; null when there is none to report, undefined when
  // the read failed and nothing is known.
  untimedRefusal: RefusalIdentity | null | undefined
  readFailed: boolean
}

// The comment read is optional: running out of time in it leaves the wait unread, not the poll.
const readStatedReviewerWait = (comments: PrViewResult['comments']): ReviewerWaitRead => {
  const commentIds = findRefusalIds(comments)
  if (commentIds.length === 0) {
    return { wait: undefined, untimedRefusal: null, readFailed: false }
  }

  // The refusal edited last decides. A failed read leaves the wait unknown rather than settling on
  // a refusal that may not be the current one.
  const { comments: read, fetchFailed } = runOptional(() => fetchRefusalComments(commentIds))
  if (fetchFailed) {
    return { wait: undefined, untimedRefusal: undefined, readFailed: true }
  }

  const newest = read
    .filter((comment) => isRefusalBody(comment.body))
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
    .at(-1)
  if (newest === undefined) {
    return { wait: undefined, untimedRefusal: null, readFailed: false }
  }

  const { id: commentId, body, updatedAt } = newest
  const seconds = parseCooloffSeconds(body)
  return seconds === null
    ? { wait: undefined, untimedRefusal: { commentId, updatedAt }, readFailed: false }
    : { wait: { commentId, updatedAt, seconds }, untimedRefusal: null, readFailed: false }
}

export const detectCoderabbitStatus = (comments: PrViewResult['comments']): CoderabbitDetection => {
  const rateLimited = comments.find(
    (c) => c.author?.login === 'coderabbitai' && c.body.includes(CODERABBIT_RATE_LIMITED_MARKER)
  )
  if (rateLimited) {
    return { status: 'rate-limited', cooloffMinutes: parseCooloffMinutes(rateLimited.body) }
  }
  const paused = comments.some(
    (c) => c.author?.login === 'coderabbitai' && c.body.includes(CODERABBIT_PAUSED_MARKER)
  )
  if (paused) return { status: 'paused', cooloffMinutes: null }
  return { status: 'none', cooloffMinutes: null }
}

// --- Composite fetcher ---

// `deadlineMs` is an absolute Date.now() time. A required gh call that cannot finish by it fails,
// and the poll is reported UNKNOWN with the failures in `unknownReason`; an optional read that
// cannot leaves only its own signal unread.
export const fetchPrState = (prNumber: string, repo: string, deadlineMs?: number): PrState => {
  const startedAt = Date.now()
  activeDeadlineMs = deadlineMs ?? null
  optionalDeadlineMs = deadlineMs === undefined ? null : startedAt + (deadlineMs - startedAt) / 2
  failures = []
  isDeadlineHit = false
  try {
    return fetchPrStateWithinDeadline(prNumber, repo)
  } finally {
    activeDeadlineMs = null
    optionalDeadlineMs = null
  }
}

const fetchPrStateWithinDeadline = (prNumber: string, repo: string): PrState => {
  const commentsReadStartedAt = new Date().toISOString()
  const prView = fetchPrView(prNumber, repo)
  const coderabbit = detectCoderabbitStatus(prView.comments)
  const reviews = fetchReviews(prNumber, repo)
  const unresolved = fetchUnresolvedThreads(prNumber, repo)
  const ci = fetchCiChecks(prNumber, repo)
  const reviewerWait = readStatedReviewerWait(prView.comments)
  const prState = isDeadlineHit
    ? 'UNKNOWN'
    : resolvePrState(prView, reviews.fetchFailed, unresolved.fetchFailed)
  return {
    ciChecks: ci.checks,
    ciChecksFetchFailed: ci.fetchFailed,
    stuckChecks: ci.stuckChecks,
    unreadRunChecks: ci.unreadRunChecks,
    unresolvedThreads: unresolved.threads,
    threadComments: unresolved.threadComments,
    fetchFailed: unresolved.fetchFailed,
    prState,
    isDraft: prView.isDraft,
    reviews: reviews.reviews.map(toPersistedReview),
    coderabbitSkipped: detectCoderabbitSkipped(prView.comments),
    coderabbitStatus: coderabbit.status,
    coderabbitCooloffMinutes: coderabbit.cooloffMinutes,
    statedReviewerWait: reviewerWait.wait,
    untimedRefusal: reviewerWait.untimedRefusal,
    reviewerWaitReadFailed: reviewerWait.readFailed,
    commentsReadStartedAt,
    coderabbitThrottleCount: 0, // authoritative value is set by compareStates
    mergeable: prView.mergeable?.toUpperCase() ?? 'UNKNOWN',
    mergeStateStatus: prView.mergeStateStatus?.toUpperCase() ?? 'UNKNOWN',
    headSha: prView.headRefOid ?? '',
    botComments: extractBotComments(prView.comments),
    mainComments: extractMainComments(prView.comments, reviews.reviews),
    ciGreenOnDraftFired: false,
    timestamp: new Date().toISOString(),
    ...(prState === 'UNKNOWN' ? { unknownReason: failures.join('; ') } : {}),
  }
}

// latestDecisionByAuthor reads .author/.state from a persisted review, and the stale-review check
// reads .commitId; authorType is kept only because Review declares it non-optional. id/body are the
// only fields dropped here rather than rewritten to disk on every poll.
export const toPersistedReview = ({ author, authorType, state, commitId }: Review): Review => ({
  author,
  authorType,
  state,
  ...(commitId ? { commitId } : {}),
})

// fetchReviews and fetchUnresolvedThreads are GraphQL calls independent of fetchPrView's, so either
// can fail while prView still reports OPEN. Reporting either failure through prState — rather than
// only defaulting its result to [] — routes it into poll.ts's "don't compare or overwrite; wait and
// retry" guard, which keys on prState === 'UNKNOWN'. A fetchPrView failure reaches the same guard
// through prView.state itself: its catch returns state: 'UNKNOWN', which flows through the
// prView.state.toUpperCase() branch below unchanged.
//
// Difference set: before, any fetch outcome (including a failed one, defaulted to []) was accepted
// and compared against the previous baseline; now, only a poll where both calls succeeded is. What
// the new form rejects is dominated by persistent failures, not transient ones — withRetry (above)
// retries only a fixed set of transient failures and throws everything else on the first
// attempt, so a bad credential, an expired token scope, a rate-limited window, or a rejected query
// reaches here on every poll, not just one. The failure direction is a value that quietly goes
// missing (an empty reviews/threads list reads as "nothing new" rather than "couldn't check") rather
// than an error surfaced to a caller — bounded at MAX_CONSECUTIVE_UNKNOWN consecutive polls by
// poll.ts's wedge-exit, so it does not persist forever.
export const resolvePrState = (
  prView: PrViewResult,
  reviewsFetchFailed: boolean,
  threadsFetchFailed: boolean
): string => (reviewsFetchFailed || threadsFetchFailed ? 'UNKNOWN' : prView.state.toUpperCase())

// --- Individual fetchers ---

export interface CiChecksResult {
  checks: Record<string, string>
  fetchFailed: boolean
  stuckChecks: StuckCheck[]
  unreadRunChecks: CheckRun[]
}

// Reports whether the read succeeded, rather than returning a bare map. The accumulator used to be
// returned by the catch as well, so a throw on entry k handed back entries 0..k-1 as the complete
// set of checks — and a truncated all-green prefix satisfies `length > 0 && every(green)`, which is
// a fully green CI run to isMergeReady and isCiGreenOnDraft. A partial read is now discarded rather
// than reported, and the flag says so.
export type ChecksExecutor = (prNumber: string, repo: string) => string

const execGhChecks: ChecksExecutor = (prNumber, repo) =>
  withRetry(
    () =>
      execFileSync('gh', ['pr', 'checks', prNumber, '--repo', repo, '--json', 'name,state,link'], {
        encoding: 'utf-8',
        timeout: callTimeoutMs(),
      }),
    'fetchCiChecks'
  )

export const fetchCiChecks = (
  prNumber: string,
  repo: string,
  execChecks: ChecksExecutor = execGhChecks,
  readRunStatus: RunStatusReader = readGhRunStatus
): CiChecksResult => {
  const result: Record<string, string> = {}
  try {
    const output = execChecks(prNumber, repo)
    const checks: CiCheck[] = JSON.parse(output) as CiCheck[]

    // Not an array of named checks: a bare string iterates as its own characters, and an entry with
    // no name indexes `result` with "undefined". Both build a populated map out of a payload never
    // read as checks, so throw into the catch below — as paginateConnection does for `nodes`.
    if (!Array.isArray(checks)) {
      throw new Error(`fetchCiChecks: checks payload is not an array (${JSON.stringify(checks)})`)
    }

    for (const check of checks) {
      if (typeof check?.name !== 'string' || check.name.length === 0) {
        throw new Error(`fetchCiChecks: a check has no name (${JSON.stringify(check)})`)
      }

      const status = match(String(check.state ?? '').toUpperCase())
        .with('FAILURE', () => 'failure')
        .with('SUCCESS', () => 'success')
        .with('SKIPPED', () => 'skipped')
        .with('NEUTRAL', () => 'skipped')
        .otherwise(() => 'pending')

      // `gh pr checks` does not guarantee a name is unique across workflows, and plain assignment
      // is last-write-wins, so a later success could overwrite an earlier failure under the same
      // name and turn a red run green. Keep the worse status instead.
      const existing = result[check.name]
      result[check.name] = existing === undefined ? status : worseCiStatus(existing, status)
    }

    const { stuck, unread } = findStuckChecks(checks, repo, readRunStatus, () =>
      JSON.parse(execChecks(prNumber, repo))
    )
    return { checks: result, fetchFailed: false, stuckChecks: stuck, unreadRunChecks: unread }
  } catch (error) {
    recordFailure('fetchCiChecks', error)
    // Unlike fetchReviews and fetchUnresolvedThreads, this catch is not routed through
    // resolvePrState: gh pr checks legitimately exits non-zero before a PR's first check runs,
    // and treating that as UNKNOWN would wedge every PR at that point.
    //
    // An unreadable checks fetch and a genuinely empty one are opposite facts, though. The empty
    // case is already fail-closed at `checks.length > 0` in isMergeReady/isCiGreenOnDraft, so this
    // one still has to say it could not read — via ciChecksFetchFailed, not prState.
    return { checks: {}, fetchFailed: true, stuckChecks: [], unreadRunChecks: [] }
  }
}

export interface RunStatus {
  status: string
  attempt: number
}

export type RunStatusReader = (repo: string, runId: string) => RunStatus

// `run_attempt` is read with the status because a re-run keeps its run id and increments it.
const readGhRunStatus: RunStatusReader = (repo, runId) => {
  const output = withRetry(
    () =>
      execFileSync(
        'gh',
        ['api', `repos/${repo}/actions/runs/${runId}`, '--jq', '{status, attempt: .run_attempt}'],
        { encoding: 'utf-8', timeout: callTimeoutMs() }
      ),
    'readRunStatus'
  )
  const parsed = JSON.parse(output) as Partial<RunStatus>
  if (typeof parsed.status !== 'string' || !Number.isInteger(parsed.attempt)) {
    throw new Error(`readRunStatus: unexpected payload for run ${runId} (${output.trim()})`)
  }

  return { status: parsed.status, attempt: parsed.attempt as number }
}

// A check is stuck when it still reads in progress although the workflow run it belongs to has
// completed. Only a GitHub Actions link that names a job (`/actions/runs/<run>/job/<job>`) names a
// run and identifies the job across attempts; any other link is never reported stuck. A run that could not be read is not evidence
// either way, so its checks are listed as unread and the comparison keeps their previous state.
//
// The check state and the run status are two reads, so a job that finished between them reads as in
// progress on a completed run. A run that read completed was already completed before the checks
// are read once more, so a check still in progress on that run in the second read is stuck. The
// second read happens once however many runs completed, and a failed one leaves those checks unread.
const findStuckChecks = (
  checks: CiCheck[],
  repo: string,
  readRunStatus: RunStatusReader,
  rereadChecks: () => CiCheck[]
): { stuck: StuckCheck[]; unread: CheckRun[] } => {
  const statusByRun = new Map<string, RunStatus | null>()
  const candidates: Array<StuckCheck & { link: string }> = []
  const unread: CheckRun[] = []

  for (const check of checks) {
    const runId = runIdOf(check)
    if (!isInProgress(check) || !runId) {
      continue
    }

    if (!statusByRun.has(runId)) {
      statusByRun.set(runId, readStatusOrNull(repo, runId, readRunStatus))
    }

    const run = statusByRun.get(runId)
    if (!run) {
      unread.push({ name: check.name, runId })
    } else if (run.status === 'completed') {
      candidates.push({ name: check.name, runId, attempt: run.attempt, link: check.link ?? '' })
    }
  }

  if (candidates.length === 0) {
    return { stuck: [], unread }
  }

  const fresh = rereadOrNull(rereadChecks)
  if (!fresh) {
    return {
      stuck: [],
      unread: [...unread, ...candidates.map(({ name, runId }) => ({ name, runId }))],
    }
  }

  // A check's link names its job, and a re-run starts new jobs, so the same link in progress means
  // the attempt the status read saw is the one still stuck.
  const stuck = candidates
    .filter((c) => fresh.some((f) => f.name === c.name && isInProgress(f) && f.link === c.link))
    .map(({ name, runId, attempt }) => ({ name, runId, attempt }))

  return { stuck, unread }
}

const isInProgress = (check: CiCheck): boolean =>
  String(check.state ?? '').toUpperCase() === 'IN_PROGRESS'

const runIdOf = (check: CiCheck): string | undefined =>
  check.link?.match(/\/actions\/runs\/(\d+)\/job\/\d+/)?.[1]

const rereadOrNull = (rereadChecks: () => CiCheck[]): CiCheck[] | null => {
  try {
    const checks = runOptional(rereadChecks)
    if (!Array.isArray(checks)) {
      throw new Error('the checks re-read is not an array')
    }

    return checks
  } catch (error) {
    console.error('PR Monitor: re-reading the checks failed', error)
    return null
  }
}

const readStatusOrNull = (
  repo: string,
  runId: string,
  readRunStatus: RunStatusReader
): RunStatus | null => {
  try {
    return runOptional(() => readRunStatus(repo, runId))
  } catch (error) {
    console.error(`PR Monitor: reading run ${runId} failed`, error)
    return null
  }
}

// Worst first: anything non-green must survive a collision with anything green.
const CI_STATUS_SEVERITY = ['failure', 'pending', 'skipped', 'success']

const worseCiStatus = (a: string, b: string): string => {
  const rank = (s: string): number => {
    const index = CI_STATUS_SEVERITY.indexOf(s)
    return index === -1 ? 0 : index
  }
  return rank(a) <= rank(b) ? a : b
}

export interface ReviewsResult {
  reviews: Review[]
  fetchFailed: boolean
}

interface ReviewNode {
  id: string
  state: string
  body: string
  author: { __typename: string; login: string } | null
  commit: { oid: string } | null
}

// Reports whether the read succeeded, rather than a bare list, mirroring fetchUnresolvedThreads and
// fetchCiChecks: resolvePrState reads the flag to decide whether this poll's prState can be trusted,
// and extractMainComments reads a failed read's id/body the same as a genuine zero-review PR would.
export const fetchReviews = (
  prNumber: string,
  repo: string,
  execGraphql: GraphqlExecutor = makeExecGhGraphql('fetchReviews')
): ReviewsResult => {
  const [owner, repoName] = repo.split('/')
  try {
    const query = `
      query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviews(first: 100, after: $endCursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                state
                body
                commit { oid }
                author {
                  __typename
                  login
                }
              }
            }
          }
        }
      }
    `
    const nodes = paginateConnection<ReviewNode>((cursor) => {
      const output = execGraphql(graphqlArgs(query, owner, repoName, prNumber, cursor))
      const parsed = JSON.parse(output) as {
        data: { repository: { pullRequest: { reviews: ConnectionPage<ReviewNode> } } }
      }
      return parsed.data.repository.pullRequest.reviews
    })
    const reviews = nodes.map((r): Review => ({
      id: r.id,
      author: r.author?.login ?? 'unknown',
      authorType: r.author?.__typename ?? 'Unknown',
      state: r.state,
      body: r.body ?? '',
      commitId: r.commit?.oid,
    }))
    return { reviews, fetchFailed: false }
  } catch (error) {
    console.error('PR Monitor: fetchReviews failed', error)
    recordFailure('fetchReviews', error)
    return { reviews: [], fetchFailed: true }
  }
}

export interface UnresolvedThreadsResult {
  threads: ReviewThread[]
  threadComments: ThreadComments[]
  fetchFailed: boolean
}

// Reports whether the read succeeded, rather than returning a bare list. An empty list and an
// unreadable one are the same value but opposite facts, and isMergeReady treats the empty list as
// "no open threads" — a swallow that fails OPEN, which is why it reports the read instead.
export const fetchUnresolvedThreads = (
  prNumber: string,
  repo: string,
  execGraphql: GraphqlExecutor = makeExecGhGraphql('fetchUnresolvedThreads')
): UnresolvedThreadsResult => {
  const [owner, repoName] = repo.split('/')
  try {
    const query = `
      query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100, after: $endCursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                isResolved
                path
                line
                comments(first: 1) {
                  nodes {
                    id
                    author { login }
                    body
                  }
                }
                recentComments: comments(last: 20) {
                  nodes { id }
                }
              }
            }
          }
        }
      }
    `
    const nodes = paginateConnection<RawReviewThread>((cursor) => {
      const output = execGraphql(graphqlArgs(query, owner, repoName, prNumber, cursor))
      const parsed = JSON.parse(output) as {
        data: { repository: { pullRequest: { reviewThreads: ConnectionPage<RawReviewThread> } } }
      }
      return parsed.data.repository.pullRequest.reviewThreads
    })
    return {
      threads: toReviewThreads(nodes),
      threadComments: toThreadComments(nodes),
      fetchFailed: false,
    }
  } catch (error) {
    console.error('PR Monitor: fetchUnresolvedThreads failed', error)
    recordFailure('fetchUnresolvedThreads', error)
    return { threads: [], threadComments: [], fetchFailed: true }
  }
}

interface RawReviewThread {
  isResolved: boolean
  path: string
  line: number | null
  comments: { nodes: Array<{ id?: string; author: { login: string } | null; body: string }> }
  recentComments?: { nodes: Array<{ id: string }> }
}

// Map GraphQL review-thread nodes to ReviewThread, keeping only unresolved threads.
// Threads are NOT filtered by author: the human user and the automation share one
// GitHub account, so an author filter would drop the user's own review comments.
// The first comment's node id is carried instead: a reply this session posted is identified by the
// id GitHub returned at post time, which is the one identity the shared login cannot supply
// (FLOW-261). Replies inside an existing thread are read by toThreadComments.
export const toReviewThreads = (nodes: RawReviewThread[]): ReviewThread[] =>
  nodes
    .filter((t) => !t.isResolved)
    .map((t) => ({
      path: t.path,
      line: t.line,
      isResolved: false,
      firstCommentBody: t.comments.nodes[0]?.body ?? '',
      firstCommentId: t.comments.nodes[0]?.id ?? '',
    }))

// Every thread, resolved ones included: a reviewer can answer inside a thread already resolved.
export const toThreadComments = (nodes: RawReviewThread[]): ThreadComments[] =>
  nodes.flatMap((t) => {
    const firstCommentId = t.comments.nodes[0]?.id
    if (!firstCommentId) {
      return []
    }

    const replyIds = (t.recentComments?.nodes ?? [])
      .map((c) => c.id)
      .filter((id) => id !== firstCommentId)

    return [{ firstCommentId, path: t.path, replyIds }]
  })

// --- GraphQL cursor pagination ---

export interface ConnectionPage<TNode> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: TNode[]
}

// A runaway bound, not a ration: a real connection could need dozens of pages and never approaches
// this. The cursor-advance guard below catches both known non-terminating shapes within one or two
// iterations, so this only fires for a connection whose cursor advances forever.
export const MAX_PAGES = 10_000

// Follows a connection's own pageInfo until hasNextPage is false, accumulating every page's nodes.
//
// Every failure here THROWS into the caller's catch rather than returning what was gathered so far.
// A cap that returned partial results would be this ticket's founding defect — a truncated list
// reported as a complete one — rebuilt inside the guard meant to prevent it. A page-fetch error
// propagates for the same reason: a partial result is a failed query, not a shorter answer.
export const paginateConnection = <TNode>(
  fetchPage: (afterCursor: string | null) => ConnectionPage<TNode>
): TNode[] => {
  const allNodes: TNode[] = []
  let cursor: string | null = null
  for (let pageCount = 0; ; pageCount++) {
    if (pageCount >= MAX_PAGES) {
      throw new Error(
        `paginateConnection: exceeded ${MAX_PAGES} pages without reaching the end of the ` +
          `connection — refusing to loop forever`
      )
    }
    const page = fetchPage(cursor)
    // A non-array `nodes` must be rejected, not spread: a string spreads into its characters, so
    // `push(...page.nodes)` would silently accumulate garbage instead of failing.
    if (!Array.isArray(page.nodes)) {
      throw new Error(
        `paginateConnection: page ${pageCount} has a non-array nodes field ` +
          `(${JSON.stringify(page.nodes)})`
      )
    }
    if (typeof page.pageInfo?.hasNextPage !== 'boolean') {
      throw new Error(`paginateConnection: page ${pageCount} is missing pageInfo.hasNextPage`)
    }
    allNodes.push(...page.nodes)
    if (!page.pageInfo.hasNextPage) return allNodes
    const nextCursor = page.pageInfo.endCursor
    // hasNextPage true with a cursor that did not move — endCursor came back null (the next fetch
    // would restart from page one) or the server repeated it — is a connection that can never
    // terminate on its own.
    if (nextCursor === cursor) {
      throw new Error(
        `paginateConnection: hasNextPage is true but the cursor did not advance ` +
          `(endCursor: ${JSON.stringify(nextCursor)}) — refusing to loop forever`
      )
    }
    cursor = nextCursor
  }
}

export type GraphqlExecutor = (args: string[]) => string

// `context` names the calling fetcher in withRetry's log line, so a retry is attributable to the
// query that produced it.
const makeExecGhGraphql =
  (context: string): GraphqlExecutor =>
  (args) =>
    withRetry(
      () => execFileSync('gh', args, { encoding: 'utf-8', timeout: callTimeoutMs() }),
      context
    )

const graphqlArgs = (
  query: string,
  owner: string,
  repoName: string,
  prNumber: string,
  cursor: string | null
): string[] => {
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repoName}`,
    '-F',
    `pr=${prNumber}`,
  ]
  if (cursor !== null) args.push('-f', `endCursor=${cursor}`)
  return args
}
