import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanBaseline,
  compareStates,
  deleteState,
  loadSelfCommentIds,
  loadState,
  loadWatched,
  loadWatchedFor,
  markPolled,
  recordSelfComment,
  recordUnknownPoll,
  saveState,
  statePath,
  storeDir,
  storeLockPath,
  type CoderabbitStatus,
  type PrState,
  type ReviewThread,
  unwatchPr,
  watchPr,
} from './state.ts'
import { toReviewThreads } from './gh.ts'
import { atomicWrite } from '../workflow-store/store.ts'

const withCoderabbit = (status: CoderabbitStatus, overrides: Partial<PrState> = {}): PrState => ({
  ...cleanBaseline(),
  coderabbitStatus: status,
  headSha: 'sha1',
  ...overrides,
})

test('none to rate-limited emits CODERABBIT_RATE_LIMITED with occurrence 1', () => {
  const prev = withStatedWait(undefined, 0)
  const curr = withStatedWait(stated('c1', 0, 34 * 60), 0, {
    coderabbitStatus: 'rate-limited',
    coderabbitCooloffMinutes: 34,
  })
  const changes = compareStates(prev, curr, [], false, T0 + MINUTE_MS)
  const evt = changes.find((c) => c.type === 'CODERABBIT_RATE_LIMITED')
  assert.ok(evt, 'expected a CODERABBIT_RATE_LIMITED event')
  assert.match(evt.detail, /occurrence 1/)
  assert.match(evt.detail, /next review available at 2026-01-01T00:34:00.000Z/)
  assert.equal(curr.coderabbitThrottleCount, 1)
})

test('a persistent rate-limited banner does not re-emit', () => {
  const prev = withCoderabbit('rate-limited', { coderabbitThrottleCount: 1 })
  const curr = withCoderabbit('rate-limited', { coderabbitCooloffMinutes: 20 })
  const changes = compareStates(prev, curr)
  assert.equal(
    changes.some((c) => c.type === 'CODERABBIT_RATE_LIMITED'),
    false
  )
  assert.equal(curr.coderabbitThrottleCount, 1) // carried, not incremented
})

test('repeated throttles on the same commit accumulate the occurrence count', () => {
  const prev = withCoderabbit('none', { coderabbitThrottleCount: 3 })
  const curr = withCoderabbit('rate-limited', { coderabbitCooloffMinutes: 10 })
  const evt = compareStates(prev, curr).find((c) => c.type === 'CODERABBIT_RATE_LIMITED')
  assert.ok(evt, 'expected a CODERABBIT_RATE_LIMITED event')
  assert.match(evt.detail, /occurrence 4/)
  assert.equal(curr.coderabbitThrottleCount, 4)
})

test('a new headSha keeps counting, so the next transition is never a duplicate', () => {
  const prev = withCoderabbit('none', { coderabbitThrottleCount: 3, headSha: 'old' })
  const curr = withCoderabbit('rate-limited', { coderabbitCooloffMinutes: 10, headSha: 'new' })
  const evt = compareStates(prev, curr).find((c) => c.type === 'CODERABBIT_RATE_LIMITED')
  assert.ok(evt, 'expected a CODERABBIT_RATE_LIMITED event')
  assert.match(evt.detail, /occurrence 4/)
  assert.equal(curr.coderabbitThrottleCount, 4)

  const reread = withCoderabbit('rate-limited', { headSha: 'new', coderabbitThrottleCount: 0 })
  assert.deepEqual(
    compareStates(curr, reread).filter((c) => c.type === 'CODERABBIT_RATE_LIMITED'),
    [],
    'a re-read repeated the event'
  )
  assert.equal(reread.coderabbitThrottleCount, 4, 'the count was not carried')
})

test('an unstated cooloff still emits, and names no fallback wait', () => {
  const prev = withCoderabbit('none')
  const curr = withCoderabbit('rate-limited', { coderabbitCooloffMinutes: null })
  const evt = compareStates(prev, curr).find((c) => c.type === 'CODERABBIT_RATE_LIMITED')
  assert.ok(evt, 'expected a CODERABBIT_RATE_LIMITED event')
  assert.match(evt.detail, /no reset time stated/)
  assert.doesNotMatch(evt.detail, /fallback/)
})

test('none to paused emits CODERABBIT_PAUSED', () => {
  const prev = withCoderabbit('none')
  const curr = withCoderabbit('paused')
  assert.equal(
    compareStates(prev, curr).some((c) => c.type === 'CODERABBIT_PAUSED'),
    true
  )
})

test('rate-limited to none clears without a spurious event', () => {
  const prev = withCoderabbit('rate-limited', { coderabbitThrottleCount: 2 })
  const curr = withCoderabbit('none')
  const changes = compareStates(prev, curr)
  assert.equal(
    changes.some((c) => c.type.startsWith('CODERABBIT_')),
    false
  )
})

test('a direct draft→ready flip that is not merge-ready emits READY_FOR_REVIEW', () => {
  const prev: PrState = {
    ...cleanBaseline(),
    isDraft: true,
    ciChecks: { ci: 'success' },
    headSha: 'sha1',
  }
  const curr: PrState = {
    ...cleanBaseline(),
    isDraft: false,
    ciChecks: { ci: 'success' },
    headSha: 'sha1',
  }
  const changes = compareStates(prev, curr)
  assert.equal(
    changes.some((c) => c.type === 'READY_FOR_REVIEW'),
    true
  )
  assert.equal(
    changes.some((c) => c.type === 'MERGE_READY'),
    false
  )
})

test('a draft→ready flip that is already merge-ready emits MERGE_READY, not READY_FOR_REVIEW', () => {
  const prev: PrState = {
    ...cleanBaseline(),
    isDraft: true,
    ciChecks: { ci: 'success' },
    headSha: 'sha1',
    reviews: [{ author: 'alice', authorType: 'User', state: 'APPROVED' }],
    mergeStateStatus: 'CLEAN',
  }
  const curr: PrState = { ...prev, isDraft: false }
  const changes = compareStates(prev, curr)
  assert.equal(
    changes.some((c) => c.type === 'MERGE_READY'),
    true
  )
  assert.equal(
    changes.some((c) => c.type === 'READY_FOR_REVIEW'),
    false
  )
})

test('no READY_FOR_REVIEW while the PR stays ready (transition only)', () => {
  const prev: PrState = {
    ...cleanBaseline(),
    isDraft: false,
    ciChecks: { ci: 'success' },
    headSha: 'sha1',
  }
  const curr: PrState = {
    ...cleanBaseline(),
    isDraft: false,
    ciChecks: { ci: 'success' },
    headSha: 'sha1',
  }
  assert.equal(
    compareStates(prev, curr).some((c) => c.type === 'READY_FOR_REVIEW'),
    false
  )
})

// --- FLOW-175: latest-decision-per-author approval counting ---

const readyGreenClean = (reviews: PrState['reviews']): PrState => ({
  ...cleanBaseline(),
  isDraft: false,
  prState: 'OPEN',
  ciChecks: { ci: 'success' },
  unresolvedThreads: [],
  mergeStateStatus: 'CLEAN',
  mergeable: 'MERGEABLE',
  headSha: 'sha1',
  reviews,
})

// --- FLOW-464: a green PR awaiting review, and a failure on a new commit ---

const awaitingReview = (overrides: Partial<PrState> = {}): PrState => ({
  ...cleanBaseline(),
  isDraft: false,
  ciChecks: { ci: 'success' },
  headSha: 'abcdef1234',
  ...overrides,
})

const awaitingReviewFired = (previous: PrState, current: PrState): boolean =>
  compareStates(previous, current).some((c) => c.type === 'ci-green-awaiting-review')

test('ci-green-awaiting-review fires once per head', () => {
  const pending = awaitingReview({ ciChecks: { ci: 'pending' } })
  const green = awaitingReview()
  assert.equal(awaitingReviewFired(pending, green), true)
  assert.equal(green.ciGreenAwaitingReviewHead, 'abcdef1234')

  assert.equal(awaitingReviewFired(green, awaitingReview()), false, 'same head re-fired')

  const nextHead = awaitingReview({ headSha: 'fedcba9876' })
  assert.equal(awaitingReviewFired(green, nextHead), true, 'a new head did not re-fire')
  assert.equal(nextHead.ciGreenAwaitingReviewHead, 'fedcba9876')
})

test('ci-green-awaiting-review stays silent for a draft, unread checks and a merge-ready PR', () => {
  const pending = awaitingReview({ ciChecks: { ci: 'pending' } })
  const review = (state: string): PrState['reviews'] => [
    { author: 'alice', authorType: 'User', state },
  ]
  assert.equal(awaitingReviewFired(pending, awaitingReview({ isDraft: true })), false, 'draft')
  assert.equal(
    awaitingReviewFired(
      pending,
      awaitingReview({ reviews: review('APPROVED'), mergeStateStatus: 'CLEAN' })
    ),
    false,
    'merge-ready is MERGE_READY, not this event'
  )
  assert.equal(
    awaitingReviewFired(pending, awaitingReview({ ciChecksFetchFailed: true })),
    false,
    'unread checks'
  )
})

test('ci-green-awaiting-review fires despite a standing review while the PR is not ready to merge', () => {
  const pending = awaitingReview({ ciChecks: { ci: 'pending' } })
  const review = (state: string): PrState['reviews'] => [
    { author: 'alice', authorType: 'User', state, commitId: 'old1' },
  ]
  const openThread = [{ path: 'a.ts', line: 1, isResolved: false }]
  assert.equal(
    awaitingReviewFired(
      pending,
      awaitingReview({ reviews: review('CHANGES_REQUESTED'), unresolvedThreads: openThread })
    ),
    true,
    'a standing CHANGES_REQUESTED with its threads still open stayed silent'
  )
  assert.equal(
    awaitingReviewFired(
      pending,
      awaitingReview({ reviews: review('APPROVED'), mergeStateStatus: 'BLOCKED' })
    ),
    true,
    'an approval on a PR that is not CLEAN stayed silent'
  )
  assert.equal(
    awaitingReviewFired(pending, awaitingReview({ reviews: review('DISMISSED') })),
    true,
    'a dismissed review leaves the PR awaiting review'
  )
})

test('a check failing on the old head and again on a new head emits CI_FAILURE both times', () => {
  const failing = (headSha: string): PrState =>
    awaitingReview({ ciChecks: { ci: 'failure' }, headSha })
  const failures = (previous: PrState, current: PrState): number =>
    compareStates(previous, current).filter((c) => c.type === 'CI_FAILURE').length

  assert.equal(failures(awaitingReview({ ciChecks: { ci: 'pending' } }), failing('abcdef1234')), 1)
  assert.equal(failures(failing('abcdef1234'), failing('abcdef1234')), 0, 'unchanged re-emitted')
  assert.equal(failures(failing('abcdef1234'), failing('fedcba9876')), 1, 'new head stayed silent')
})

// --- FLOW-464: a reply inside a known thread ---

const withReplies = (threads: PrState['threadComments']): PrState => ({
  ...cleanBaseline(),
  threadComments: threads,
})

test('new-thread-replies fires for a reply from someone else, resolved thread included', () => {
  const before = withReplies([{ firstCommentId: 't1', path: 'a.ts', replyIds: ['r1'] }])
  const after = withReplies([{ firstCommentId: 't1', path: 'a.ts', replyIds: ['r1', 'r2'] }])
  const evt = compareStates(before, after).find((c) => c.type === 'new-thread-replies')
  assert.equal(evt?.detail, 'New replies in 1 existing review thread in: a.ts')
})

