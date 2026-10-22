import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VoiceError,
  alignmentOf,
  failureOf,
  isMissing,
  readCached,
  type CuePoint,
  type Narration,
  type Voice,
  type VoiceEntry,
  type VoiceProblem,
} from './narration.ts'

// Narration with a macOS voice (FLOW-432). `say` reports no timings, so each cue's time is how long
// the voice takes to say the narration up to it, and the characters between two such points are
// spread evenly over the time between them.

export interface MacVoiceOptions {
  voice: string
  cacheDir: string
}

export class MacVoiceError extends VoiceError {}

const MISSING_TOOL_EXIT = 2
const AAC = ['--file-format=m4af', '--data-format=aac']

// A macOS voice, turned on by WALKTHROUGH_MAC_VOICE, which names it as `say -v '?'` lists it.
export const macVoiceEntry: VoiceEntry = {
  name: 'mac',
  label: 'a macOS voice',
  variable: 'WALKTHROUGH_MAC_VOICE',
  tool: 'mac-voice',
  use: 'A macOS voice narrating walkthrough videos',
  onFailure:
    'STOP and tell the user a macOS voice is configured but walkthrough render cannot voice the narration with it. Do NOT fall back.',
  fromEnv: ({ env }) => {
    const voice = env.WALKTHROUGH_MAC_VOICE || undefined

    return voice === undefined ? undefined : macVoice(voice)
  },
}

// Why the voice cannot be used, or undefined when it can. Checked before any work, because `say`
// given a voice it does not have speaks with the system voice instead and exits 0.
export const macVoiceProblem = (voice: string): VoiceProblem | undefined => {
  const listing = spawnSync('say', ['-v', '?'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })

  if (isMissing(listing)) {
    return {
      message:
        'walkthrough: WALKTHROUGH_MAC_VOICE is set, but say cannot be run; macOS voices need macOS.',
      exitCode: MISSING_TOOL_EXIT,
    }
  }

  const listingFailure = failureOf("say -v '?'", listing)

  if (listingFailure !== undefined) {
    return { message: `walkthrough: ${listingFailure}`, exitCode: MISSING_TOOL_EXIT }
  }

  const probe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' })

  if (isMissing(probe)) {
    return {
      message: 'walkthrough: ffprobe cannot be run; it comes with ffmpeg (brew install ffmpeg).',
      exitCode: MISSING_TOOL_EXIT,
    }
  }

  const probeFailure = failureOf('ffprobe -version', probe)

  if (probeFailure !== undefined) {
    return { message: `walkthrough: ${probeFailure}`, exitCode: MISSING_TOOL_EXIT }
  }

  if (!voicesOf(listing.stdout).includes(voice)) {
    return {
      message:
        `walkthrough: WALKTHROUGH_MAC_VOICE names "${voice}", which is not an installed voice; ` +
        "say -v '?' lists them.",
      exitCode: 1,
    }
  }

  return undefined
}

// Speaks `text`, or reuses the cached audio for the same voice, text and cues.
export const narrateWithMacVoice = (
  text: string,
  cues: string[],
  options: MacVoiceOptions
): Narration => {
  const key = createHash('sha256')
    .update(JSON.stringify(['mac', options.voice, text, cues]))
    .digest('hex')
  const audioFile = join(options.cacheDir, `${key}.m4a`)
  const entryFile = join(options.cacheDir, `${key}.json`)
  const cached = readCached(entryFile, audioFile)

  if (cached !== undefined) {
    return { audioFile, alignment: cached, cached: true }
  }

  mkdirSync(options.cacheDir, { recursive: true })
  speak(text, options.voice, audioFile, AAC)
  const alignment = alignmentOf(text, cuePoints(text, cues, options.voice), durationOf(audioFile))
  writeFileSync(entryFile, JSON.stringify({ audioFile: `${key}.m4a`, alignment }))

  return { audioFile, alignment, cached: false }
}

// Each voice's name in `say -v '?'`'s listing: the text before its locale.
export const voicesOf = (listing: string): string[] =>
  listing.split('\n').flatMap((line) => {
    const name = /^(.+?)\s+[a-z]{2,3}_[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\s+#/.exec(line)?.[1]
    return name === undefined ? [] : [name]
  })

const macVoice = (voice: string): Voice => ({
  name: 'mac',
  billsPerCharacter: false,
  problem: () => macVoiceProblem(voice),
  narrate: async (scenes, cacheDir) =>
    scenes.map(({ narration, cues }) => narrateWithMacVoice(narration, cues, { voice, cacheDir })),
})

// Where each cue starts, in code points, and how long the voice takes to reach it.
const cuePoints = (text: string, cues: string[], voice: string): CuePoint[] => {
  const workDir = mkdtempSync(join(tmpdir(), 'mac-voice-'))

  try {
    let from = 0
    return cues.map((cue, i) => {
      const found = text.indexOf(cue, from)

      if (found === -1) {
        throw new MacVoiceError(
          `cue "${cue}" does not occur in the narration after the previous cue`
        )
      }

      from = found + cue.length
      const prefix = text.slice(0, found)
      const index = [...prefix].length

      if (prefix.trim() === '') {
        return { index, at: 0 }
      }

      const clip = join(workDir, `cue-${i}.aiff`)
      speak(prefix, voice, clip, [])

      return { index, at: durationOf(clip) }
    })
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

// The text goes in on stdin, so narration starting with "-" is never read as an option.
const speak = (text: string, voice: string, file: string, format: string[]): void => {
  const result = spawnSync('say', ['-v', voice, '-o', file, ...format, '-f', '-'], {
    input: text,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'],
  })

  if (result.error !== undefined) {
    throw new MacVoiceError(`say could not be run: ${result.error.message}`)
  }

  if (result.status !== 0) {
    throw new MacVoiceError(`say failed: ${result.stderr.trim() || String(result.status)}`)
  }
}

const durationOf = (file: string): number => {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )

  if (result.error !== undefined) {
    throw new MacVoiceError(`ffprobe could not be run: ${result.error.message}`)
  }

  const duration = Number.parseFloat(result.stdout.trim())

  if (result.status !== 0 || !Number.isFinite(duration)) {
    throw new MacVoiceError(
      `ffprobe could not read the duration of ${file}: ${result.stderr.trim()}`
    )
  }

  return duration
}
