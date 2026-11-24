import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  atomicWrite,
  readClassified,
  sessionGlobalScope,
  storePath,
} from '../workflow-store/store.ts'
import { dashboardAvailable, flagValueArgs } from '../dashboard/invoke.ts'
import {
  loadRegistry,
  registryLeaves,
  registryRoot,
  type RegistryNode,
} from '../dashboard/registry.ts'
import { withRecordLock } from './record-lock.ts'
import {
  isOlder,
  loadTurnMarks,
  updateTurnMarks,
  failureOrder,
  succeededAfterFailure,
  withStarted,
  withSucceeded,
} from './turn-marks.ts'

// A turn killed by an API, network or sleep error ends in StopFailure, which cannot retry. This
// file records the failure so the idle `mailbox check` can resume the session once, and puts what
// a resume cannot fix on the board. Four processes write the record (turn-failed, turn-started,
// turn-succeeded and check), so each read-modify-write runs under the record's lock; a board call
// never does, and its result is applied only to the failure that started it.

const DASHBOARD_BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'bin',
  'dashboard'
)
const DASHBOARD_TIMEOUT_MS = 30_000
// A post claim outlives the dashboard call it guards, so a claim held by a live post is not taken
// over; one left by a killed process, or by a post suspended past this window, is, and the late
// post's item goes to the withdraw list when it lands.
const POST_CLAIM_MS = 2 * DASHBOARD_TIMEOUT_MS
const MAX_WITHDRAW_ATTEMPTS = 5
// The board's own refusals to withdraw: an item in a state other than open, draft or ready
// (released, consumed, ...), one that does not exist, and one whose session is missing, deleted,
// ended or closed. Each is final, so the withdraw is finished; any other failure never reached the
// board.
const PERMANENT_REFUSAL =
  /only open, draft or ready items can be withdrawn|Item not found|Session not found|Session is (deleted|ended|closed)/
const RECORD_FILENAME = 'failed-turn.json'
const LAST_MESSAGE_MAX_CHARS = 500
const MAX_RESUMES_PER_STREAK = 1
const NO_PROMPT_ID_PREFIX = 'no-prompt-id:'

const CREDENTIAL_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
])

export type BoardKind = 'credential' | 'checkpoint'

// What the user must do about the streak, which is what an item tells them. Two causes with the
// same remedy are the same item: a credential error names the account to fix whichever one it is.
export type Remedy = 'credential' | 'rate-limit' | 'repeat' | 'unproven'

const REMEDY_RANK: Record<Remedy, number> = {
  unproven: 0,
  repeat: 1,
  'rate-limit': 2,
  credential: 3,
}

export interface FailedTurn {
  sessionId: string
  // The strongest cause the streak has seen since a turn last succeeded, or since the item that
  // carried it was answered and the next item posted; it decides whether an open item is replaced.
  error: string
  at: string
  // The prompt whose turn failed; null when the hook payload carried none.
  promptId: string | null
  consecutive: number
  lastMessage: string | null
  turnStartedSince: boolean
  boardItemId: string | null
  // The item an earlier failure of this streak posted. A new failure keeps it only while the board
  // still shows it open; one the user answered or consumed no longer holds the streak.
  priorBoardItemId: string | null
  // The remedy the held item (`boardItemId`, else `priorBoardItemId`) tells the user; null when none
  // is held or the record predates the field.
  boardRemedy: Remedy | null
  // The strongest cause among the failures that arrived since the held item was posted; null until
  // one does. An item the user has answered no longer stands for the causes it carried, so the next
  // item stands on this.
  causeSincePost: string | null
  // Items to withdraw that no longer stand for the record: those a successful turn, or a post that
  // landed after it, could not leave on the board, an item a stronger remedy replaced, and an
  // unproven checkpoint whose order has since resolved. The next board-session check withdraws them.
  staleBoardItemIds: string[]
  // Failed withdraw attempts per stale id; an id that keeps failing is given up on.
  withdrawAttempts: Record<string, number>
  // The node each posted item was added on, which is the node whose ledger holds the id.
  itemNodes: Record<string, string>
  // When a check claimed the right to post this failure's item.
  postingSince: string | null
}

type StoredFailedTurn = Omit<
  FailedTurn,
  | 'promptId'
  | 'boardItemId'
  | 'priorBoardItemId'
  | 'boardRemedy'
  | 'causeSincePost'
  | 'staleBoardItemIds'
  | 'withdrawAttempts'
  | 'itemNodes'
  | 'postingSince'
