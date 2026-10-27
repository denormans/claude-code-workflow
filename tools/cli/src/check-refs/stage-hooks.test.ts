import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findStageHookFindings } from './stage-hooks.ts'

test('findStageHookFindings: an unknown moment is flagged where it is called, a placeholder is not', () => {
  const content =
    'Run `workflow-hooks run --moment "<moment>"` per the reference.\n' +
    '\n' +
    'Then `workflow-hooks run --moment cleanup.befor --ticket "<TICKET-ID>"` now.\n'

  const findings = findStageHookFindings(content, 'skills/some-skill/SKILL.md')

  assert.deepEqual(
    findings.map((finding) => [finding.category, finding.line, finding.col, finding.matched]),
    [['stage-hook', 3, 7, 'cleanup.befor']]
  )
})

test('findStageHookFindings: a call-site file that stops running one of its moments is flagged', () => {
  const content = 'Run `workflow-hooks run --moment cleanup.before --ticket "<TICKET-ID>"` first.\n'

  const findings = findStageHookFindings(content, 'skills/team-cleanup/SKILL.md')

  assert.deepEqual(
    findings.map((finding) => [finding.category, finding.matched]),
    [['stage-hook', '(no cleanup.after call)']]
  )
})