test('new-thread-replies stays silent for own replies, unknown threads and a missing baseline', () => {
  const before = withReplies([{ firstCommentId: 't1', path: 'a.ts', replyIds: ['r1'] }])
  const replied = withReplies([
    { firstCommentId: 't1', path: 'a.ts', replyIds: ['r1', 'mine'] },
    { firstCommentId: 't2', path: 'b.ts', replyIds: ['x1'] },
  ])
  const fired = (previous: PrState, selfIds: string[] = []): boolean =>
    compareStates(previous, replied, selfIds).some((c) => c.type === 'new-thread-replies')
  assert.equal(fired(before, ['mine']), false, 'own reply or a thread absent from previous woke')
  assert.equal(fired(withReplies(undefined)), false, 'a previous with no threadComments woke')
  assert.equal(fired(before), true, 'control: the same reply is not self-recorded')
})

test('a reply that slides into the capped window is not new, a reply after the known ones is', () => {
  const ids = (from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => `r${from + i}`)
  const thread = (replyIds: string[]) =>
    withReplies([{ firstCommentId: 't1', path: 'a.ts', replyIds }])
  const fired = (previous: PrState, current: PrState, selfIds: string[] = []): boolean =>
    compareStates(previous, current, selfIds).some((c) => c.type === 'new-thread-replies')

  const saved = thread(ids(6, 25))
  assert.equal(fired(saved, thread(ids(5, 24))), false, 'a deleted reply woke the session')
  assert.equal(
    fired(saved, thread([...ids(7, 24), 'r26'])),
    true,
    'a new reply after r24 was missed'
  )
  assert.equal(fired(saved, thread([...ids(7, 24), 'mine']), ['mine']), false, 'own reply woke')
  assert.equal(fired(saved, thread(ids(30, 49))), true, 'no known id in the window: all are new')
  assert.equal(fired(saved, thread(ids(6, 25))), false, 'control: nothing changed')

  const between = thread(['r1', 'r3'])
  assert.equal(
    fired(between, thread(['r1', 'late', 'r3'])),
    true,
    'a reply listed between two known'
  )
})

test('the thread-reply and awaiting-review baselines survive the store round-trip', () => {
  withIsolatedStore('flow-464-baselines-roundtrip', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', {
      ...withReplies([{ firstCommentId: 't1', path: 'a.ts', replyIds: ['r1'] }]),
      ciGreenAwaitingReviewHead: 'abc',
    })
    const loaded = loadState('7', 'owner/repo')
    assert.deepEqual(loaded?.threadComments, [
      { firstCommentId: 't1', path: 'a.ts', replyIds: ['r1'] },
    ])
    assert.equal(loaded?.ciGreenAwaitingReviewHead, 'abc')
  })
})

// --- FLOW-464: a verdict left on an older commit ---

const staleReview = (overrides: Partial<PrState> = {}): PrState => ({
  ...awaitingReview(),
  reviews: [{ author: 'bob', authorType: 'User', state: 'CHANGES_REQUESTED', commitId: 'old1' }],
  ...overrides,
})

const staleFired = (previous: PrState, current: PrState): boolean =>
  compareStates(previous, current).some((c) => c.type === 'stale-review-blocking')

test('stale-review-blocking fires once per head when only an older-commit verdict blocks', () => {
  const quiet = awaitingReview({ reviews: [] })
  const stale = staleReview()
  assert.equal(staleFired(quiet, stale), true)
  assert.equal(stale.staleReviewHead, 'abcdef1234')
  assert.equal(staleFired(stale, staleReview()), false, 'same head re-fired')
  assert.equal(staleFired(stale, staleReview({ headSha: 'fedcba9876' })), true, 'new head silent')

  const detail = (current: PrState): string | undefined =>
    compareStates(quiet, current).find((c) => c.type === 'stale-review-blocking')?.detail
  assert.doesNotMatch(detail(staleReview()) ?? '', /behind/)
  assert.match(detail(staleReview()) ?? '', /CHANGES_REQUESTED review is left on an older commit/)
  assert.match(
    detail(staleReview({ mergeStateStatus: 'BEHIND' })) ?? '',
    /older commit than abcdef1.*; the branch is also behind its base/,
    'a behind branch was not named, or the event was dropped for it'
  )
})

test('stale-review-blocking stays silent when anything else blocks or the verdict is current', () => {
  const quiet = awaitingReview({ reviews: [] })
  const review = (commitId?: string): PrState['reviews'] => [
    { author: 'bob', authorType: 'User', state: 'CHANGES_REQUESTED', commitId },
  ]
  assert.equal(staleFired(quiet, staleReview({ reviews: review('abcdef1234') })), false, 'on head')
  assert.equal(staleFired(quiet, staleReview({ reviews: review(undefined) })), false, 'no commit')
  assert.equal(
    staleFired(
      quiet,
      staleReview({ unresolvedThreads: [{ path: 'a.ts', line: 1, isResolved: false }] })
    ),
    false,
    'open thread'
  )
  assert.equal(staleFired(quiet, staleReview({ ciChecks: { ci: 'failure' } })), false, 'red check')
  assert.equal(staleFired(quiet, staleReview({ isDraft: true })), false, 'draft')
  assert.equal(staleFired(quiet, staleReview()), true, 'control: the same state fires unaltered')
})

test('a review commitId survives the store round-trip', () => {
  withIsolatedStore('flow-464-commit-id-roundtrip', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', { ...staleReview(), staleReviewHead: 'abcdef1234' })
    const loaded = loadState('7', 'owner/repo')
    assert.equal(loaded?.reviews[0]?.commitId, 'old1')
    assert.equal(loaded?.staleReviewHead, 'abcdef1234')
  })
})

// --- FLOW-464: a check whose workflow run has ended ---

const withStuck = (
  stuckChecks: PrState['stuckChecks'],
  headSha = 'abcdef1234',
  overrides: Partial<PrState> = {}
): PrState => ({
  ...awaitingReview({ ciChecks: { ci: 'pending' }, headSha }),
  stuckChecks,
  ...overrides,
})

const stuckEvents = (previous: PrState, current: PrState): string[] =>
  compareStates(previous, current)
    .filter((c) => c.type === 'check-stuck')
    .map((c) => c.detail)

const ciRun = (attempt: number, runId = '77') => [{ name: 'ci', runId, attempt }]

test('check-stuck fires when newly stuck, not again on one head, and again on a new head', () => {
  assert.deepEqual(stuckEvents(withStuck([]), withStuck(ciRun(1))), [
    'Check still in progress although the workflow run has completed: ci (run 77, attempt 1)',
  ])
  assert.deepEqual(stuckEvents(withStuck(ciRun(1)), withStuck(ciRun(1))), [], 'same head re-fired')
  assert.deepEqual(stuckEvents(withStuck(undefined), withStuck([])), [], 'nothing stuck fired')
  assert.equal(
    stuckEvents(withStuck(ciRun(1)), withStuck(ciRun(1), 'fedcba9876')).length,
    1,
    'a new head did not re-report'
  )
})

test('a re-run that ends stuck again reports again, and a saved entry without an attempt does not', () => {
  assert.equal(
    stuckEvents(withStuck(ciRun(1)), withStuck(ciRun(2))).length,
    1,
    'a new attempt of the same run stayed silent'
  )
  assert.equal(stuckEvents(withStuck(ciRun(1)), withStuck(ciRun(1, '78'))).length, 1, 'a new run')

  assert.deepEqual(stuckEvents(withStuck(ciRun(0)), withStuck(ciRun(2))), [], 'no-attempt entry')
  assert.deepEqual(stuckEvents(withStuck(ciRun(0, '')), withStuck(ciRun(2))), [], 'no-run entry')
  assert.equal(
    stuckEvents(withStuck(ciRun(0)), withStuck(ciRun(2, '78'))).length,
    1,
    'a different run matched a saved entry'
  )

  const next = withStuck(ciRun(2))
  stuckEvents(withStuck(ciRun(0, '')), next)
  assert.deepEqual(next.stuckChecks, ciRun(2), 'the full identity was not saved')
})

test('a check whose run could not be read keeps its stuck state instead of re-reporting', () => {
  const ci = ciRun(1)
  const unread = withStuck([], 'abcdef1234', { unreadRunChecks: [{ name: 'ci', runId: '77' }] })
  assert.deepEqual(stuckEvents(withStuck(ci), unread), [], 'an unreadable run fired')
  assert.deepEqual(unread.stuckChecks, ci, 'the unreadable run cleared the baseline')
  assert.deepEqual(stuckEvents(unread, withStuck(ci)), [], 'the next good read re-reported it')

  const failedFetch = withStuck([], 'abcdef1234', { ciChecksFetchFailed: true })
  assert.deepEqual(stuckEvents(withStuck(ci), failedFetch), [])
  assert.deepEqual(failedFetch.stuckChecks, ci, 'a failed checks read cleared the baseline')

  const cleared = withStuck([])
  assert.deepEqual(stuckEvents(withStuck(ci), cleared), [])
  assert.deepEqual(cleared.stuckChecks, [], 'a check no longer stuck stayed in the baseline')
})

test('a failed read of one run keeps a same-named check stuck on another run', () => {
  const both = [...ciRun(1, '1'), ...ciRun(1, '2')]
  const oneUnread = withStuck(ciRun(1, '1'), 'abcdef1234', {
    unreadRunChecks: [{ name: 'ci', runId: '2' }],
  })
  assert.deepEqual(stuckEvents(withStuck(both), oneUnread), [], 'a failed read fired')
  assert.deepEqual(oneUnread.stuckChecks, both, 'the unread run was dropped from the baseline')
  assert.deepEqual(stuckEvents(oneUnread, withStuck(both)), [], 'the next good read re-reported')

  const legacy = withStuck([], 'abcdef1234', { unreadRunChecks: [{ name: 'ci', runId: '2' }] })
  stuckEvents(withStuck(ciRun(0, '')), legacy)
  assert.deepEqual(
    legacy.stuckChecks,
    ciRun(0, ''),
    'an entry with no run id was not matched by name'
  )
})

// --- FLOW-464: the reset time a reviewer states ---

const MINUTE_MS = 60_000
const T0 = Date.parse('2026-01-01T00:00:00Z')
const at = (minutes: number): string => new Date(T0 + minutes * MINUTE_MS).toISOString()

// A poll whose previous successful read was `readMinutes` after T0.
const withStatedWait = (
  statedReviewerWait: PrState['statedReviewerWait'],
  readMinutes: number,
  overrides: Partial<PrState> = {}
): PrState => ({
  ...cleanBaseline(),
  timestamp: at(readMinutes),
  statedReviewerWait,
  ...overrides,
})

const stated = (commentId: string, updatedAtMinutes: number, seconds = 300) => ({
  commentId,
  updatedAt: at(updatedAtMinutes),
  seconds,
})

const waitEvents = (previous: PrState, current: PrState, nowMinutes: number): string[] =>
  compareStates(previous, current, [], false, T0 + nowMinutes * MINUTE_MS)
    .filter((c) => c.type === 'reviewer-available')
    .map((c) => c.detail)