> & {
  promptId?: string | null
  boardItemId?: string | null
  priorBoardItemId?: string | null
  boardRemedy?: Remedy | null
  causeSincePost?: string | null
  staleBoardItemIds?: string[]
  withdrawAttempts?: Record<string, number>
  itemNodes?: Record<string, string>
  postingSince?: string | null
}

// open: the board still holds the item unanswered (open, draft or ready). closed: any other state,
// or no such item. unknown: the board could not be read.
export type ItemState = 'open' | 'closed' | 'unknown'

export type ItemStateReader = (itemId: string) => ItemState

// unavailable: the board binary is not there, so nothing was asked and nothing is counted.
export type WithdrawResult = 'done' | 'failed' | 'unavailable'

// `node` is the node the item was posted on, or null when the record does not say.
export type Withdraw = (itemId: string, node: string | null) => WithdrawResult

// The node a new item is added on, chosen once per post so the record can keep it.
export type NodeResolver = () => string | null

export interface StopFailureInput {
  session_id?: string
  error?: string
  error_details?: string
  prompt_id?: string
  last_assistant_message?: string
}

export type PostItem = (kind: BoardKind, prompt: string, node: string | null) => string | null

interface Transaction<T> {
  // Absent leaves the record as it is; null clears it.
  write?: FailedTurn | null
  value: T
}

// The one reading of where a streak stands: the remedy it asks of the user, or null when a resume
// is the answer or a later turn already makes the failure moot. `pendingResume`, `postIfNeeded` and
// `releaseResolvedCheckpoint` all read it, so they cannot disagree about a record.
export const remedyOf = (rawSessionId: string, record: FailedTurn): Remedy | null => {
  if (CREDENTIAL_ERRORS.has(record.error)) {
    return 'credential'
  }

  if (record.error === 'rate_limit') {
    return 'rate-limit'
  }

  if (record.consecutive > MAX_RESUMES_PER_STREAK) {
    return 'repeat'
  }

  return isOrderUnproven(rawSessionId, record) ? 'unproven' : null
}

const isOrderUnproven = (rawSessionId: string, record: FailedTurn): boolean => {
  if (record.turnStartedSince) {
    return false
  }

  const marks = loadTurnMarks(rawSessionId)

  return (
    marks.damage !== undefined ||
    (record.promptId !== null && failureOrder(marks, record.promptId, record.at) === 'unproven')
  )
}

const kindOf = (remedy: Remedy): BoardKind =>
  remedy === 'credential' ? 'credential' : 'checkpoint'

export const recordFailedTurn = (
  input: StopFailureInput,
  rawSessionId: string,
  canPost: boolean,
  post: PostItem,
  now: Date = new Date(),
  itemState: ItemStateReader = () => 'open',
  nodeOf: NodeResolver = () => null
): FailedTurn => {
  const outcome = transact<{ record: FailedTurn; superseded: boolean }>(
    rawSessionId,
    (previous) => {
      const marks = loadTurnMarks(rawSessionId)
      const promptId = input.prompt_id ?? null
      const arrivedLate =
        promptId !== null &&
        previous?.promptId != null &&
        isOlder(marks, promptId, previous.promptId)
      const incoming = {
        error: input.error ?? 'unknown',
        at: now.toISOString(),
        promptId,
        lastMessage: input.last_assistant_message?.slice(0, LAST_MESSAGE_MAX_CHARS) ?? null,
      }
      const newest = arrivedLate && previous !== null ? previous : incoming
      const next: FailedTurn = {
        sessionId: rawSessionId,
        error: streakError(previous, incoming.error, newest.error),
        at: newest.at,
        promptId: newest.promptId,
        consecutive: (previous?.consecutive ?? 0) + 1,
        lastMessage: newest.lastMessage,
        turnStartedSince:
          newest.promptId === null &&
          marks.started.some((mark) => Date.parse(mark.at) >= Date.parse(newest.at)),
        boardItemId: null,
        priorBoardItemId: previous?.boardItemId ?? previous?.priorBoardItemId ?? null,
        boardRemedy: previous?.boardRemedy ?? null,
        causeSincePost: causeSincePost(previous, incoming.error, arrivedLate),
        staleBoardItemIds: previous?.staleBoardItemIds ?? [],
        withdrawAttempts: previous?.withdrawAttempts ?? {},
        itemNodes: previous?.itemNodes ?? {},
        postingSince: previous?.consecutive ? previous.postingSince : null,
      }
      if (promptId !== null && succeededAfterFailure(marks, promptId, incoming.at)) {
        return {
          value: {
            record: previous ?? { ...next, consecutive: 0, turnStartedSince: true },
            superseded: true,
          },
        }
      }

      return { write: next, value: { record: next, superseded: false } }
    }
  )

  return canPost && !outcome.superseded
    ? postIfNeeded(outcome.record, post, itemState, nodeOf)
    : outcome.record
}

