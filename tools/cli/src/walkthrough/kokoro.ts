import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VoiceError,
  alignmentOf,
  failureOf,
  isMissing,
  isRecord,
  readCached,
  type Alignment,
  type CuePoint,
  type Narration,
  type SceneText,
  type Voice,
  type VoiceEntry,
  type VoiceProblem,
} from './narration.ts'

// Narration with Kokoro, a local text-to-speech model (FLOW-437). kokoro-helper.py voices the
// scenes and reports when each word starts. uv runs it in an environment it caches, with the
// Kokoro, misaki and the spaCy model pinned below, so nothing is installed into the repo or the
// user's own Python.

export interface KokoroOptions {
  voice: string
  cacheDir: string
}

export interface KokoroWord {
  text: string
  // Seconds from the start of the scene.
  start: number
  end: number
}

interface KokoroScene {
  duration: number
  words: KokoroWord[]
}

interface CacheEntry {
  key: string
  text: string
  audioFile: string
  entryFile: string
  cached: Alignment | undefined
}

export const KOKORO_VERSION = '0.9.4'
// Kokoro's own pace.
export const SPEED = 1

const MISSING_TOOL_EXIT = 2
// The helper's exit code when Kokoro has no speaker by the name it was given.
const UNKNOWN_SPEAKER_EXIT = 3
// The helper's exit code when the speaker is neither cached nor downloadable.
const UNFETCHED_SPEAKER_EXIT = 4
// The helper's progress and warnings go to our stderr; its stdout carries only its reply.
const STDERR = 2
// The reply carries every word of every scene the helper voiced.
const HELPER_REPLY_LIMIT = 64 * 1024 * 1024
const HELPER = fileURLToPath(new URL('./kokoro-helper.py', import.meta.url))
// The spaCy model is pinned too; otherwise misaki downloads it with pip when it is missing.
const UV_RUN_ARGS = [
  '--no-project',
  '--python',
  '3.12',
  '--with',
  `kokoro==${KOKORO_VERSION}`,
  '--with',
  'misaki==0.9.4',
  '--with',
  'soundfile',
  '--with',
  'en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl',
]
// Kokoro's speaker names: language, gender, name, as in af_heart.
const SPEAKER_NAME = /^[a-z][fm]_[a-z0-9]+$/
// American and British English, the languages Kokoro times word by word.
const TIMED_LANGUAGES = ['a', 'b']

// Kokoro, turned on by WALKTHROUGH_KOKORO_VOICE, which names the speaker.
export const kokoroEntry: VoiceEntry = {
  name: 'kokoro',
  label: 'Kokoro',
  variable: 'WALKTHROUGH_KOKORO_VOICE',
  tool: 'kokoro-voice',
  use: 'A local Kokoro voice narrating walkthrough videos',
  onFailure:
    'STOP and tell the user a Kokoro voice is configured but walkthrough render cannot voice the narration with it. Do NOT fall back.',
  fromEnv: ({ env }) => {
    const voice = env.WALKTHROUGH_KOKORO_VOICE || undefined

    return voice === undefined ? undefined : kokoroVoice(voice)
  },
}

// Why the speaker cannot be used, or undefined when it can. Whether Kokoro has the speaker is only
// known once the helper loads it, which is the helper's exit 3.
export const kokoroProblem = (voice: string): VoiceProblem | undefined => {
  const probe = spawnSync('uv', ['--version'], { stdio: 'ignore' })

  if (isMissing(probe)) {
    return {
      message:
        'walkthrough: WALKTHROUGH_KOKORO_VOICE is set, but uv is not on PATH; install it ' +
        '(brew install uv, or https://docs.astral.sh/uv/).',
      exitCode: MISSING_TOOL_EXIT,
    }
  }

  const probeFailure = failureOf('uv --version', probe)

  if (probeFailure !== undefined) {
    return { message: `walkthrough: ${probeFailure}`, exitCode: MISSING_TOOL_EXIT }
  }

  if (!SPEAKER_NAME.test(voice)) {
    return {
      message:
        `walkthrough: WALKTHROUGH_KOKORO_VOICE names "${voice}", which is not a Kokoro speaker ` +
        'name (for example af_heart).',
      exitCode: 1,
    }
  }

  if (!TIMED_LANGUAGES.includes(voice.charAt(0))) {
    return {
      message:
        `walkthrough: WALKTHROUGH_KOKORO_VOICE names "${voice}", whose language Kokoro can't time ` +
        'word by word; use an American (a…) or British (b…) English speaker.',
      exitCode: 1,
    }
  }

  return undefined
}

// Voices each scene, or reuses the cached audio for the same Kokoro version, speaker, speed and
// text. Every scene the cache misses goes to one helper run, since starting Kokoro takes far longer
// than voicing a scene.
export const narrateWithKokoro = (scenes: SceneText[], options: KokoroOptions): Narration[] => {
  const entries = scenes.map(({ narration }) => cacheEntryOf(narration, options))
  const misses = entries.filter(({ cached }) => cached === undefined)
  const voiced = misses.length === 0 ? [] : voiceScenes(misses, options)

  return entries.map((entry) =>
    entry.cached !== undefined
      ? { audioFile: entry.audioFile, alignment: entry.cached, cached: true }
      : { audioFile: entry.audioFile, alignment: voiced[misses.indexOf(entry)], cached: false }
  )
}