test('reviewer-available fires once, counted from the comment own edit time', () => {
  const armed = withStatedWait(stated('c1', 0), 0)
  assert.deepEqual(waitEvents(withStatedWait(undefined, 0), armed, 1), [], 'fired early')
  assert.deepEqual(armed.reviewerWait, {
    commentId: 'c1',
    updatedAt: at(0),
    availableAt: at(5),
    fired: false,
  })

  const due = withStatedWait(stated('c1', 0), 1, { reviewerWait: armed.reviewerWait })
  assert.deepEqual(waitEvents(armed, due, 5), [
    "CodeRabbit's stated reset time (2026-01-01T00:05:00.000Z) has arrived",
  ])
  assert.equal(due.reviewerWait?.fired, true)

  const later = withStatedWait(stated('c1', 0), 5, { reviewerWait: due.reviewerWait })
  assert.deepEqual(waitEvents(due, later, 9), [], 'fired a second time')

  const edited = withStatedWait(stated('c1', 8), 9, { reviewerWait: later.reviewerWait })
  assert.deepEqual(waitEvents(later, edited, 9), [], 'an edit fired at once')
  assert.equal(edited.reviewerWait?.availableAt, at(13))

  const unstated = withStatedWait(undefined, 30, { reviewerWait: edited.reviewerWait })
  assert.deepEqual(waitEvents(edited, unstated, 30), [], 'a cleared wait fired')
  assert.equal(unstated.reviewerWait, undefined)
})

test('a reset already past at the previous read never fires, one that fell due since does', () => {
  const old = withStatedWait(stated('c1', 0), 60)
  assert.deepEqual(waitEvents(withStatedWait(undefined, 60), old, 120), [], 'an old refusal fired')
  assert.equal(old.reviewerWait?.fired, true, 'an old refusal was left armed')

  const awayAcross = withStatedWait(stated('c1', 0), 180)
  assert.equal(waitEvents(withStatedWait(undefined, 1), awayAcross, 180).length, 1, 'away: no fire')

  const pendingRead = withStatedWait(stated('c1', 0), 6, {
    reviewerWait: { commentId: 'c1', updatedAt: at(0), availableAt: at(5), fired: false },
  })
  const gap = withStatedWait(undefined, 6, { reviewerWait: pendingRead.reviewerWait })
  assert.equal(waitEvents(gap, pendingRead, 7).length, 1, 'a pending wait read late never fired')
})

test('identical refusals each get a wait and an older refusal never re-arms', () => {
  const old = withStatedWait(stated('c1', 0), 60)
  waitEvents(withStatedWait(undefined, 60), old, 120)

  const next = withStatedWait(stated('c2', 60), 61, { reviewerWait: old.reviewerWait })
  assert.deepEqual(waitEvents(old, next, 61), [], 'a new refusal inherited the spent wait')
  assert.equal(next.reviewerWait?.fired, false)

  const nextDue = withStatedWait(stated('c2', 60), 62, { reviewerWait: next.reviewerWait })
  assert.equal(waitEvents(next, nextDue, 65).length, 1, 'identical text never fired')

  const olderAgain = withStatedWait(stated('c1', 0), 66, { reviewerWait: nextDue.reviewerWait })
  assert.deepEqual(waitEvents(nextDue, olderAgain, 70), [], 'an older refusal re-armed')
})

test('a failed comment read keeps the previous wait, and a wait due meanwhile fires on the next good read', () => {
  const pending = { commentId: 'c1', updatedAt: at(0), availableAt: at(5), fired: false }
  const previous = withStatedWait(undefined, 1, { reviewerWait: pending })

  const failed = withStatedWait(undefined, 10, { reviewerWaitReadFailed: true })
  assert.deepEqual(waitEvents(previous, failed, 10), [], 'a failed read fired')
  assert.deepEqual(failed.reviewerWait, pending)

  const baseline = withStatedWait(undefined, 0)
  const failedPoll = withStatedWait(undefined, 3, { reviewerWaitReadFailed: true })
  assert.deepEqual(waitEvents(baseline, failedPoll, 3), [])
  assert.equal(failedPoll.reviewerWaitReadAt, at(0), 'a failed read advanced the last good read')

  const goodRead = withStatedWait(stated('c1', 1, 60), 6)
  assert.equal(
    waitEvents(failedPoll, goodRead, 6).length,
    1,
    'a wait that fell due during a failed read was marked spent'
  )
  assert.equal(goodRead.reviewerWaitReadAt, at(6))

  const afterGoodRead = withStatedWait(stated('c1', 0), 90, { reviewerWaitReadAt: at(60) })
  assert.deepEqual(
    waitEvents(afterGoodRead, withStatedWait(stated('c1', 0), 91), 100),
    [],
    'a time already past at the last good read fired'
  )
  assert.equal(
    waitEvents(afterGoodRead, withStatedWait(stated('c2', 69, 60), 91), 100).length,
    1,
    'a time that fell due after the last good read, before the last saved poll, did not fire'
  )
})

test('a new refusal with no stated time is reported once, whether or not a wait was pending', () => {
  const pending = { commentId: 'c1', updatedAt: at(0), availableAt: at(5), fired: false }
  const refusalAt = (minutes: number, commentId = 'c2') => ({ commentId, updatedAt: at(minutes) })
  const refusals = (before: PrState, after: PrState): string[] =>
    compareStates(before, after, [], false, T0 + 3 * MINUTE_MS)
      .filter((c) => c.type === 'CODERABBIT_RATE_LIMITED')
      .map((c) => c.detail)

  const previous = withStatedWait(undefined, 1, { reviewerWait: pending })
  const replaced = withStatedWait(undefined, 3, { untimedRefusal: refusalAt(3) })
  const events = refusals(previous, replaced)
  assert.equal(events.length, 1, 'a replaced wait was cleared silently')
  assert.match(events[0], /no reset time stated/)
  assert.equal(replaced.reviewerWait, undefined)
  assert.deepEqual(replaced.untimedRefusal, refusalAt(3), 'the identity was not carried')

  const reread = withStatedWait(undefined, 4, { untimedRefusal: refusalAt(3) })
  assert.deepEqual(refusals(replaced, reread), [], 'the same refusal read again was reported')

  const edited = withStatedWait(undefined, 5, { untimedRefusal: refusalAt(5) })
  assert.equal(refusals(reread, edited).length, 1, 'an edited refusal was not reported')
  const another = withStatedWait(undefined, 5, { untimedRefusal: refusalAt(5, 'c3') })
  assert.equal(refusals(reread, another).length, 1, 'a newer refusal comment was not reported')

  const afterFired = withStatedWait(undefined, 1, {
    reviewerWait: { ...pending, fired: true },
    untimedRefusal: null,
  })
  assert.equal(
    refusals(afterFired, withStatedWait(undefined, 3, { untimedRefusal: refusalAt(3) })).length,
    1,
    'a refusal after a fired wait was not reported'
  )

  const noBaseline = withStatedWait(undefined, 1)
  assert.deepEqual(
    refusals(noBaseline, withStatedWait(undefined, 3, { untimedRefusal: refusalAt(3) })),
    [],
    'a first poll or a state from before the field reported an old refusal'
  )

  const failed = withStatedWait(undefined, 3, {
    untimedRefusal: undefined,
    reviewerWaitReadFailed: true,
  })
  assert.deepEqual(refusals(previous, failed), [], 'a failed read reported a refusal')
  assert.deepEqual(failed.reviewerWait, pending)
  assert.deepEqual(refusals(replaced, failed), [])
  assert.deepEqual(
    failed.untimedRefusal,
    replaced.untimedRefusal,
    'a failed read dropped the saved one'
  )

  const gone = withStatedWait(undefined, 3, { untimedRefusal: null })
  assert.deepEqual(refusals(previous, gone), [], 'a wait cleared with no refusal left was reported')

  const statusChange = withStatedWait(undefined, 3, {
    untimedRefusal: refusalAt(3),
    coderabbitStatus: 'rate-limited',
    coderabbitCooloffMinutes: null,
  })
  assert.equal(refusals(previous, statusChange).length, 1, 'a second refusal event was emitted')
})

test('a replaced-wait refusal advances the occurrence count, never reuses or zeroes it', () => {
  const pending = { commentId: 'c1', updatedAt: at(0), availableAt: at(5), fired: false }
  const limited = { coderabbitStatus: 'rate-limited' as const, headSha: 'h1' }
  const occurrences = (before: PrState, after: PrState): number[] =>
    compareStates(before, after, [], false, T0 + 3 * MINUTE_MS)
      .filter((c) => c.type === 'CODERABBIT_RATE_LIMITED')
      .map((c) => Number(/occurrence (\d+)/.exec(c.detail)?.[1]))

  const bannerA = withStatedWait(stated('c1', 0), 1, {
    ...limited,
    reviewerWait: pending,
    coderabbitThrottleCount: 1,
  })
  const refusal = { commentId: 'c2', updatedAt: at(3) }
  const bannerB = withStatedWait(undefined, 3, { ...limited, untimedRefusal: refusal })
  assert.deepEqual(occurrences(bannerA, bannerB), [2], 'the replaced wait did not advance')
  assert.equal(bannerB.coderabbitThrottleCount, 2, 'the advanced count was not persisted')

  const reread = withStatedWait(undefined, 4, { ...limited, untimedRefusal: refusal })
  assert.deepEqual(occurrences(bannerB, reread), [], 'a re-read repeated the event')

  const newHead = withStatedWait(undefined, 3, {
    ...limited,
    headSha: 'h2',
    untimedRefusal: refusal,
  })
  assert.deepEqual(occurrences(bannerA, newHead), [2], 'a new head restarted the count')

  const cleared = withStatedWait(undefined, 5, { coderabbitStatus: 'none', headSha: 'h1' })
  const again = withStatedWait(undefined, 6, limited)
  occurrences(bannerB, cleared)
  assert.deepEqual(occurrences(cleared, again), [3], 'a later transition reused a number')
})

test('the rate-limited event states a time only when a reviewer-available for it is still to come', () => {
  const limited = { coderabbitStatus: 'rate-limited' as const, coderabbitCooloffMinutes: 21 }
  const detail = (previous: PrState, current: PrState, nowMinutes: number): string[] =>
    compareStates(previous, current, [], false, T0 + nowMinutes * MINUTE_MS)
      .filter((c) => c.type === 'CODERABBIT_RATE_LIMITED')
      .map((c) => c.detail)

  const passed = withStatedWait(stated('c1', 0, 1260), 120, limited)
  const [passedDetail, ...passedRest] = detail(withStatedWait(undefined, 90), passed, 120)
  assert.match(passedDetail, /no reset time stated/, 'a banner whose reset has passed named a time')
  assert.deepEqual(passedRest, [])

  const newestUnstated = withStatedWait(undefined, 120, {
    ...limited,
    untimedRefusal: { commentId: 'c2', updatedAt: at(120) },
  })
  const [unstatedDetail, ...unstatedRest] = detail(
    withStatedWait(undefined, 90),
    newestUnstated,
    120
  )
  assert.match(unstatedDetail, /no reset time stated/, 'a stale oldest banner stated a time')
  assert.deepEqual(unstatedRest, [])

  const fresh = withStatedWait(stated('c1', 0, 1260), 0, limited)
  const [freshDetail, ...freshRest] = detail(withStatedWait(undefined, 0), fresh, 1)
  assert.match(freshDetail, /next review available at 2026-01-01T00:21:00.000Z/)
  assert.deepEqual(freshRest, [])
  const due = withStatedWait(stated('c1', 0, 1260), 1, {
    ...limited,
    reviewerWait: fresh.reviewerWait,
  })
  assert.equal(
    compareStates(fresh, due, [], false, T0 + 21 * MINUTE_MS).filter(
      (c) => c.type === 'reviewer-available'
    ).length,
    1,
    'a fresh banner never fired at its reset'
  )
})