// A credential error outranks a rate limit, which outranks the rest; among equals the newest
// failure's error stands.
const strongestCause = (errors: string[], newestError: string): string =>
  errors.find((error) => CREDENTIAL_ERRORS.has(error)) ??
  errors.find((error) => error === 'rate_limit') ??
  newestError

// The streak keeps the strongest cause it has seen until a turn succeeds; when the item that
// carried it was answered, the next item posts on `causeSincePost` and `error` takes that value.
const streakError = (
  previous: FailedTurn | null,
  incomingError: string,
  newestError: string
): string =>
  previous === null || previous.consecutive < 1
    ? incomingError
    : strongestCause([previous.error, incomingError], newestError)

// The strongest cause among the failures since the held item was posted, which a failure that
// arrived late still counts toward.
const causeSincePost = (
  previous: FailedTurn | null,
  incomingError: string,
  arrivedLate: boolean
): string => {
  const held = previous === null || previous.consecutive < 1 ? null : previous.causeSincePost
  if (held === null) {
    return incomingError
  }

  return strongestCause([held, incomingError], arrivedLate ? held : incomingError)
}

export const postIfNeeded = (
  record: FailedTurn,
  post: PostItem,
  itemState: ItemStateReader = () => 'open',
  nodeOf: NodeResolver = () => null,
  includeUnproven = false,
  deadlineAt: number = Infinity
): FailedTurn => {
  if (Date.now() >= deadlineAt) {
    return loadFailedTurn(record.sessionId) ?? record
  }

  const claim = transact(record.sessionId, (current) => {
    if (current === null || current.at !== record.at || current.consecutive < 1) {
      return { value: null }
    }

    const remedy = remedyOf(record.sessionId, current)
    if (
      remedy === null ||
      (remedy === 'unproven' && !includeUnproven) ||
      current.boardItemId !== null ||
      isClaimLive(current.postingSince)
    ) {
      return { value: null }
    }

    const claimed = { ...current, postingSince: new Date().toISOString() }

    return { write: claimed, value: { remedy, claimed } }
  })
  if (claim === null) {
    return loadFailedTurn(record.sessionId) ?? record
  }

  const { claimed } = claim
  const prior = claimed.priorBoardItemId
  const priorState =
    prior === null ? 'closed' : Date.now() >= deadlineAt ? 'unread' : itemState(prior)
  if (priorState === 'unread') {
    return transact<FailedTurn>(record.sessionId, (current) =>
      landPost(current, claimed, {
        boardItemId: null,
        posted: false,
        remedy: claim.remedy,
        error: claimed.error,
        displaced: null,
        node: null,
      })
    )
  }

  const answeredError = prior !== null && priorState === 'closed' ? claimed.causeSincePost : null
  const standing = answeredError === null ? claimed : { ...claimed, error: answeredError }
  const remedy =
    answeredError === null ? claim.remedy : (remedyOf(record.sessionId, standing) ?? claim.remedy)
  const carried = priorState === 'open' && !outranks(remedy, claimed.boardRemedy)
  const node = carried ? null : nodeOf()
  const isPastDeadline = Date.now() >= deadlineAt
  const boardItemId = carried
    ? prior
    : isPastDeadline
      ? null
      : post(kindOf(remedy), boardPrompt(standing, remedy), node)
  const displaced = priorState === 'unknown' || (priorState === 'open' && !carried) ? prior : null

  const landed = transact<FailedTurn>(record.sessionId, (current) =>
    landPost(current, claimed, {
      boardItemId,
      posted: !carried,
      remedy,
      error: standing.error,
      displaced,
      node,
    })
  )

  return landed.boardItemId === null &&
    landed.priorBoardItemId !== null &&
    landed.consecutive !== claimed.consecutive
    ? postIfNeeded(landed, post, itemState, nodeOf, includeUnproven, deadlineAt)
    : landed
}