// A CuePoint at each word that contains a letter or digit, found in the narration in order. A word
// that isn't found is skipped, and the search goes on from the last word that was.
export const wordPoints = (text: string, words: KokoroWord[]): CuePoint[] => {
  const points: CuePoint[] = []
  let from = 0

  for (const word of words) {
    if (!/[\p{L}\p{N}]/u.test(word.text)) {
      continue
    }

    const found = text.indexOf(word.text, from)

    if (found === -1) {
      continue
    }

    points.push({ index: [...text.slice(0, found)].length, at: word.start })
    from = found + word.text.length
  }

  return points
}

const kokoroVoice = (voice: string): Voice => ({
  name: 'kokoro',
  billsPerCharacter: false,
  problem: () => kokoroProblem(voice),
  narrate: async (scenes, cacheDir) => narrateWithKokoro(scenes, { voice, cacheDir }),
})

const cacheEntryOf = (text: string, options: KokoroOptions): CacheEntry => {
  const key = createHash('sha256')
    .update(JSON.stringify(['kokoro', KOKORO_VERSION, options.voice, SPEED, text]))
    .digest('hex')
  const audioFile = join(options.cacheDir, `${key}.m4a`)
  const entryFile = join(options.cacheDir, `${key}.json`)

  return { key, text, audioFile, entryFile, cached: readCached(entryFile, audioFile) }
}

// Voices the scenes in one helper run, converts each to AAC and caches it with its alignment.
const voiceScenes = (misses: CacheEntry[], options: KokoroOptions): Alignment[] => {
  const workDir = mkdtempSync(join(tmpdir(), 'kokoro-'))

  try {
    const wavs = misses.map((_, i) => join(workDir, `scene-${i}.wav`))
    const replies = runHelper(
      {
        voice: options.voice,
        langCode: options.voice.charAt(0),
        speed: SPEED,
        scenes: misses.map(({ text }, i) => ({ text, wav: wavs[i] })),
      },
      misses.length
    )
    mkdirSync(options.cacheDir, { recursive: true })

    return misses.map(({ key, text, audioFile, entryFile }, i) => {
      const { duration, words } = replies[i]
      toAac(wavs[i], audioFile)
      const alignment = alignmentOf(text, wordPoints(text, words), duration)
      writeFileSync(entryFile, JSON.stringify({ audioFile: `${key}.m4a`, alignment }))

      return alignment
    })
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

// Runs uv with --offline once it has cached the helper's environment, which is every run after the
// first.
const runHelper = (
  request: {
    voice: string
    langCode: string
    speed: number
    scenes: { text: string; wav: string }[]
  },
  count: number
): KokoroScene[] => {
  const ready =
    spawnSync('uv', ['run', '--offline', ...UV_RUN_ARGS, 'python', '-I', '-c', ''], {
      stdio: 'ignore',
    }).status === 0

  if (!ready) {
    console.error(
      'walkthrough: Kokoro is not set up yet, so this first run downloads its model and Python ' +
        'packages; later runs reuse them.'
    )
  }

  const result = spawnSync(
    'uv',
    ['run', ...(ready ? ['--offline'] : []), ...UV_RUN_ARGS, 'python', '-I', HELPER],
    {
      input: JSON.stringify(request),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', STDERR],
      maxBuffer: HELPER_REPLY_LIMIT,
    }
  )

  if (result.error !== undefined) {
    throw new VoiceError(`uv could not run the Kokoro helper: ${result.error.message}`)
  }

  if (result.status === UNKNOWN_SPEAKER_EXIT) {
    throw new VoiceError(`Kokoro has no speaker "${request.voice}"`)
  }

  if (result.status === UNFETCHED_SPEAKER_EXIT) {
    throw new VoiceError(
      `Kokoro could not download the speaker "${request.voice}"; ` +
        'the first render with a new speaker needs the network'
    )
  }

  if (result.signal !== null) {
    throw new VoiceError(`the Kokoro helper was killed by ${result.signal}`)
  }

  if (result.status !== 0) {
    throw new VoiceError(`the Kokoro helper exited with status ${result.status}`)
  }

  const scenes = scenesOf(result.stdout)

  if (scenes === undefined || scenes.length !== count) {
    throw new VoiceError(
      'the Kokoro helper did not reply with a duration and word timings for every scene'
    )
  }

  return scenes
}

const toAac = (wav: string, audioFile: string): void => {
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'aac', audioFile],
    {
      stdio: ['ignore', 'ignore', STDERR],
    }
  )
  const failure = failureOf('ffmpeg', result)

  if (failure !== undefined) {
    throw new VoiceError(`Kokoro's audio could not be converted to AAC: ${failure}`)
  }
}

const scenesOf = (stdout: string): KokoroScene[] | undefined => {
  let reply: unknown

  try {
    reply = JSON.parse(stdout)
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err
    }

    return undefined
  }

  const scenes = isRecord(reply) ? reply.scenes : undefined

  return Array.isArray(scenes) && scenes.every(isKokoroScene) ? scenes : undefined
}

const isKokoroScene = (value: unknown): value is KokoroScene =>
  isRecord(value) &&
  typeof value.duration === 'number' &&
  Array.isArray(value.words) &&
  value.words.every(isKokoroWord)

const isKokoroWord = (value: unknown): value is KokoroWord =>
  isRecord(value) &&
  typeof value.text === 'string' &&
  typeof value.start === 'number' &&
  typeof value.end === 'number'