test('the read anchor is taken before the comments were read, so a refusal posted during the fetch fires', () => {
  const sec = (s: number): string =>
    new Date(Date.parse('2026-01-01T12:00:00Z') + s * 1000).toISOString()
  const previous = { ...cleanBaseline(), timestamp: sec(-60) }
  const firstPoll = { ...cleanBaseline(), timestamp: sec(8), commentsReadStartedAt: sec(0) }
  compareStates(previous, firstPoll, [], false, Date.parse(sec(8)))
  assert.equal(firstPoll.reviewerWaitReadAt, sec(0), 'the anchor was taken after the read')
  assert.equal(
    firstPoll.commentsReadStartedAt,
    undefined,
    'the transient time was left to be saved'
  )

  const secondPoll = {
    ...cleanBaseline(),
    timestamp: sec(20),
    commentsReadStartedAt: sec(12),
    statedReviewerWait: { commentId: 'c1', updatedAt: sec(2), seconds: 5 },
  }
  const events = compareStates(firstPoll, secondPoll, [], false, Date.parse(sec(20))).filter(
    (c) => c.type === 'reviewer-available'
  )
  assert.equal(
    events.length,
    1,
    'a refusal posted after the read and due before the fetch ended was spent'
  )
})

test('the stuck-check baseline survives the store round-trip', () => {
  withIsolatedStore('flow-464-stuck-checks-roundtrip', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', withStuck(ciRun(2)))
    assert.deepEqual(loadState('7', 'owner/repo')?.stuckChecks, ciRun(2))

    saveState('8', 'owner/repo', withStuck(['lint'] as never))
    assert.deepEqual(loadState('8', 'owner/repo')?.stuckChecks, [
      { name: 'lint', runId: '', attempt: 0 },
    ])

    saveState('9', 'owner/repo', withStuck([{ name: 'ci', runId: '77' }] as never))
    assert.deepEqual(loadState('9', 'owner/repo')?.stuckChecks, ciRun(0))
  })
})

test('a pending reviewer wait survives the store round-trip', () => {
  withIsolatedStore('flow-464-reviewer-wait-roundtrip', () => {
    mkdirSync(storeDir(), { recursive: true })
    const wait = { commentId: 'c1', updatedAt: at(0), availableAt: at(5), fired: false }
    saveState('7', 'owner/repo', {
      ...withStatedWait(stated('c1', 0), 1),
      reviewerWait: wait,
      reviewerWaitReadAt: at(1),
    })
    assert.deepEqual(loadState('7', 'owner/repo')?.reviewerWait, wait)
    assert.equal(loadState('7', 'owner/repo')?.reviewerWaitReadAt, at(1))

    const refusal = { commentId: 'c2', updatedAt: at(3) }
    saveState('7', 'owner/repo', { ...withStatedWait(undefined, 3), untimedRefusal: refusal })
    assert.deepEqual(loadState('7', 'owner/repo')?.untimedRefusal, refusal)
    saveState('7', 'owner/repo', { ...withStatedWait(undefined, 4), untimedRefusal: null })
    assert.equal(loadState('7', 'owner/repo')?.untimedRefusal, null)
    saveState('7', 'owner/repo', withStatedWait(undefined, 5))
    assert.equal(loadState('7', 'owner/repo')?.untimedRefusal, undefined)
  })
})

// --- An unreadable thread list must not read as "no open threads" (FLOW-226) ---
//
// fetchUnresolvedThreads is the only fetcher whose failure is fail-OPEN. fetchCiChecks returns {},
// which fails `checks.length > 0`; fetchReviews returns [], which fails `approvals.length > 0`;
// but an empty thread list makes the no-open-threads term TRUE. The claim under test is the
// suppressed emission, not the flag.

const mergeReadyExcept = (overrides: Partial<PrState>): PrState => ({
  ...cleanBaseline(),
  isDraft: false,
  ciChecks: { ci: 'success' },
  reviews: [{ author: 'alice', authorType: 'User', state: 'APPROVED' }],
  mergeStateStatus: 'CLEAN',
  headSha: 'sha1',
  ...overrides,
})

const openThread: ReviewThread = { path: 'a.ts', line: 1, isResolved: false }

test('a merge-ready new head emits MERGE_READY once, and never with ci-green-awaiting-review', () => {
  const types = (previous: PrState, current: PrState): string[] =>
    compareStates(previous, current).map((c) => c.type)
  const h1 = mergeReadyExcept({ headSha: 'sha1' })
  const h2 = mergeReadyExcept({ headSha: 'sha2' })

  const onNewHead = types(h1, h2)
  assert.equal(onNewHead.filter((t) => t === 'MERGE_READY').length, 1, 'new head')
  assert.equal(onNewHead.includes('ci-green-awaiting-review'), false, 'never together')
  assert.deepEqual(
    types(h2, mergeReadyExcept({ headSha: 'sha2' })).filter((t) => t === 'MERGE_READY'),
    [],
    'same head re-fired'
  )
  assert.deepEqual(
    types(mergeReadyExcept({ headSha: undefined }), h2).filter((t) => t === 'MERGE_READY'),
    [],
    'an unknown previous head is not a new head'
  )
})

test('a failed thread fetch emits no MERGE_READY on a PR whose threads are still open (FLOW-226)', () => {
  // The last readable poll saw an open thread; this poll could not read the list at all, so it
  // carries the empty list a failure produces. Nothing resolved that thread in between.
  const previous = mergeReadyExcept({ isDraft: true, unresolvedThreads: [openThread] })
  const current = mergeReadyExcept({ unresolvedThreads: [], fetchFailed: true })
  assert.equal(
    compareStates(previous, current).some((c) => c.type === 'MERGE_READY'),
    false,
    'an unreadable thread list was reported as no open threads'
  )
})

test('a successful zero-thread fetch still emits MERGE_READY (FLOW-226 control)', () => {
  const previous = mergeReadyExcept({ isDraft: true, unresolvedThreads: [openThread] })
  const current = mergeReadyExcept({ unresolvedThreads: [], fetchFailed: false })
  assert.equal(
    compareStates(previous, current).some((c) => c.type === 'MERGE_READY'),
    true,
    'without this the suppression above proves only that MERGE_READY was broken outright'
  )
})

// The flag has to survive the store, not just the poll: isMergeReady runs on `previous` too, and
// `previous` is whatever loadState returns.
test('a failed thread fetch stays failed across the store round-trip (FLOW-226)', () => {
  withIsolatedStore('flow-226-fetch-failed-roundtrip', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ fetchFailed: true }))
    assert.equal(loadState('7', 'owner/repo')?.fetchFailed, true)

    const reloaded = loadState('7', 'owner/repo')
    assert.ok(reloaded)
    assert.equal(
      compareStates(reloaded, mergeReadyExcept({ fetchFailed: false })).some(
        (c) => c.type === 'MERGE_READY'
      ),
      true,
      'the first trustworthy read after a failure must still fire the edge'
    )
  })
})

// A legacy entry's empty thread list may be an unreadable fetch, and there is no way to tell now.
// Defaulting it to succeeded would let it read merge-ready as `previous` and swallow the next real
// MERGE_READY -- a suppressed true positive, which is silent. Defaulting it to failed can only
// cost one redundant emission of a statement that is true when it is made.
// Same rule as fetchFailed above, for the checks read: an entry written before the field existed
// carries a check set nothing recorded the completeness of, so it cannot be called green.
test('a stored entry predating ciChecksFetchFailed loads as failed (FLOW-226)', () => {
  withIsolatedStore('flow-226-ci-checks-failed-legacy', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ ciChecksFetchFailed: false }))

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    const entry = raw.prs['owner/repo#7']
    assert.ok('ciChecksFetchFailed' in entry.state, 'setup: the field must be there to remove')
    delete entry.state.ciChecksFetchFailed
    writeFileSync(statePath(), JSON.stringify(raw))

    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded)
    assert.equal(loaded.ciChecksFetchFailed, true)
    assert.equal(
      compareStates({ ...loaded, isDraft: true }, loaded).some((c) => c.type === 'MERGE_READY'),
      false,
      'a legacy entry was reported as every check green'
    )
  })
})

// isCiGreenOnDraft is the second consumer of the green test and gates its own event, so it needs
// its own guard and its own proof — a fix to isMergeReady alone leaves this one reading truncated.
test('a draft with a truncated green checks read emits no CI_GREEN_ON_DRAFT (FLOW-226)', () => {
  const draft = (ciChecksFetchFailed: boolean): PrState => ({
    ...cleanBaseline(),
    isDraft: true,
    ciChecks: { build: 'success' },
    ciChecksFetchFailed,
    headSha: 'sha1',
  })
  const emits = (state: PrState): boolean =>
    compareStates({ ...state, ciChecks: {}, ciChecksFetchFailed: false }, state).some(
      (c) => c.type === 'CI_GREEN_ON_DRAFT'
    )

  assert.equal(emits(draft(false)), true, 'a complete green run on a draft must still emit')
  assert.equal(
    emits(draft(true)),
    false,
    'a truncated check set was reported as every check green on a draft'
  )
})

test('a stored entry predating fetchFailed loads as failed, not as a clean read (FLOW-226)', () => {
  withIsolatedStore('flow-226-fetch-failed-legacy', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ fetchFailed: false }))

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    const entry = raw.prs['owner/repo#7']
    assert.ok('fetchFailed' in entry.state, 'setup: the field must be there before it is removed')
    delete entry.state.fetchFailed
    writeFileSync(statePath(), JSON.stringify(raw))

    assert.equal(loadState('7', 'owner/repo')?.fetchFailed, true)
  })
})

// Plants a state object the type system would reject, which is the point: the store is JSON on
// disk that a crash, a partial write or an older build can leave in any shape at all.
const plantRawState = (prNumber: string, rawState: unknown): void => {
  mkdirSync(storeDir(), { recursive: true })
  writeFileSync(
    statePath(),
    JSON.stringify({
      prs: { [`owner/repo#${prNumber}`]: { state: rawState, updatedAt: new Date().toISOString() } },
    })
  )
}

// `null` is the discriminating input, not `""`. Both are wrong shapes, but `""` reaches
// compareStates' own `.map` and throws there, and that throw absorbs the mutation: remove the
// guard and the test goes red on a TypeError without ever evaluating the merge decision, which
// leaves the collapse this test exists for unproven. `?? []` swallows `null` silently instead, so
// it survives every mechanism upstream and fails on the assertion itself.
test('a persisted thread list of null is told apart from a genuinely empty one (FLOW-226)', () => {
  withIsolatedStore('flow-226-thread-list-shape', () => {
    const ready = mergeReadyExcept({ unresolvedThreads: [], fetchFailed: false })

    plantRawState('7', ready)
    const genuinelyEmpty = loadState('7', 'owner/repo')
    assert.ok(genuinelyEmpty)
    const emptyEmits = compareStates(genuinelyEmpty, mergeReadyExcept({})).some(
      (c) => c.type === 'MERGE_READY'
    )

    plantRawState('7', { ...ready, unresolvedThreads: null })
    const wrongShape = loadState('7', 'owner/repo')
    assert.ok(wrongShape, 'a wrong-shaped field must not discard the entry')
    const wrongShapeEmits = compareStates(wrongShape, mergeReadyExcept({})).some(
      (c) => c.type === 'MERGE_READY'
    )

    // Asserted against the merge decision, not the normalizer's return value: `[]` is what BOTH
    // produce for the list itself, so the list cannot discriminate them.
    assert.equal(emptyEmits, false, 'a genuinely empty list must still read as merge-ready')
    assert.equal(
      wrongShapeEmits,
      true,
      'a thread list that could not be read was reported as no open threads'
    )
    assert.notEqual(
      wrongShapeEmits,
      emptyEmits,
      'the two states must not reach the merge decision as the same answer'
    )
  })
})