const outranks = (remedy: Remedy, held: Remedy | null): boolean =>
  held !== null && REMEDY_RANK[remedy] > REMEDY_RANK[held]

// A marks write that fails must not stop the record from being cleared, or a start from being
// handled. A failed write leaves the marks as they were: a damaged file stays damaged and reads as
// unproven, and a healthy one is simply missing this turn, so a failure hook delayed past a start
// whose write failed can still resume over that turn.
const tryUpdateTurnMarks = (
  rawSessionId: string,
  lockHeld: boolean,
  change: (marks: ReturnType<typeof loadTurnMarks>) => ReturnType<typeof loadTurnMarks>
): void => {
  try {
    updateTurnMarks(rawSessionId, lockHeld, change)
  } catch {
    return
  }
}

// `startedAt` is the instant the turn began. Every start is a mark, and a start without a prompt id
// is marked under an id of its own that no prompt id can equal; `remedyOf` orders a failure that has
// a prompt id against the marks. A failure the hook wrote without a prompt id is ordered by the
// clock here instead.
export const markTurnStarted = (
  rawSessionId: string,
  startedAt: string,
  promptId?: string
): void => {
  transact(rawSessionId, (record, lockHeld) => {
    const markId = promptId ?? `${NO_PROMPT_ID_PREFIX}${randomUUID()}`
    tryUpdateTurnMarks(rawSessionId, lockHeld, (marks) => withStarted(marks, markId, startedAt))

    if (record === null || record.promptId !== null) {
      return { value: null }
    }

    return Date.parse(startedAt) >= Date.parse(record.at)
      ? { write: { ...record, turnStartedSince: true }, value: null }
      : { value: null }
  })
}

// A successful turn ends the failure streak whatever the withdraws do, unless its prompt is
// positioned before the failed one in the marks. A success whose prompt has no start mark clears
// the streak too; the marks keep it as unplaced. An item that could not be withdrawn stays in
// `staleBoardItemIds` for `retryStaleWithdraw`.
export const clearFailedTurn = (
  rawSessionId: string,
  withdraw: Withdraw,
  promptId?: string,
  now: Date = new Date()
): void => {
  const owed = transact<[string, string | null][]>(rawSessionId, (record, lockHeld) => {
    const before = loadTurnMarks(rawSessionId)
    if (promptId !== undefined) {
      tryUpdateTurnMarks(rawSessionId, lockHeld, (marks) =>
        withSucceeded(marks, promptId, now.toISOString())
      )
    }

    if (record === null) {
      return { value: [] }
    }

    if (
      promptId !== undefined &&
      record.promptId !== null &&
      isOlder(before, promptId, record.promptId)
    ) {
      return { value: [] }
    }

    const ids = withIds(record.staleBoardItemIds, [record.boardItemId, record.priorBoardItemId])
    if (ids.length === 0) {
      return { write: null, value: [] }
    }

    return {
      write: {
        ...record,
        consecutive: 0,
        turnStartedSince: true,
        boardItemId: null,
        priorBoardItemId: null,
        boardRemedy: null,
        staleBoardItemIds: ids,
        postingSince: null,
      },
      value: ids.map((id) => [id, record.itemNodes[id] ?? null]),
    }
  })

  settleWithdrawals(
    rawSessionId,
    owed.map(([id, node]) => [id, withdraw(id, node)])
  )
}

// Starts no withdrawal at or after `deadlineAt` (epoch ms); an id not attempted stays in the record.
export const retryStaleWithdraw = (
  rawSessionId: string,
  withdraw: Withdraw,
  deadlineAt: number = Infinity
): void => {
  const record = loadFailedTurn(rawSessionId)
  const owed = record === null ? [] : withoutHeld(record, record.staleBoardItemIds)
  const outcomes: [string, WithdrawResult][] = []
  for (const id of owed) {
    if (Date.now() >= deadlineAt) {
      break
    }

    outcomes.push([id, withdraw(id, record?.itemNodes[id] ?? null)])
  }

  settleWithdrawals(rawSessionId, outcomes)
}

