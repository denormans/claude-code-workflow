import type { SpawnSyncReturns } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// What every walkthrough voice shares (FLOW-437): the narration a voice returns, the cache entry it
// reads back, the timings it builds, and the interface it implements. voices.ts lists the voices.

// ElevenLabs' character timings, in its own field names. Every voice gives its timings this shape.
export interface Alignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

export interface Narration {
  audioFile: string
  alignment: Alignment
  cached: boolean
}

export interface CuePoint {
  // Code points into the narration.
  index: number
  // Seconds from the start of the narration.
  at: number
}

export interface SceneText {
  narration: string
  // Each step's cue, in order.
  cues: string[]
}

export interface VoiceProblem {
  message: string
  // 2 for a missing or broken tool, 1 for a bad setting.
  exitCode: number
}

export class VoiceError extends Error {}

export type VoiceName = 'elevenlabs' | 'mac' | 'kokoro'

export interface Voice {
  name: VoiceName
  // Only ElevenLabs charges by the character; it is what the summary's ttsCharacters counts.
  billsPerCharacter: boolean
  // Why this voice can't narrate, checked before the script is prepared; undefined when it can.
  problem(): VoiceProblem | undefined
  // One narration per scene, in order. Reuses the cache; throws VoiceError.
  narrate(scenes: SceneText[], cacheDir: string): Promise<Narration[]>
}

export interface VoiceContext {
  env: NodeJS.ProcessEnv
  // The ElevenLabs API origin; tests point it at a local server.
  apiBase?: string
}

export interface VoiceEntry {
  name: VoiceName
  // How messages name the voice: "ElevenLabs voices the walkthrough".
  label: string
  // The environment variable that turns the voice on.
  variable: string
  // check-tools' name for the voice, and its spec text.
  tool: string
  use: string
  onFailure: string
  // The voice, when its variable is set.
  fromEnv(context: VoiceContext): Voice | undefined
}

export const readCached = (entryFile: string, audioFile: string): Alignment | undefined => {
  try {
    const entry: unknown = JSON.parse(readFileSync(entryFile, 'utf-8'))
    const alignment = isRecord(entry) ? entry.alignment : undefined
    return isAlignment(alignment) && existsSync(audioFile) ? alignment : undefined
  } catch {
    return undefined
  }
}

// An alignment in ElevenLabs' shape that passes through every cue point and ends at `duration`,
// with the characters between two points spread evenly over the time between them.
export const alignmentOf = (text: string, points: CuePoint[], duration: number): Alignment => {
  const characters = [...text]
  const starts: number[] = []
  const ends: number[] = []
  let from: CuePoint = { index: 0, at: 0 }

  for (const point of [...points, { index: characters.length, at: duration }]) {
    // A point can come later than the next one, or than the whole narration; time never runs
    // backwards.
    const at = Math.min(Math.max(point.at, from.at), duration)
    const step = (at - from.at) / Math.max(point.index - from.index, 1)

    for (let i = from.index; i < point.index; i++) {
      starts.push(from.at + (i - from.index) * step)
      ends.push(from.at + (i - from.index + 1) * step)
    }

    from = { index: point.index, at }
  }

  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends }
}

export const isMissing = (result: SpawnSyncReturns<unknown>): boolean =>
  result.error !== undefined && 'code' in result.error && result.error.code === 'ENOENT'

// Why a command that was found did not succeed, or undefined when it did.
export const failureOf = (
  command: string,
  result: SpawnSyncReturns<unknown>
): string | undefined => {
  if (result.error !== undefined) {
    const code = 'code' in result.error ? result.error.code : undefined

    return `${command} could not be run (${String(code ?? result.error.message)}).`
  }

  if (result.signal !== null) {
    return `${command} was killed by ${result.signal}.`
  }

  if (result.status !== 0) {
    return `${command} exited with status ${result.status}.`
  }

  return undefined
}

export const isAlignment = (value: unknown): value is Alignment =>
  isRecord(value) &&
  isArrayOf(value.characters, 'string') &&
  isArrayOf(value.character_start_times_seconds, 'number') &&
  isArrayOf(value.character_end_times_seconds, 'number')

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isArrayOf = (value: unknown, type: 'string' | 'number'): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === type)