// The shapes `null` cannot cover: these reach a `.map`/`.filter` in compareStates, which poll.ts
// does not guard, so before the fix they crashed the poll rather than collapsing quietly. Asserted
// separately because their failure is a throw, and a throw cannot be told apart from the
// assertion above firing for its own reason.
test('a persisted thread list of the wrong type fails closed instead of throwing (FLOW-226)', () => {
  withIsolatedStore('flow-226-thread-list-throwing-shapes', () => {
    for (const shape of ['', { length: 0 }, {}, 0]) {
      plantRawState(
        '7',
        mergeReadyExcept({ fetchFailed: false, unresolvedThreads: shape as never })
      )
      const loaded = loadState('7', 'owner/repo')
      assert.ok(loaded, `a thread list of ${JSON.stringify(shape)} discarded the entry`)
      assert.equal(
        compareStates(loaded, mergeReadyExcept({})).some((c) => c.type === 'MERGE_READY'),
        true,
        `a thread list of ${JSON.stringify(shape)} was reported as no open threads`
      )
    }
  })
})

// botComments has no silent route: `null` normalizes to `[]` both before and after the fix, so
// the only observable difference is the throw a non-array used to cause in compareStates.
test('a persisted botComments of the wrong type does not throw in compareStates (FLOW-226)', () => {
  withIsolatedStore('flow-226-bot-comments-shape', () => {
    const newComment = { id: 'c1', author: 'bot', body: 'hi' }

    for (const shape of ['', [null], {}]) {
      plantRawState('7', mergeReadyExcept({ botComments: shape as never }))
      const loaded = loadState('7', 'owner/repo')
      assert.ok(loaded, `a botComments of ${JSON.stringify(shape)} discarded the entry`)
      const changes = compareStates(
        loaded,
        mergeReadyExcept({ botComments: [newComment] as never })
      )
      assert.equal(
        changes.some((c) => c.type === 'NEW_BOT_COMMENTS'),
        true,
        `a botComments of ${JSON.stringify(shape)} lost the new bot comment`
      )
    }
  })
})

// normalizeState runs inside loadStore's try, whose catch returns an empty store. A `.map` over a
// wrong shape therefore throws where nothing reports it, and the entry that is discarded is every
// entry -- including PRs whose own state was written perfectly.
test("one PR's malformed reviews does not discard another PR's persisted state (FLOW-226)", () => {
  withIsolatedStore('flow-226-normalize-blast-radius', () => {
    mkdirSync(storeDir(), { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      statePath(),
      JSON.stringify({
        prs: {
          'owner/repo#7': { state: mergeReadyExcept({ headSha: 'intact' }), updatedAt: now },
          'owner/repo#8': { state: { ...mergeReadyExcept({}), reviews: '' }, updatedAt: now },
        },
      })
    )

    assert.equal(
      loadState('7', 'owner/repo')?.headSha,
      'intact',
      'a malformed neighbour discarded the state of a PR that was written correctly'
    )
    assert.ok(loadState('8', 'owner/repo'), 'the malformed entry itself must survive too')
  })
})

// Object.values(['success']) is ['success'], so an array where a record belongs satisfies
// `every(s => s === 'success')` and reads as a full green CI run.
test('a persisted ciChecks array does not read as every check green (FLOW-226)', () => {
  withIsolatedStore('flow-226-cichecks-shape', () => {
    plantRawState('7', { ...mergeReadyExcept({}), ciChecks: ['success'] })
    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded)
    assert.equal(
      compareStates(loaded, mergeReadyExcept({})).some((c) => c.type === 'MERGE_READY'),
      true,
      'an array of status strings was accepted as the set of CI checks'
    )
  })
})

// The ternary's own consumer. `ciChecksFetchFailed` gates the merge decision, but the per-check
// diffing below it reads `Object.entries(current.ciChecks)` regardless of the flag, and an array
// there yields one entry per index -- check names "0" and "1" with no run behind them.
test('a persisted ciChecks array is normalized away, not kept by index (FLOW-226)', () => {
  withIsolatedStore('flow-226-cichecks-normalized', () => {
    plantRawState('7', { ...mergeReadyExcept({}), ciChecks: ['success', 'failure'] })
    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded)
    assert.deepEqual(
      Object.keys(loaded.ciChecks),
      [],
      'an array survived normalization, so its indices became CI check names'
    )
  })
})

// A non-array object with a non-string value (e.g. a boolean or number) passed the old shape check
// too -- it only excluded arrays, never checked what the values inside actually were.
test('a persisted ciChecks with a non-string value is normalized away, not kept as-is (FLOW-226)', () => {
  withIsolatedStore('flow-226-cichecks-value-shape', () => {
    plantRawState('7', {
      ...mergeReadyExcept({}),
      ciChecksFetchFailed: false,
      ciChecks: { build: 200 },
    })
    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded)
    assert.deepEqual(loaded.ciChecks, {}, 'a non-string check value survived normalization')
    assert.equal(
      loaded.ciChecksFetchFailed,
      true,
      'a wrong-shaped ciChecks did not force ciChecksFetchFailed'
    )
  })
})

// `??` fires only on null and undefined, so a falsy NON-boolean in the store file passes straight
// through: `!(0 ?? true)` is `true`, and a corrupted `fetchFailed` then reads as "the fetch
// succeeded" over the empty thread list a failed fetch leaves behind.
const assertFalsyFieldNormalizes = (
  sessionId: string,
  field: 'fetchFailed' | 'isDraft' | 'coderabbitSkipped' | 'ciGreenOnDraftFired',
  saved: PrState,
  expected: boolean
): void => {
  withIsolatedStore(sessionId, () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', saved)

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    const entry = raw.prs['owner/repo#7']
    assert.ok(field in entry.state, `setup: ${field} must be present before it is corrupted`)
    entry.state[field] = 0
    writeFileSync(statePath(), JSON.stringify(raw))
    assert.equal(
      JSON.parse(readFileSync(statePath(), 'utf8')).prs['owner/repo#7'].state[field],
      0,
      `setup: ${field} must read back as 0 from the store file before the reload`
    )

    const loaded = loadState('7', 'owner/repo')
    assert.ok(
      loaded,
      'the corrupted entry must still load, or the assertion below passes vacuously'
    )
    assert.equal(
      loaded.headSha,
      saved.headSha,
      'the loaded entry must be the planted one, not a fresh baseline'
    )
    assert.equal(
      loaded[field],
      expected,
      `${field} came back as ${JSON.stringify(loaded[field])}; a persisted 0 must normalize to ${expected}`
    )
  })
}

test('a persisted fetchFailed of 0 loads as failed, not as a clean read (FLOW-226)', () => {
  assertFalsyFieldNormalizes(
    'flow-226-falsy-fetch-failed',
    'fetchFailed',
    mergeReadyExcept({ fetchFailed: false }),
    true
  )
})

test('a persisted isDraft of 0 loads as a draft, not as ready for review (FLOW-226)', () => {
  assertFalsyFieldNormalizes(
    'flow-226-falsy-is-draft',
    'isDraft',
    mergeReadyExcept({ isDraft: false }),
    true
  )
})

test('a persisted coderabbitSkipped of 0 loads as not skipped (FLOW-226)', () => {
  assertFalsyFieldNormalizes(
    'flow-226-falsy-coderabbit-skipped',
    'coderabbitSkipped',
    mergeReadyExcept({ coderabbitSkipped: true }),
    false
  )
})

// `??` fires only on null and undefined, so a wrong-TYPE non-boolean value in the store file
// passes straight through unlike the booleanOr fields above: a numeric headSha survives into
// `.slice(0, 7)` (compareStates) and a string throttle count survives into `+ 1` (recordCoderabbitRun).
test('a persisted headSha of the wrong type normalizes to empty, not passed through (FLOW-226)', () => {
  withIsolatedStore('flow-226-headsha-wrong-shape', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ headSha: 'sha1' }))

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    raw.prs['owner/repo#7'].state.headSha = 12345
    writeFileSync(statePath(), JSON.stringify(raw))

    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded, 'the corrupted entry must still load')
    assert.equal(typeof loaded.headSha, 'string', 'a non-string headSha must normalize to a string')
    assert.equal(loaded.headSha, '', 'a wrong-typed headSha falls back to empty, not the raw value')
  })
})

test('a persisted coderabbitThrottleCount of the wrong type normalizes to 0, not passed through (FLOW-226)', () => {
  withIsolatedStore('flow-226-throttle-wrong-shape', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ coderabbitThrottleCount: 3, headSha: 'sha1' }))

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    raw.prs['owner/repo#7'].state.coderabbitThrottleCount = 'not-a-number'
    writeFileSync(statePath(), JSON.stringify(raw))

    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded, 'the corrupted entry must still load')
    assert.equal(
      typeof loaded.coderabbitThrottleCount,
      'number',
      'a non-number throttle count must normalize to a number'
    )
    assert.equal(loaded.coderabbitThrottleCount, 0, 'a wrong-typed count falls back to 0')
  })
})

test('a persisted ciGreenOnDraftFired of 0 loads as not fired (FLOW-226)', () => {
  assertFalsyFieldNormalizes(
    'flow-226-falsy-ci-green-fired',
    'ciGreenOnDraftFired',
    mergeReadyExcept({ ciGreenOnDraftFired: true }),
    false
  )
})

// Previous poll: a draft (so isMergeReady(previous) is false and a MERGE_READY transition
// is possible).
const draftPrevious: PrState = { ...cleanBaseline(), isDraft: true, headSha: 'sha1' }

// The founding defect's end state, reached through the store rather than asserted on a field.
const assertMergeReadyAfterPlantedFetchFailed = (
  sessionId: string,
  onDisk: unknown,
  expected: boolean
): void => {
  withIsolatedStore(sessionId, () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ fetchFailed: false }))

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    raw.prs['owner/repo#7'].state.fetchFailed = onDisk
    writeFileSync(statePath(), JSON.stringify(raw))

    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded, 'the planted entry must load, or the assertion below passes vacuously')
    assert.equal(
      compareStates(draftPrevious, loaded).some((c) => c.type === 'MERGE_READY'),
      expected,
      `a persisted fetchFailed of ${JSON.stringify(onDisk)} reached the wrong MERGE_READY verdict`
    )
  })
}

test('a persisted fetchFailed of 0 keeps MERGE_READY from firing (FLOW-226)', () => {
  assertMergeReadyAfterPlantedFetchFailed('flow-226-merge-ready-falsy', 0, false)
})

// Positive control for the test above: the identical entry carrying a real `false` does reach
// MERGE_READY, so the suppression is the corrupted value and not a fixture that never qualified.
test('a persisted fetchFailed of false still reaches MERGE_READY (FLOW-226)', () => {
  assertMergeReadyAfterPlantedFetchFailed('flow-226-merge-ready-boolean', false, true)
})

test('MERGE_READY fires when the sole reviewer APPROVED then COMMENTED (FLOW-175)', () => {
  const curr = readyGreenClean([
    { author: 'coderabbitai', authorType: 'Bot', state: 'APPROVED' },
    { author: 'coderabbitai', authorType: 'Bot', state: 'COMMENTED' },
  ])
  assert.equal(
    compareStates(draftPrevious, curr).some((c) => c.type === 'MERGE_READY'),
    true
  )
})