// A checkpoint posted because the order could not be proven is withdrawn once the order is known:
// the failed prompt's own mark makes it an ordinary resume, and a proven later turn makes it moot.
export const releaseResolvedCheckpoint = (rawSessionId: string): void => {
  transact(rawSessionId, (record) => {
    if (
      record === null ||
      record.boardItemId === null ||
      record.boardRemedy !== 'unproven' ||
      remedyOf(rawSessionId, record) === 'unproven'
    ) {
      return { value: null }
    }

    return {
      write: {
        ...record,
        boardItemId: null,
        boardRemedy: null,
        staleBoardItemIds: withIds(record.staleBoardItemIds, [record.boardItemId]),
      },
      value: null,
    }
  })
}

export const pendingResume = (rawSessionId: string): FailedTurn | null => {
  const record = loadFailedTurn(rawSessionId)
  if (record === null || record.turnStartedSince || remedyOf(rawSessionId, record) !== null) {
    return null
  }

  const proven =
    record.promptId === null ||
    failureOrder(loadTurnMarks(rawSessionId), record.promptId, record.at) === 'resumable'

  return proven ? record : null
}

export const formatFailedTurn = (record: FailedTurn): string => {
  const lost =
    record.lastMessage === null ? '' : ` The error detail was: ${oneLine(record.lastMessage)}`

  return (
    `[turn] failed-turn ${record.error} at ${record.at}: your last turn was cut off.${lost} ` +
    `Re-read the transcript and the state of your work, because a tool call may have run with its ` +
    `result lost, then continue from where it stopped. If this turn fails too, the failure goes to ` +
    `the board.`
  )
}

export const loadFailedTurn = (rawSessionId: string): FailedTurn | null => {
  const read = readClassified(recordPath(rawSessionId))
  if (read.kind !== 'content') {
    return null
  }

  try {
    const parsed = JSON.parse(read.content) as unknown
    if (!isStoredFailedTurn(parsed)) {
      return null
    }

    return {
      ...parsed,
      lastMessage: stringOrNull(parsed.lastMessage),
      promptId: stringOrNull(parsed.promptId),
      boardItemId: stringOrNull(parsed.boardItemId),
      priorBoardItemId: stringOrNull(parsed.priorBoardItemId),
      boardRemedy: isRemedy(parsed.boardRemedy) ? parsed.boardRemedy : null,
      causeSincePost: stringOrNull(parsed.causeSincePost),
      staleBoardItemIds: isStringList(parsed.staleBoardItemIds) ? parsed.staleBoardItemIds : [],
      withdrawAttempts: isRecordOf(parsed.withdrawAttempts, 'number')
        ? parsed.withdrawAttempts
        : {},
      itemNodes: isRecordOf(parsed.itemNodes, 'string') ? parsed.itemNodes : {},
      postingSince: stringOrNull(parsed.postingSince),
    }
  } catch {
    return null
  }
}

export const postBoardItem =
  (rawSessionId: string): PostItem =>
  (kind, prompt, node) => {
    const result = runDashboard(rawSessionId, [
      'item',
      'add',
      '--type',
      'approval',
      '--approval-kind',
      kind,
      ...flagValueArgs('--prompt', prompt),
      ...nodeArgs(node),
    ])
    if (!result.ok) {
      return null
    }

    try {
      const parsed = JSON.parse(result.stdout) as { itemId?: unknown }

      return typeof parsed.itemId === 'string' ? parsed.itemId : null
    } catch {
      return null
    }
  }

// The dashboard refuses a keyless item call from a session with several live leaves, so the node is
// named: the only leaf, else the root.
export const boardNodeOf =
  (rawSessionId: string): NodeResolver =>
  () => {
    const nodes = readRegistry(rawSessionId)
    const leaves = registryLeaves(nodes ?? [])
    const target = leaves.length === 1 ? leaves[0] : ((nodes && registryRoot(nodes)) ?? leaves[0])

    return target?.internalId ?? null
  }

// The node holding an item's id is the one it was added on, while that node still exists; a node
// that has since been left falls back to the node chosen now.
const withdrawNode = (rawSessionId: string, saved: string | null): string | null => {
  const nodes = readRegistry(rawSessionId)
  if (saved !== null && (nodes === null || nodes.some((node) => node.internalId === saved))) {
    return saved
  }

  return boardNodeOf(rawSessionId)()
}

const readRegistry = (rawSessionId: string): RegistryNode[] | null => {
  try {
    return loadRegistry(rawSessionId)
  } catch {
    return null
  }
}

