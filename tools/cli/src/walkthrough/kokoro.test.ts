import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeKokoroStubs } from '../testing/kokoro-stubs.ts'
import {
  KOKORO_VERSION,
  SPEED,
  kokoroProblem,
  narrateWithKokoro,
  wordPoints,
  type KokoroWord,
} from './kokoro.ts'
import { VoiceError } from './narration.ts'

const FIRST_RUN_LINE =
  'walkthrough: Kokoro is not set up yet, so this first run downloads its model and Python packages; later runs reuse them.'

const timed = (entries: [string, number][]): KokoroWord[] =>
  entries.map(([text, start]) => ({ text, start, end: start + 0.1 }))

test('wordPoints skips punctuation and unmatched words', () => {
  const words = timed([
    ['Run', 0],
    ['uv', 0.5],
    ['1.101.0', 1],
    [',', 1.4],
    ['zzz', 1.5],
    ['then', 2],
    ['stop', 2.5],
    ['.', 3],
  ])

  assert.deepEqual(wordPoints('Run uv 1.101.0, then stop.', words), [
    { index: 0, at: 0 },
    { index: 4, at: 0.5 },
    { index: 7, at: 1 },
    { index: 16, at: 2 },
    { index: 21, at: 2.5 },
  ])
})

test('wordPoints moves forward through repeated words', () => {
  const points = wordPoints(
    'the cat and the dog',
    timed([
      ['the', 0],
      ['the', 1.5],
    ])
  )

  assert.deepEqual(
    points.map(({ index }) => index),
    [0, 12]
  )
})

test('wordPoints counts code points', () => {
  assert.deepEqual(wordPoints('café ok', timed([['ok', 1]])), [{ index: 5, at: 1 }])
})

test('kokoroProblem names what is missing or unusable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kokoro-test-'))
  const savedPath = process.env.PATH
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeKokoroStubs(bin)
    process.env.PATH = `${bin}:${savedPath}`
    assert.equal(kokoroProblem('af_heart'), undefined)
    assert.equal(kokoroProblem('bm_george'), undefined)
    assert.deepEqual(kokoroProblem('Heart'), {
      exitCode: 1,
      message:
        'walkthrough: WALKTHROUGH_KOKORO_VOICE names "Heart", which is not a Kokoro speaker name (for example af_heart).',
    })
    assert.deepEqual(kokoroProblem('jf_alpha'), {
      exitCode: 1,
      message:
        'walkthrough: WALKTHROUGH_KOKORO_VOICE names "jf_alpha", whose language Kokoro can\'t time word by word; use an American (a…) or British (b…) English speaker.',
    })

    const empty = join(dir, 'empty')
    mkdirSync(empty)
    process.env.PATH = empty
    assert.deepEqual(kokoroProblem('af_heart'), {
      exitCode: 2,
      message:
        'walkthrough: WALKTHROUGH_KOKORO_VOICE is set, but uv is not on PATH; install it (brew install uv, or https://docs.astral.sh/uv/).',
    })

    const failing = join(dir, 'failing')
    mkdirSync(failing)
    writeFileSync(join(failing, 'uv'), '#!/bin/sh\nexit 4\n')
    chmodSync(join(failing, 'uv'), 0o755)
    process.env.PATH = failing
    assert.deepEqual(kokoroProblem('af_heart'), {
      exitCode: 2,
      message: 'walkthrough: uv --version exited with status 4.',
    })
  } finally {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
})

test('narrateWithKokoro voices misses in one run and caches them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kokoro-test-'))
  const savedPath = process.env.PATH
  const stderr = mock.method(console, 'error', () => undefined)
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeKokoroStubs(bin)
    writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\nfor last; do :; done\n: > "$last"\n')
    chmodSync(join(bin, 'ffmpeg'), 0o755)
    process.env.PATH = `${bin}:${savedPath}`
    const cacheDir = join(dir, 'cache')
    const options = { voice: 'af_heart', cacheDir }
    const calls = (): unknown[] =>
      readFileSync(join(bin, 'uv-calls'), 'utf-8')
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line))
    const scenes = [
      { narration: 'Hello there', cues: [] },
      { narration: 'The client calls', cues: ['client'] },
    ]

    const first = narrateWithKokoro(scenes, options)
    assert.deepEqual(
      first.map(({ cached }) => cached),
      [false, false]
    )
    assert.deepEqual(calls(), [
      {
        offline: false,
        voice: 'af_heart',
        langCode: 'a',
        speed: 1,
        texts: ['Hello there', 'The client calls'],
      },
    ])
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments),
      [[FIRST_RUN_LINE]]
    )
    assert.equal(first[1].alignment.character_start_times_seconds[4], 1)
    assert.equal(first[1].alignment.character_end_times_seconds.at(-1), 3)
    const key = createHash('sha256')
      .update(JSON.stringify(['kokoro', KOKORO_VERSION, 'af_heart', SPEED, 'The client calls']))
      .digest('hex')
    assert.equal(first[1].audioFile, join(cacheDir, `${key}.m4a`))
    assert.ok(existsSync(first[1].audioFile))

    stderr.mock.resetCalls()
    const second = narrateWithKokoro(scenes, options)
    assert.deepEqual(
      second.map(({ cached }) => cached),
      [true, true]
    )
    assert.deepEqual(
      second.map(({ alignment }) => alignment),
      first.map(({ alignment }) => alignment)
    )
    assert.equal(calls().length, 1)
    assert.equal(stderr.mock.calls.length, 0)

    writeFileSync(join(bin, 'uv-cached'), '')
    const third = narrateWithKokoro([...scenes, { narration: 'A third', cues: [] }], options)
    assert.deepEqual(
      third.map(({ cached }) => cached),
      [true, true, false]
    )
    assert.deepEqual(calls()[1], {
      offline: true,
      voice: 'af_heart',
      langCode: 'a',
      speed: 1,
      texts: ['A third'],
    })
    assert.equal(calls().length, 2)
    assert.equal(stderr.mock.calls.length, 0)
  } finally {
    stderr.mock.restore()
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
})

test('narrateWithKokoro reports helper failures as VoiceErrors and caches nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kokoro-test-'))
  const savedPath = process.env.PATH
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeKokoroStubs(bin)
    writeFileSync(join(bin, 'uv-cached'), '')
    process.env.PATH = `${bin}:${savedPath}`
    const cacheDir = join(dir, 'cache')
    const failures: [string, string][] = [
      ['af_nosuch', 'Kokoro has no speaker "af_nosuch"'],
      [
        'af_unfetched',
        'Kokoro could not download the speaker "af_unfetched"; the first render with a new speaker needs the network',
      ],
      ['af_broken', 'the Kokoro helper exited with status 1'],
      [
        'af_garbled',
        'the Kokoro helper did not reply with a duration and word timings for every scene',
      ],
    ]

    for (const [voice, message] of failures) {
      assert.throws(
        () => narrateWithKokoro([{ narration: 'Hello there', cues: [] }], { voice, cacheDir }),
        (err: unknown) => err instanceof VoiceError && err.message === message
      )
    }

    assert.equal(existsSync(cacheDir), false)
  } finally {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
})