test('a trailing CHANGES_REQUESTED after APPROVED is not merge-ready', () => {
  const curr = readyGreenClean([
    { author: 'alice', authorType: 'User', state: 'APPROVED' },
    { author: 'alice', authorType: 'User', state: 'CHANGES_REQUESTED' },
  ])
  assert.equal(
    compareStates(draftPrevious, curr).some((c) => c.type === 'MERGE_READY'),
    false
  )
})

test('the latest decision wins: CHANGES_REQUESTED then APPROVED then COMMENTED is approved', () => {
  const curr = readyGreenClean([
    { author: 'alice', authorType: 'User', state: 'CHANGES_REQUESTED' },
    { author: 'alice', authorType: 'User', state: 'APPROVED' },
    { author: 'alice', authorType: 'User', state: 'COMMENTED' },
  ])
  assert.equal(
    compareStates(draftPrevious, curr).some((c) => c.type === 'MERGE_READY'),
    true
  )
})

test('a DISMISSED review after APPROVED is not merge-ready', () => {
  const curr = readyGreenClean([
    { author: 'alice', authorType: 'User', state: 'APPROVED' },
    { author: 'alice', authorType: 'User', state: 'DISMISSED' },
  ])
  assert.equal(
    compareStates(draftPrevious, curr).some((c) => c.type === 'MERGE_READY'),
    false
  )
})

test('MERGE_READY counts APPROVED-then-COMMENTED as a standing approval, not a retracted one', () => {
  const previous = cleanBaseline()
  const current: PrState = {
    ...cleanBaseline(),
    isDraft: false,
    ciChecks: { build: 'success' },
    reviews: [
      { author: 'coderabbitai', authorType: 'Bot', state: 'APPROVED' },
      { author: 'coderabbitai', authorType: 'Bot', state: 'COMMENTED' },
    ],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  }
  const changes = compareStates(previous, current)
  assert.ok(changes.some((c) => c.type === 'MERGE_READY'))
})

test('MERGE_READY does not fire when the latest decision requests changes', () => {
  const previous = cleanBaseline()
  const current: PrState = {
    ...cleanBaseline(),
    isDraft: false,
    ciChecks: { build: 'success' },
    reviews: [
      { author: 'reviewer', authorType: 'User', state: 'APPROVED' },
      { author: 'reviewer', authorType: 'User', state: 'CHANGES_REQUESTED' },
    ],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  }
  const changes = compareStates(previous, current)
  assert.ok(!changes.some((c) => c.type === 'MERGE_READY'))
})

test('a standing CHANGES_REQUESTED from another author blocks merge readiness (FLOW-175)', () => {
  const curr = readyGreenClean([
    { author: 'alice', authorType: 'User', state: 'APPROVED' },
    { author: 'bob', authorType: 'User', state: 'CHANGES_REQUESTED' },
  ])
  assert.equal(
    compareStates(draftPrevious, curr).some((c) => c.type === 'MERGE_READY'),
    false
  )
})

// --- FLOW-261: a pre-upgrade store must still load ---

test('a store entry written by the pre-FLOW-261 version (carrying `quiet`) still loads', () => {
  // FLOW-261 dropped QuietClock from StoreEntry. A monitor upgrading in place reads a file its
  // previous version wrote, so the reader must tolerate the dropped field rather than reject the
  // file — rejecting it would fall back to cleanBaseline() and re-emit every transition already
  // seen, which is the exact wake this story removes.
  const originalHome = process.env.HOME
  const originalSession = process.env.CLAUDE_CODE_SESSION_ID
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-'))
  process.env.HOME = homeDir
  process.env.CLAUDE_CODE_SESSION_ID = 'flow-261-legacy-store-test'
  try {
    const legacy = {
      prs: {
        'owner/repo#7': {
          state: { prState: 'OPEN', isDraft: true, headSha: 'abc123' },
          updatedAt: new Date().toISOString(),
          quiet: {
            fingerprint: 'deadbeef',
            stableSince: new Date().toISOString(),
            stallFired: true,
          },
        },
      },
    }
    atomicWrite(statePath(), JSON.stringify(legacy))
    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded)
    assert.equal(loaded?.headSha, 'abc123')
    assert.equal(loaded?.prState, 'OPEN')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = originalSession
  }
})

// --- FLOW-261: suppress self-posted review threads ---

test('a thread whose first comment this session posted does not emit NEW_THREADS', () => {
  const previous: PrState = { ...cleanBaseline(), unresolvedThreads: [] }
  const current: PrState = {
    ...cleanBaseline(),
    unresolvedThreads: [
      {
        path: 'src/a.ts',
        line: 10,
        isResolved: false,
        firstCommentBody: 'claude says: fixed in 1234567.',
        firstCommentId: 'PRRC_self',
      },
    ],
  }
  const changes = compareStates(previous, current, ['PRRC_self'])
  assert.ok(!changes.some((c) => c.type === 'NEW_THREADS'))
})

test('a thread from any other participant still emits NEW_THREADS while a self-reply is suppressed', () => {
  const previous: PrState = { ...cleanBaseline(), unresolvedThreads: [] }
  const current: PrState = {
    ...cleanBaseline(),
    unresolvedThreads: [
      {
        path: 'src/a.ts',
        line: 10,
        isResolved: false,
        firstCommentBody: 'mine',
        firstCommentId: 'PRRC_self',
      },
      {
        path: 'src/b.ts',
        line: 20,
        isResolved: false,
        firstCommentBody: 'theirs',
        firstCommentId: 'PRRC_other',
      },
    ],
  }
  const changes = compareStates(previous, current, ['PRRC_self'])
  const newThreads = changes.filter((c) => c.type === 'NEW_THREADS')
  assert.equal(newThreads.length, 1)
  assert.match(newThreads[0].detail, /src\/b\.ts/)
  assert.doesNotMatch(newThreads[0].detail, /src\/a\.ts/)
  assert.match(newThreads[0].detail, /1 new unresolved review thread/)
})

test('a thread with no recorded id still emits — suppression is opt-in per comment, never a default', () => {
  const previous: PrState = { ...cleanBaseline(), unresolvedThreads: [] }
  const current: PrState = {
    ...cleanBaseline(),
    unresolvedThreads: [
      {
        path: 'src/a.ts',
        line: 10,
        isResolved: false,
        firstCommentBody: 'finding',
        firstCommentId: '',
      },
    ],
  }
  const changes = compareStates(previous, current, ['PRRC_self'])
  assert.ok(changes.some((c) => c.type === 'NEW_THREADS'))
})

test('compareStates reports a new main comment and suppresses one this session posted', () => {
  const previous = { ...cleanBaseline(), isDraft: false }
  const current = {
    ...cleanBaseline(),
    isDraft: false,
    mainComments: [
      { id: 'IC_theirs', author: 'octo-reviewer' },
      { id: 'IC_mine', author: 'octo-reviewer' },
      { id: 'PRR_mine', author: 'octo-reviewer' },
    ],
  }
  const types = compareStates(previous, current, ['IC_mine', 'PRR_mine']).map((c) => c.type)
  assert.deepEqual(types, ['new-main-comments'])
  const detail = compareStates(previous, current, ['IC_mine', 'PRR_mine']).find(
    (c) => c.type === 'new-main-comments'
  )?.detail
  assert.equal(detail, '1 new main review comment from: octo-reviewer')
})

test('a thread opened by another participant that this session later replied into still emits — only the first comment identifies the thread', () => {
  const previous: PrState = { ...cleanBaseline(), unresolvedThreads: [] }
  const rawThreads = toReviewThreads([
    {
      isResolved: false,
      path: 'src/a.ts',
      line: 10,
      comments: {
        nodes: [
          { id: 'PRRC_other', author: { login: 'reviewer' }, body: 'theirs' },
          { id: 'PRRC_self', author: { login: 'octo-reviewer' }, body: 'claude says: fixed' },
        ],
      },
    },
  ])
  assert.equal(rawThreads[0].firstCommentId, 'PRRC_other')
  const current: PrState = { ...cleanBaseline(), unresolvedThreads: rawThreads }
  const changes = compareStates(previous, current, ['PRRC_self'])
  assert.ok(changes.some((c) => c.type === 'NEW_THREADS'))
})

const withIsolatedStore = (sessionId: string, fn: () => void): void => {
  const originalHome = process.env.HOME
  const originalSession = process.env.CLAUDE_CODE_SESSION_ID
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-selfcomments-'))
  process.env.HOME = homeDir
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  try {
    fn()
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = originalSession
  }
}

test('readStoreRaw: a code that does not confirm existence is not reported as "exists" (FLOW-226 finding 582cd68b4540)', () => {
  withIsolatedStore('flow-226-readstoreraw-existence', () => {
    // A file where the store's own directory belongs, rather than at state.json itself: readFileSync
    // fails resolving that path component before state.json is ever reached, so the failure is
    // ENOTDIR — a code that says nothing about whether the store exists.
    mkdirSync(join(storeDir(), '..'), { recursive: true })
    writeFileSync(storeDir(), '')
    assert.throws(
      () => readFileSync(statePath(), 'utf-8'),
      /ENOTDIR/,
      'precondition: the fixture must actually block traversal, or this test observes nothing'
    )

    const originalConsoleError = console.error
    const errors: unknown[] = []
    console.error = (...args: unknown[]) => {
      errors.push(args[0])
    }
    try {
      assert.doesNotThrow(() => loadState('7', 'owner/repo'))
    } finally {
      console.error = originalConsoleError
    }

    const message = errors.find((msg) => typeof msg === 'string') as string | undefined
    assert.ok(message, 'expected a diagnostic for the unreadable store')
    assert.match(message, /could not be confirmed to exist or be read \(ENOTDIR\)/)
    assert.doesNotMatch(message, /^pr-monitor: state store exists/)
  })
})

test('recordSelfComment persists across a store reload and is idempotent per id', () => {
  withIsolatedStore('flow-261-record-persist', () => {
    recordSelfComment('7', 'owner/repo', 'PRRC_a')
    recordSelfComment('7', 'owner/repo', 'PRRC_a')
    recordSelfComment('7', 'owner/repo', 'PRRC_b')
    assert.deepEqual(loadSelfCommentIds('7', 'owner/repo'), ['PRRC_a', 'PRRC_b'])
  })
})

test('recordSelfComment before any poll does not fabricate a PR baseline', () => {
  withIsolatedStore('flow-261-record-no-baseline', () => {
    recordSelfComment('7', 'owner/repo', 'PRRC_a')
    assert.equal(loadState('7', 'owner/repo'), null)
  })
})

test('deleteState drops the self-comment ids with the PR entry', () => {
  withIsolatedStore('flow-261-delete-drops-ids', () => {
    saveState('7', 'owner/repo', cleanBaseline())
    recordSelfComment('7', 'owner/repo', 'PRRC_a')
    deleteState('7', 'owner/repo')
    assert.deepEqual(loadSelfCommentIds('7', 'owner/repo'), [])
  })
})

test('saveState on a no-change poll cycle does not drop previously recorded self-comment ids', () => {
  withIsolatedStore('flow-261-savestate-preserves-ids', () => {
    recordSelfComment('7', 'owner/repo', 'PRRC_a')
    saveState('7', 'owner/repo', cleanBaseline())
    assert.deepEqual(loadSelfCommentIds('7', 'owner/repo'), ['PRRC_a'])
  })
})

