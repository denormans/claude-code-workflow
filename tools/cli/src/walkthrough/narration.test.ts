import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignmentOf } from './narration.ts'

test('alignmentOf spreads each segment evenly', () => {
  assert.deepEqual(alignmentOf('abcd', [{ index: 2, at: 1 }], 3), {
    characters: ['a', 'b', 'c', 'd'],
    character_start_times_seconds: [0, 0.5, 1, 2],
    character_end_times_seconds: [0.5, 1, 2, 3],
  })
})

test('alignmentOf never runs time backwards', () => {
  const result = alignmentOf(
    'abc',
    [
      { index: 1, at: 2 },
      { index: 2, at: 1 },
    ],
    1.5
  )
  assert.deepEqual(result.character_start_times_seconds, [0, 1.5, 1.5])
  assert.deepEqual(result.character_end_times_seconds, [1.5, 1.5, 1.5])
})

test('alignmentOf with a cue at the start', () => {
  const result = alignmentOf('ab', [{ index: 0, at: 0 }], 2)
  assert.deepEqual(result.character_start_times_seconds, [0, 1])
  assert.deepEqual(result.character_end_times_seconds, [1, 2])
})