const nodeArgs = (node: string | null): string[] =>
  node === null ? [] : flagValueArgs('--session', node)

const OPEN_ITEM_STATES = new Set(['open', 'draft', 'ready'])

export const boardItemState =
  (rawSessionId: string): ItemStateReader =>
  (itemId) => {
    const result = runDashboard(rawSessionId, ['item', 'show', ...flagValueArgs('--item', itemId)])
    const shown = /^\[dashboard\] item \S+ \S+\/(\S+)/m.exec(result.stdout)
    if (shown !== null) {
      return OPEN_ITEM_STATES.has(shown[1]) ? 'open' : 'closed'
    }

    return !result.ok && /not found/i.test(result.stderr) ? 'closed' : 'unknown'
  }

// An item the user already answered is released or consumed, so the board refuses to withdraw it;
// the answer reaches the session through the answer path, so that refusal finishes the withdraw.
export const withdrawBoardItem =
  (rawSessionId: string): Withdraw =>
  (itemId, node) => {
    const result = runDashboard(rawSessionId, [
      'item',
      'withdraw',
      ...flagValueArgs('--item', itemId),
      ...nodeArgs(withdrawNode(rawSessionId, node)),
    ])

    if (result.unavailable) {
      return 'unavailable'
    }

    return result.ok || PERMANENT_REFUSAL.test(result.stderr) ? 'done' : 'failed'
  }

// The board answered after the lock was released. The claim, not the failure it started from, owns
// the item: a failure that arrived meanwhile finds the item as the streak's prior one, to be kept
// while its remedy stands and replaced by a stronger one. When the streak has been cleared or the
// claim taken over, the item is stale and goes to the withdraw list rather than back onto a record
// that no longer describes it.
const landPost = (
  current: FailedTurn | null,
  claimed: FailedTurn,
  landing: {
    boardItemId: string | null
    posted: boolean
    remedy: Remedy
    error: string
    displaced: string | null
    node: string | null
  }
): Transaction<FailedTurn> => {
  const { boardItemId, posted: newlyPosted, remedy, error, displaced, node } = landing
  const ownsClaim =
    current !== null && current.consecutive > 0 && current.postingSince === claimed.postingSince
  const isOvertaken = ownsClaim && current.consecutive !== claimed.consecutive

  if (boardItemId === null) {
    if (ownsClaim) {
      const released = { ...current, postingSince: null }

      return { write: released, value: released }
    }

    return { value: current ?? claimed }
  }

  if (ownsClaim) {
    const posted = {
      ...current,
      error: newlyPosted && !isOvertaken ? error : current.error,
      boardItemId: isOvertaken ? null : boardItemId,
      priorBoardItemId: isOvertaken ? boardItemId : null,
      boardRemedy: newlyPosted ? remedy : current.boardRemedy,
      causeSincePost: newlyPosted && !isOvertaken ? null : current.causeSincePost,
      postingSince: null,
      staleBoardItemIds: withIds(current.staleBoardItemIds, [displaced]),
      itemNodes: withNode(current.itemNodes, newlyPosted ? boardItemId : null, node),
    }

    return { write: posted, value: posted }
  }

  const base: FailedTurn = current ?? {
    ...claimed,
    consecutive: 0,
    turnStartedSince: true,
    boardItemId: null,
    priorBoardItemId: null,
    boardRemedy: null,
    postingSince: null,
    staleBoardItemIds: [],
    withdrawAttempts: {},
    itemNodes: {},
  }
  const stale = {
    ...base,
    staleBoardItemIds: withIds(
      base.staleBoardItemIds,
      withoutHeld(base, [newlyPosted ? boardItemId : null, displaced])
    ),
    itemNodes: withNode(base.itemNodes, newlyPosted ? boardItemId : null, node),
  }

  return { write: stale, value: stale }
}

const withNode = (
  nodes: Record<string, string>,
  itemId: string | null,
  node: string | null
): Record<string, string> =>
  itemId === null || node === null ? nodes : { ...nodes, [itemId]: node }

const withIds = (ids: string[], more: (string | null)[]): string[] => [
  ...new Set([...ids, ...more.filter((id) => id !== null)]),
]

// The items the current failure still stands on; withdrawing one leaves a streak with nothing open.
const withoutHeld = <T extends string | null>(record: FailedTurn, ids: T[]): T[] =>
  ids.filter((id) => id !== record.boardItemId && id !== record.priorBoardItemId)