test('a store lock naming a dead pid is reclaimed immediately, not after the staleness window (FLOW-261 round 4 finding e7dec286ee42)', () => {
  withIsolatedStore('flow-261-lock-dead-pid', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, acquiredAt: new Date().toISOString() })
    )
    assert.ok(
      existsSync(storeLockPath()),
      'setup: the planted dead-pid lock must exist at the real store lock path before the reclaim'
    )

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reclaimed-dead-pid' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reclaimed-dead-pid')
    const surviving = existsSync(storeLockPath()) ? readFileSync(storeLockPath(), 'utf8') : null
    assert.equal(
      surviving,
      null,
      `a dead pid must not read as a live holder; the lock file survived holding ${surviving}`
    )
  })
})

test('a store lock with an unparseable acquiredAt is reclaimed, not held forever (FLOW-261 round 4 finding 6ad03bea3071)', () => {
  withIsolatedStore('flow-261-lock-bad-date', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    // pid 1, not process.pid: on the held-forever path the lock is never acquired, so
    // releaseStoreLock's ownership check decides whether the file survives — our own pid would
    // make it remove the planted file there too and the assertion below would hold either way.
    writeFileSync(lockPath, JSON.stringify({ pid: 1, acquiredAt: 'not-a-date' }))
    assert.ok(
      existsSync(storeLockPath()),
      'setup: the planted unparseable-date lock must exist at the real store lock path before the reclaim'
    )

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reclaimed-bad-date' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reclaimed-bad-date')
    const surviving = existsSync(storeLockPath()) ? readFileSync(storeLockPath(), 'utf8') : null
    assert.equal(
      surviving,
      null,
      `an unparseable acquiredAt must not hold the lock; the lock file survived holding ${surviving}`
    )
  })
})

test("exhausting the store lock wait budget on a live foreign holder degrades instead of crashing the monitor, and never deletes that holder's lock (FLOW-261 round 4 findings f4ee53151a78, d71fee5b5489)", () => {
  withIsolatedStore('flow-261-lock-degrade', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    const foreignPid = process.ppid
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: foreignPid, acquiredAt: new Date().toISOString() })
    )
    const originalConsoleError = console.error
    const errors: unknown[] = []
    console.error = (...args: unknown[]) => {
      errors.push(args[0])
    }
    try {
      assert.doesNotThrow(() =>
        saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'degraded-write' })
      )
    } finally {
      console.error = originalConsoleError
    }
    assert.ok(
      errors.some(
        (msg) => typeof msg === 'string' && msg.includes('could not acquire the store write lock')
      ),
      'expected a diagnostic instead of a thrown error'
    )
    assert.equal(loadState('7', 'owner/repo')?.headSha, 'degraded-write')
    const survivingLock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number }
    assert.equal(
      survivingLock.pid,
      foreignPid,
      "releaseStoreLock must never delete a lock it doesn't own"
    )
  })
})

test('a live holder with a calendar-invalid acquiredAt is degraded around, not reclaimed (FLOW-226 finding 7fa1fa3e7d27)', () => {
  withIsolatedStore('flow-226-lock-nan-age', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    const foreignPid = process.ppid
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: foreignPid, acquiredAt: '2024-13-01T00:00:00.000Z' })
    )
    const originalConsoleError = console.error
    const errors: unknown[] = []
    console.error = (...args: unknown[]) => {
      errors.push(args[0])
    }
    try {
      assert.doesNotThrow(() =>
        saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'nan-age-degraded-write' })
      )
    } finally {
      console.error = originalConsoleError
    }
    assert.ok(
      errors.some(
        (msg) => typeof msg === 'string' && msg.includes('could not acquire the store write lock')
      ),
      'expected a diagnostic instead of a thrown error'
    )
    assert.equal(loadState('7', 'owner/repo')?.headSha, 'nan-age-degraded-write')
    const survivingLock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number }
    assert.equal(
      survivingLock.pid,
      foreignPid,
      'a live holder with an unparseable-but-shape-valid acquiredAt must not have its lock stolen'
    )
  })
})

test('releaseStoreLock never deletes a lock it could not read well enough to identify as its own (FLOW-261 round 5 finding 849f8457bd67)', () => {
  withIsolatedStore('flow-261-lock-release-null-branch', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    const foreignPid = process.ppid
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: foreignPid, acquiredAt: new Date().toISOString() })
    )

    // Replaces the still-present foreign lock with unparseable content the instant acquireStoreLock
    // gives up on it and degrades — console.error is the last statement degradeStoreLockAcquire runs
    // before returning, so this lands deterministically between "acquire gave up" and "this call's
    // own release() runs," with no timing race: readStoreLockData will return null for it exactly as
    // it would for a lock this process genuinely could not parse.
    const garbageLockContent = 'not valid json — simulating an unparseable foreign lock'
    const originalConsoleError = console.error
    console.error = () => {
      writeFileSync(lockPath, garbageLockContent)
    }
    try {
      saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'release-null-branch' })
    } finally {
      console.error = originalConsoleError
    }

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'release-null-branch')
    assert.equal(
      readFileSync(lockPath, 'utf-8'),
      garbageLockContent,
      "releaseStoreLock must never delete a lock it doesn't own"
    )
  })
})

test('an abandoned store lock temp file older than the staleness window is reaped on the next acquire', () => {
  withIsolatedStore('flow-261-lock-reap', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    const abandonedTemp = `${lockPath}.999999.0.tmp`
    writeFileSync(abandonedTemp, JSON.stringify({ pid: 999_999_999, acquiredAt: 'irrelevant' }))
    const old = new Date(Date.now() - 40_000)
    utimesSync(abandonedTemp, old, old)

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reap-check' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reap-check')
    assert.ok(
      !existsSync(abandonedTemp),
      'an abandoned temp file past the staleness window must be reaped, not left to litter the store dir'
    )
    assert.deepEqual(
      readdirSync(storeDir()).filter((name) => name.endsWith('.tmp')),
      [],
      'no other temp file should remain either'
    )
  })
})

// recordSelfComment (the --ack-comment process) and saveState (the poller's every-cycle write) each
// do a whole-store read-modify-write in a SEPARATE os process, with no shared call stack — a
// single-process test cannot exercise the interleaving a lost update needs. Real child processes,
// barrier-synchronized like lock.race-child.ts's mandatory multi-process test, are required.
const storeRaceChild = join(import.meta.dirname, 'test', 'store-race-child.ts')

// Deadline for the parent-side readiness barrier below — bounds only the wait BEFORE GO is
// broadcast. What bounds the race itself after GO is the store lock's bounded retry-then-degrade
// loop (STORE_LOCK_MAX_ATTEMPTS/STORE_LOCK_RETRY_DELAY_MS in state.ts), not this constant.
const READY_BARRIER_TIMEOUT_MS = 5000

// Backstop for tests that await their spawned child directly, with no readiness barrier of their
// own to bound the wait if the child process never completes — a stalled module load, a `close`
// that never fires — regardless of what its own internal logic would otherwise do.
const SPAWN_TIMEOUT_BACKSTOP_MS = 5000

// Surfaces exit code, signal, stdout, and stderr to the caller instead of picking a pass/fail
// verdict itself — mirroring lock.test.ts's runLockRaceChild — so each test asserts what its own
// scenario requires and can isolate HOME/CLAUDE_CODE_SESSION_ID per call. Listens on 'close', not
// 'exit': stdio can still be open when 'exit' fires, and stderr content is load-bearing here.
const runStoreRaceChild = (
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number
): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', storeRaceChild, ...args],
      { env, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout: stdout.trim(), stderr }))
  })

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('recordSelfComment run concurrently with saveState across repeated real cross-process races never loses the recorded id (FLOW-261 finding 226a2a5d12a8)', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-'))
  const originalHome = process.env.HOME
  const originalSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.HOME = homeDir
  process.env.CLAUDE_CODE_SESSION_ID = 'flow-261-store-race'
  const TRIALS = 20
  try {
    for (let trial = 0; trial < TRIALS; trial++) {
      const commentId = `PRRC_race_${trial}`
      const barrierDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-barrier-'))
      const goPath = join(barrierDir, 'go')
      const readyRecord = join(barrierDir, 'ready.record')
      const readySave = join(barrierDir, 'ready.save')
      try {
        const recordPromise = runStoreRaceChild([
          'record',
          '7',
          'owner/repo',
          commentId,
          readyRecord,
          goPath,
        ])
        const savePromise = runStoreRaceChild([
          'save',
          '7',
          'owner/repo',
          `sha-${trial}`,
          readySave,
          goPath,
        ])

        // Genuine readiness barrier (not a wall-clock guess): wait until both children have
        // signalled ready before broadcasting GO, so both reach their racy call at (as close as
        // possible to) the same instant.
        const deadline = Date.now() + READY_BARRIER_TIMEOUT_MS
        while ((!existsSync(readyRecord) || !existsSync(readySave)) && Date.now() < deadline) {
          await sleepMs(5)
        }
        assert.ok(
          existsSync(readyRecord) && existsSync(readySave),
          'precondition: both children signalled ready before GO'
        )
        writeFileSync(goPath, '')

        const [recordResult, saveResult] = await Promise.all([recordPromise, savePromise])
        assert.equal(recordResult.code, 0, `record child failed: ${recordResult.stderr}`)
        assert.equal(saveResult.code, 0, `save child failed: ${saveResult.stderr}`)
      } finally {
        rmSync(barrierDir, { recursive: true, force: true })
      }

      assert.ok(
        loadSelfCommentIds('7', 'owner/repo').includes(commentId),
        `trial ${trial}: recorded id ${commentId} was lost to a concurrent saveState write`
      )
      // The lock's correctness cuts both ways: asserting only the recordSelfComment side would
      // pass a lock that let recordSelfComment win every race and silently dropped saveState's
      // write — itself a lost update of the same class this test exists to catch.
      assert.equal(
        loadState('7', 'owner/repo')?.headSha,
        `sha-${trial}`,
        `trial ${trial}: saveState's headSha write was lost to a concurrent recordSelfComment write`
      )
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = originalSession
  }
})

