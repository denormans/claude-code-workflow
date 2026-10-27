// The closed list of moments a hook can attach to. A hooks file naming anything else is a config
// error, which is what catches a typo — an open list would accept it and never fire.
export const MOMENT_IDS = [
  'prd.before',
  'prd.after',
  'architecture.before',
  'architecture.after',
  'change-summary.before',
  'change-summary.after',
  'bug-summary.before',
  'bug-summary.after',
  'work-start.after',
  'team-start.before',
  'team-start.after',
  'tests.before',
  'tests.after',
  'pr-opened.after',
  'pr-ready.before',
  'pr-ready.after',
  'pr-human-review.after',
  'pr-merged.after',
  'cleanup.before',
  'cleanup.after',
] as const

export type MomentId = (typeof MOMENT_IDS)[number]

// The files whose prose runs each moment. A moment fires only where a skill runs it, so check-refs
// reads this to flag a call site that was edited away. Typed by MomentId: a moment added above with
// no entry here fails to compile.
export const MOMENT_CALL_SITES: Record<MomentId, readonly string[]> = {
  'prd.before': ['skills/jtbd/SKILL.md'],
  'prd.after': ['skills/jtbd/SKILL.md'],
  'architecture.before': ['skills/architecture/SKILL.md'],
  'architecture.after': ['skills/architecture/SKILL.md'],
  'change-summary.before': ['skills/quick-change/SKILL.md'],
  'change-summary.after': ['skills/quick-change/SKILL.md'],
  'bug-summary.before': ['skills/systematic-debugging/SKILL.md'],
  'bug-summary.after': ['skills/systematic-debugging/SKILL.md'],
  'work-start.after': ['skills/git-worktrees/SKILL.md'],
  'team-start.before': ['skills/team-dispatch/SKILL.md'],
  'team-start.after': ['skills/team-dispatch/SKILL.md'],
  'tests.before': [
    'agents/implementer.md',
    'agents/senior-engineer.md',
    'skills/pr-lifecycle/SKILL.md',
  ],
  'tests.after': [
    'agents/implementer.md',
    'agents/senior-engineer.md',
    'skills/pr-lifecycle/SKILL.md',
  ],
  'pr-opened.after': ['skills/pr-lifecycle/SKILL.md'],
  'pr-ready.before': ['skills/pr-lifecycle/SKILL.md'],
  'pr-ready.after': ['skills/pr-lifecycle/SKILL.md'],
  'pr-human-review.after': ['skills/pr-lifecycle/SKILL.md'],
  'pr-merged.after': ['skills/pr-lifecycle/SKILL.md'],
  'cleanup.before': ['skills/team-cleanup/SKILL.md'],
  'cleanup.after': ['skills/team-cleanup/SKILL.md'],
}

export const isMomentId = (value: string): value is MomentId =>
  MOMENT_IDS.some((id) => id === value)