const settleWithdrawals = (rawSessionId: string, outcomes: [string, WithdrawResult][]): void => {
  if (outcomes.length === 0) {
    return
  }

  transact(rawSessionId, (record) => {
    if (record === null) {
      return { value: null }
    }

    const attempts = { ...record.withdrawAttempts }
    const itemNodes = { ...record.itemNodes }
    const finished: string[] = []
    for (const [id, result] of outcomes) {
      if (result === 'failed') {
        attempts[id] = (attempts[id] ?? 0) + 1
      }
      if (result === 'done' || (attempts[id] ?? 0) >= MAX_WITHDRAW_ATTEMPTS) {
        finished.push(id)
        delete attempts[id]
        delete itemNodes[id]
      }
    }

    const remaining = withoutHeld(record, record.staleBoardItemIds).filter(
      (id) => !finished.includes(id)
    )
    if (
      remaining.length === 0 &&
      record.consecutive === 0 &&
      record.boardItemId === null &&
      record.postingSince === null
    ) {
      return { write: null, value: null }
    }

    return {
      write: { ...record, staleBoardItemIds: remaining, withdrawAttempts: attempts, itemNodes },
      value: null,
    }
  })
}

const isClaimLive = (postingSince: string | null): boolean =>
  postingSince !== null && Date.now() - Date.parse(postingSince) < POST_CLAIM_MS

const transact = <T>(
  rawSessionId: string,
  change: (current: FailedTurn | null, lockHeld: boolean) => Transaction<T>
): T =>
  withRecordLock(recordPath(rawSessionId), (lockHeld) => {
    const outcome = change(loadFailedTurn(rawSessionId), lockHeld)
    if (outcome.write !== undefined) {
      atomicWrite(
        recordPath(rawSessionId),
        outcome.write === null ? 'null' : JSON.stringify(outcome.write, null, 2)
      )
    }

    return outcome.value
  })

const boardPrompt = (record: FailedTurn, remedy: Remedy): string => {
  const lost = record.lastMessage === null ? '' : `\n\nError detail: ${oneLine(record.lastMessage)}`
  if (remedy === 'unproven') {
    return `**This session's turn failed (\`${record.error}\`) and was not resumed.** It could not be told whether a later turn was yours, and resuming over one would interrupt it. Approve this item to resume it.${lost}`
  }

  if (remedy === 'credential') {
    return `**This session stopped on \`${record.error}\`.** Fix the account or sign-in, then approve this item to resume it.${lost}`
  }

  if (remedy === 'rate-limit') {
    return `**This session stopped at a usage limit.** Approve this item once the limit resets to resume it.${lost}`
  }

  return `**This session's turn failed ${record.consecutive} times in a row (\`${record.error}\`).** Approve this item to resume it.${lost}`
}

const runDashboard = (
  rawSessionId: string,
  args: string[]
): { ok: boolean; unavailable: boolean; stdout: string; stderr: string } => {
  if (!dashboardAvailable()) {
    return { ok: false, unavailable: true, stdout: '', stderr: '' }
  }

  const run = spawnSync(DASHBOARD_BIN, args, {
    encoding: 'utf8',
    timeout: DASHBOARD_TIMEOUT_MS,
    cwd: homedir(),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: rawSessionId },
  })

  return {
    ok: run.status === 0,
    unavailable: false,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
  }
}

const recordPath = (rawSessionId: string): string =>
  storePath(sessionGlobalScope(rawSessionId), RECORD_FILENAME)

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const isRemedy = (value: unknown): value is Remedy =>
  typeof value === 'string' && Object.hasOwn(REMEDY_RANK, value)

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const isRecordOf = <T extends 'string' | 'number'>(
  value: unknown,
  type: T
): value is Record<string, T extends 'string' ? string : number> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === type)

const isStoredFailedTurn = (value: unknown): value is StoredFailedTurn =>
  typeof value === 'object' &&
  value !== null &&
  'sessionId' in value &&
  typeof value.sessionId === 'string' &&
  'error' in value &&
  typeof value.error === 'string' &&
  'at' in value &&
  typeof value.at === 'string' &&
  'consecutive' in value &&
  typeof value.consecutive === 'number' &&
  'turnStartedSince' in value &&
  typeof value.turnStartedSince === 'boolean'