test('store-race-child exits non-zero with a diagnostic when GO never arrives (FLOW-261 finding d9bc082eaab8)', async () => {
  const barrierDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-timeout-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-timeout-home-'))
  const readyPath = join(barrierDir, 'ready')
  const goPath = join(barrierDir, 'go') // deliberately never written
  const originalHome = process.env.HOME
  const originalSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    const { code, signal, stderr } = await runStoreRaceChild(
      ['record', '7', 'owner/repo', 'unused', readyPath, goPath],
      {
        ...process.env,
        HOME: homeDir,
        CLAUDE_CODE_SESSION_ID: 'flow-261-store-race-timeout',
        RACE_CHILD_GO_TIMEOUT_MS: '300',
      },
      SPAWN_TIMEOUT_BACKSTOP_MS
    )
    assert.ok(
      existsSync(readyPath),
      'precondition: the child reached READY before it started waiting'
    )
    assert.notEqual(signal, 'SIGTERM', 'the child must exit rather than stall, for any reason')
    assert.notEqual(code, 0, 'a child that never sees GO must exit non-zero, not hang or exit 0')
    assert.match(
      stderr,
      /store-race-child: timed out after 300ms waiting for GO at/,
      'the diagnostic must name the timeout'
    )
    assert.ok(
      stderr.includes(goPath),
      'the diagnostic must name the specific goPath that never appeared'
    )
    // store-race-child never writes stdout, so asserting it here would prove nothing; the store
    // file's absence is the real observable — it exists only once writeStore's atomicWrite has run,
    // so its absence proves recordSelfComment was never called, not just that the process exited.
    process.env.HOME = homeDir
    process.env.CLAUDE_CODE_SESSION_ID = 'flow-261-store-race-timeout'
    assert.ok(
      !existsSync(statePath()),
      'a child that never sees GO must never call recordSelfComment'
    )
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = originalSession
    rmSync(barrierDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('store-race-child exits non-zero with a diagnostic when RACE_CHILD_GO_TIMEOUT_MS is empty (FLOW-261 finding 2a448a7102e5)', async () => {
  const barrierDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-badtimeout-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-badtimeout-home-'))
  const readyPath = join(barrierDir, 'ready')
  const goPath = join(barrierDir, 'go')
  // Written before the child spawns: if a regression narrows or removes the guard, the child falls
  // straight through the barrier to a real recordSelfComment call — HOME below is isolated so that
  // fallthrough can never touch the operator's real store, and a broken guard is still caught by
  // the exit-code assertion below rather than only by the spawn timeout backstop.
  writeFileSync(goPath, '')
  try {
    const { code, signal, stderr } = await runStoreRaceChild(
      ['record', '7', 'owner/repo', 'unused', readyPath, goPath],
      {
        ...process.env,
        HOME: homeDir,
        CLAUDE_CODE_SESSION_ID: 'flow-261-store-race-badtimeout',
        RACE_CHILD_GO_TIMEOUT_MS: '',
      },
      SPAWN_TIMEOUT_BACKSTOP_MS
    )
    assert.notEqual(signal, 'SIGTERM', 'the child must exit rather than stall, for any reason')
    assert.notEqual(
      code,
      0,
      'an empty RACE_CHILD_GO_TIMEOUT_MS must exit non-zero, not silently default to an unbounded wait'
    )
    assert.match(
      stderr,
      /RACE_CHILD_GO_TIMEOUT_MS must be a positive integer string, got ""/,
      'the diagnostic must name the variable and the empty value received'
    )
    assert.ok(
      !existsSync(readyPath),
      'a malformed timeout must be rejected before the child ever signals READY'
    )
  } finally {
    rmSync(barrierDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  }
})

// --- Store lock shape validation (FLOW-226) ---
//
// Each case asserts the lock file is GONE, not that the write landed: acquireStoreLock degrades to
// an unlocked write rather than failing, so a lock wrongly read as live still produces a successful
// saveState either way. The file's fate is what discriminates. Reclaimed, it is stolen by rename,
// re-created naming this process, and removed by releaseStoreLock's ownership check on the way out.
// Wrongly read as live, it is never acquired, so that same ownership check does not match and the
// planted row is still there afterwards.
//
// Every fixture therefore plants a FOREIGN pid. A planted `process.pid` would satisfy the ownership
// check on the degrade path too, removing the file on both paths and making the assertion vacuous.
//
// The control for all three is the existing live-foreign-holder degrade case above, whose fixture
// is a valid pid with a valid ISO acquiredAt: it must keep its lock file. A validator that rejected
// everything would reclaim there too, and that test would fail.

test('a store lock naming pid 0 is reclaimed, not read as a live process group (FLOW-226)', () => {
  withIsolatedStore('flow-226-store-lock-pid-zero', () => {
    mkdirSync(storeDir(), { recursive: true })
    writeFileSync(storeLockPath(), JSON.stringify({ pid: 0, acquiredAt: new Date().toISOString() }))

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reclaimed-pid-zero' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reclaimed-pid-zero')
    const surviving = existsSync(storeLockPath()) ? readFileSync(storeLockPath(), 'utf8') : null
    assert.equal(
      surviving,
      null,
      `pid 0 must not read as a live holder; the lock file survived holding ${surviving}`
    )
  })
})

test('a store lock naming pid -1 is reclaimed, not read as every signalable process (FLOW-226)', () => {
  withIsolatedStore('flow-226-store-lock-pid-negative', () => {
    mkdirSync(storeDir(), { recursive: true })
    writeFileSync(
      storeLockPath(),
      JSON.stringify({ pid: -1, acquiredAt: new Date().toISOString() })
    )

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reclaimed-pid-negative' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reclaimed-pid-negative')
    const surviving = existsSync(storeLockPath()) ? readFileSync(storeLockPath(), 'utf8') : null
    assert.equal(
      surviving,
      null,
      `pid -1 must not read as a live holder; the lock file survived holding ${surviving}`
    )
  })
})

test('a store lock with a numeric acquiredAt is reclaimed, not read as freshly acquired (FLOW-226)', () => {
  withIsolatedStore('flow-226-store-lock-numeric-date', () => {
    mkdirSync(storeDir(), { recursive: true })
    // `Date.now()` written through instead of `.toISOString()`. Read as literal epoch-ms it looks
    // freshly acquired, and pid 1 is signalable by nobody here, so `process.kill(1, 0)` throws
    // EPERM and isStoreLockProcessAlive reads it as a live foreign holder — held forever, since
    // nothing else ever reclaims it.
    writeFileSync(storeLockPath(), JSON.stringify({ pid: 1, acquiredAt: Date.now() }))

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reclaimed-numeric-date' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reclaimed-numeric-date')
    const surviving = existsSync(storeLockPath()) ? readFileSync(storeLockPath(), 'utf8') : null
    assert.equal(
      surviving,
      null,
      `a numeric acquiredAt must not read as fresh; the lock file survived holding ${surviving}`
    )
  })
})

const withBotComment = (bodyHash: string | undefined): PrState =>
  mergeReadyExcept({
    botComments: [
      bodyHash === undefined
        ? { id: 'cr-summary', author: 'coderabbitai' }
        : { id: 'cr-summary', author: 'coderabbitai', bodyHash },
    ],
  })

test('an edited bot comment emits bot-comments-edited (FLOW-373)', () => {
  const changes = compareStates(withBotComment('before'), withBotComment('after'))
  assert.deepEqual(
    changes.filter((c) => c.type === 'bot-comments-edited' || c.type === 'NEW_BOT_COMMENTS'),
    [{ type: 'bot-comments-edited', detail: '1 edited top-level bot comment from: coderabbitai' }]
  )
})

test('an unchanged bot comment emits nothing (FLOW-373)', () => {
  const changes = compareStates(withBotComment('same'), withBotComment('same'))
  assert.equal(
    changes.some((c) => c.type === 'bot-comments-edited'),
    false
  )
})

test('a bot comment saved before bodyHash existed is not read as edited (FLOW-373)', () => {
  const changes = compareStates(withBotComment(undefined), withBotComment('after'))
  assert.equal(
    changes.some((c) => c.type === 'bot-comments-edited'),
    false
  )
})

// --- FLOW-402: the watched-PR registry ---

test('watchPr registers a PR once and keeps its original registeredAt', () => {
  withIsolatedStore('flow-402-watch', () => {
    watchPr('7', 'a/b')
    const first = loadWatched()
    assert.equal(first.length, 1)
    assert.equal(first[0]?.prNumber, '7')
    assert.equal(first[0]?.repo, 'a/b')
    assert.equal(first[0]?.consecutiveUnknown, 0)
    watchPr('7', 'a/b')
    assert.deepEqual(loadWatched(), first)
  })
})

test('saveState keeps the watched registry through its whole-store rewrite', () => {
  withIsolatedStore('flow-402-save-keeps-watched', () => {
    watchPr('7', 'a/b')
    saveState('7', 'a/b', cleanBaseline())
    assert.deepEqual(
      loadWatched().map((w) => w.prNumber),
      ['7']
    )
  })
})

test('recordUnknownPoll on an unwatched PR returns null and creates nothing', () => {
  withIsolatedStore('flow-402-unknown-unwatched', () => {
    assert.equal(recordUnknownPoll('7', 'a/b', 'x'), null)
    assert.deepEqual(loadWatched(), [])
    watchPr('7', 'a/b')
    assert.deepEqual(recordUnknownPoll('7', 'a/b', 'first'), { count: 1, failure: 'first' })
    assert.deepEqual(recordUnknownPoll('7', 'a/b', 'second'), { count: 2, failure: 'second' })
    assert.equal(loadWatched()[0]?.lastFailure, 'second')
  })
})

test('markPolled stamps a watched PR and creates nothing for an unwatched one', () => {
  withIsolatedStore('flow-402-mark-polled', () => {
    watchPr('9', 'acme/widget')

    markPolled('9', 'acme/widget', '2026-01-02T03:04:05.000Z')
    markPolled('10', 'acme/widget', '2026-01-02T03:04:05.000Z')

    assert.deepEqual(
      loadWatched().map((w) => [w.prNumber, w.lastPolledAt]),
      [['9', '2026-01-02T03:04:05.000Z']]
    )
  })
})

test('unwatchPr reports whether the PR was watched', () => {
  withIsolatedStore('flow-402-unwatch', () => {
    assert.equal(unwatchPr('7', 'a/b'), false)
    watchPr('7', 'a/b')
    assert.equal(unwatchPr('7', 'a/b'), true)
    assert.deepEqual(loadWatched(), [])
  })
})

test('a malformed watched entry is dropped and a bad counter reads as 0', () => {
  withIsolatedStore('flow-402-malformed-watched', () => {
    const at = new Date().toISOString()
    atomicWrite(
      statePath(),
      JSON.stringify({
        prs: {},
        watched: {
          'a/b#1': { prNumber: '1', registeredAt: at, consecutiveUnknown: 1 },
          'a/b#2': { prNumber: '2', repo: 'a/b', registeredAt: at, consecutiveUnknown: -3 },
        },
      })
    )
    const watched = loadWatched()
    assert.deepEqual(
      watched.map((w) => [w.prNumber, w.consecutiveUnknown]),
      [['2', 0]]
    )
  })
})

test('loadWatchedFor reads another session’s watched list', () => {
  withIsolatedStore('flow-476-other-session', () => {
    watchPr('7', 'a/b')
    watchPr('3', 'a/b')
    const ownId = process.env.CLAUDE_CODE_SESSION_ID as string

    process.env.CLAUDE_CODE_SESSION_ID = 'flow-476-reader'

    assert.deepEqual(
      loadWatchedFor(ownId).map((w) => `${w.repo}#${w.prNumber}`),
      ['a/b#3', 'a/b#7']
    )
    assert.deepEqual(loadWatchedFor('flow-476-never-watched'), [])
  })
})

test('loadWatchedFor returns [] for an unparseable store', () => {
  withIsolatedStore('flow-476-unparseable', () => {
    mkdirSync(storeDir(), { recursive: true })
    writeFileSync(statePath(), '{')

    assert.deepEqual(loadWatchedFor('flow-476-unparseable'), [])
  })
})

test('loadWatchedFor skips an entry the poller skips', () => {
  withIsolatedStore('flow-476-invalid-entry', () => {
    const at = new Date().toISOString()
    atomicWrite(
      statePath(),
      JSON.stringify({
        prs: {},
        watched: {
          'a/b#1': { prNumber: '1', repo: '', registeredAt: at },
          'a/b#2': { prNumber: '2', repo: 'a/b' },
          'a/b#3': { prNumber: '3', repo: 'a/b', registeredAt: at },
        },
      })
    )

    assert.deepEqual(
      loadWatchedFor('flow-476-invalid-entry').map((w) => w.prNumber),
      ['3']
    )
  })
})
