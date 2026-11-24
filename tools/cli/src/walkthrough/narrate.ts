import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { probeFfmpeg } from './main.ts'
import {
  VoiceError,
  cacheDirOf,
  findCue,
  isRecord,
  type Alignment,
  type Narration,
  type Voice,
  type VoiceName,
} from './narration.ts'
import { ScriptError } from './script.ts'
import { readingAlignment } from './silent.ts'
import { VOICES, chooseVoice, ignoredMessage, listOf } from './voices.ts'

// Voices scenes for a video whose visuals are drawn elsewhere (FLOW-473), with the same voice
// choice and cache as walkthrough render.

interface NarrationScript {
  scenes: NarrationScene[]
}

interface NarrationScene {
  id: string
  narration: string
  cues: string[]
}

interface NarrationOutput {
  narrated: boolean
  voice: VoiceName | null
  scenes: {
    id: string
    audioFile: string | null
    durationSeconds: number
    cues: { cue: string; atSeconds: number }[]
  }[]
}

interface NarrateOptions {
  stdout?: (chunk: string) => void
  env?: NodeJS.ProcessEnv
  apiBase?: string
}

class NarrateError extends Error {}

const SCENE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const MISSING_TOOL_EXIT = 2

export const runWalkthroughNarrate = async (
  scriptFile: string,
  outDir: string,
  options: NarrateOptions = {}
): Promise<void> => {
  const env = options.env ?? process.env
  const stdout = options.stdout ?? ((chunk: string) => void process.stdout.write(chunk))

  const choice = chooseVoice({ env, apiBase: options.apiBase })
  const voice = choice?.voice
  if (choice === undefined) {
    console.error(noVoiceMessage())
  } else {
    for (const ignored of choice.ignored) {
      console.error(ignoredMessage(choice.entry, ignored))
    }
  }

  const ffmpegProblem = voice?.name === 'kokoro' ? probeFfmpeg() : undefined
  if (ffmpegProblem !== undefined) {
    console.error(ffmpegProblem)
    setRequestedExitCode(MISSING_TOOL_EXIT)
    return
  }

  const voiceProblem = voice?.problem()
  if (voiceProblem !== undefined) {
    console.error(voiceProblem.message)
    setRequestedExitCode(voiceProblem.exitCode)
    return
  }

  const script = readNarrationScript(scriptFile)
  if (script === undefined) {
    setRequestedExitCode(1)
    return
  }

  if (voice !== undefined && !prepareDirs(voice, script, scriptFile, outDir)) {
    setRequestedExitCode(1)
    return
  }

  const narrations = voice === undefined ? [] : await voiceScenes(voice, script, scriptFile)
  if (narrations === undefined) {
    setRequestedExitCode(1)
    return
  }

  const output = summarize(script, narrations, outDir, voice)
  if (output === undefined) {
    setRequestedExitCode(1)
    return
  }

  stdout(JSON.stringify(output) + '\n')
}

// The cache dir only matters when a scene still needs voicing, so a fully cached run does not
// need it to be writable.
const prepareDirs = (
  voice: Voice,
  script: NarrationScript,
  scriptFile: string,
  outDir: string
): boolean => {
  if (!prepareDir(outDir, 'out dir') || !destinationsWritable(voice, script, outDir)) {
    return false
  }

  const cacheDir = cacheDirOf(scriptFile)
  const needsVoicing = script.scenes.some(
    ({ narration, cues }) => !voice.isCached({ narration, cues }, cacheDir)
  )

  return !needsVoicing || prepareDir(cacheDir, 'cache dir')
}

const destinationsWritable = (voice: Voice, script: NarrationScript, outDir: string): boolean => {
  for (const { id } of script.scenes) {
    const destination = destinationOf(voice, id, outDir)
    const problem = destinationProblem(destination)

    if (problem !== undefined) {
      console.error(`walkthrough: ${destination} cannot be written: ${problem}`)
      return false
    }
  }

  return true
}

// A destination is absent, which the copy creates, or a regular file, which must open for writing
// as the copy opens it. Anything else is never opened: opening a FIFO ends its reader's stream.
const destinationProblem = (destination: string): string | undefined => {
  try {
    const stats = statSync(destination)

    if (!stats.isFile()) {
      return 'it is not a regular file'
    }

    const owner = ownerProblem(stats.uid, process.getuid?.())

    if (owner !== undefined) {
      return owner
    }

    closeSync(openSync(destination, constants.O_WRONLY))
    return undefined
  } catch (err) {
    if (!isErrnoError(err)) {
      throw err
    }

    return err.code === 'ENOENT' ? brokenLinkProblem(destination) : err.message
  }
}

// A copy over a file this user doesn't own truncates it, can't set its times and mode, and then
// removes it, so that file is refused before anything is voiced.
export const ownerProblem = (
  fileUid: number,
  processUid: number | undefined
): string | undefined =>
  processUid === undefined || processUid === 0 || processUid === fileUid
    ? undefined
    : 'it is owned by another user'

const brokenLinkProblem = (destination: string): string | undefined => {
  try {
    return lstatSync(destination).isSymbolicLink() ? 'it is a broken symbolic link' : undefined
  } catch (err) {
    if (!isErrnoError(err)) {
      throw err
    }

    return err.code === 'ENOENT' ? undefined : err.message
  }
}

const isErrnoError = (err: unknown): err is NodeJS.ErrnoException =>
  err instanceof Error && 'code' in err

// Fails here, before any scene is voiced, when a directory narrate writes to cannot take files.
const prepareDir = (dir: string, role: 'out dir' | 'cache dir'): boolean => {
  try {
    mkdirSync(dir, { recursive: true })
    createAndRemoveProbe(dir)
    return true
  } catch (err) {
    if (err instanceof Error && 'code' in err) {
      console.error(`walkthrough: ${dir} cannot be used as the ${role}: ${err.message}`)
      return false
    }

    throw err
  }
}

// Whatever would stop a new file from being created in the directory (mode, read-only volume, ACL)
// stops creating this one.
const createAndRemoveProbe = (dir: string): void => {
  const probe = join(dir, `.walkthrough-probe-${randomUUID()}`)

  try {
    writeFileSync(probe, '', { flag: 'wx' })
  } catch (err) {
    if (err instanceof Error && 'code' in err) {
      throw Object.assign(new Error(`${String(err.code)}: cannot create files in '${dir}'`), {
        code: err.code,
      })
    }

    throw err
  }

  rmSync(probe, { force: true })
}

const summarize = (
  script: NarrationScript,
  narrations: Narration[],
  outDir: string,
  voice: Voice | undefined
): NarrationOutput | undefined => {
  try {
    return {
      narrated: voice !== undefined,
      voice: voice?.name ?? null,
      scenes: script.scenes.map((scene, i) => {
        const narration = narrations[i]
        const alignment = narration?.alignment ?? readingAlignment(scene.narration)

        return {
          id: scene.id,
          audioFile:
            narration === undefined || voice === undefined
              ? null
              : copyAudio(narration, destinationOf(voice, scene.id, outDir)),
          durationSeconds: alignment.character_end_times_seconds.at(-1) ?? 0,
          cues: cueTimes(scene, alignment),
        }
      }),
    }
  } catch (err) {
    if (err instanceof NarrateError) {
      console.error(err.message)
      return undefined
    }

    throw err
  }
}

const noVoiceMessage = (): string =>
  `walkthrough: none of ${listOf(VOICES.map(({ variable }) => variable))} is set, so no scene ` +
  'is voiced and every audioFile is null.'

const parseNarrationScript = (value: unknown): NarrationScript => {
  const problems: string[] = []
  if (!isRecord(value) || !Array.isArray(value.scenes) || value.scenes.length === 0) {
    throw new ScriptError(['scenes: expected a non-empty array'])
  }

  // Keyed by lower case: ids that differ only by case name one file on a case-insensitive volume.
  const seen = new Map<string, string>()
  const scenes = value.scenes.flatMap((scene: unknown, i: number) => {
    const parsed = readScene(scene, `scenes[${i}]`, problems)
    if (parsed === undefined) {
      return []
    }

    const earlier = seen.get(parsed.id.toLowerCase())
    if (earlier === parsed.id) {
      problems.push(`scenes[${i}].id: "${parsed.id}" is used by an earlier scene`)
    } else if (earlier !== undefined) {
      problems.push(`scenes[${i}].id: "${parsed.id}" differs only by case from "${earlier}"`)
    } else {
      seen.set(parsed.id.toLowerCase(), parsed.id)
    }

    return [parsed]
  })
  if (problems.length > 0) {
    throw new ScriptError(problems)
  }

  return { scenes }
}

const readNarrationScript = (scriptFile: string): NarrationScript | undefined => {
  try {
    return parseNarrationScript(JSON.parse(readFileSync(scriptFile, 'utf-8')))
  } catch (err) {
    if (err instanceof ScriptError || err instanceof SyntaxError) {
      console.error(`${scriptFile}: ${err.message}`)
      return undefined
    }

    if (err instanceof Error && 'code' in err) {
      console.error(`${scriptFile}: cannot read the script: ${err.message}`)
      return undefined
    }

    throw err
  }
}

const readScene = (value: unknown, at: string, problems: string[]): NarrationScene | undefined => {
  if (!isRecord(value)) {
    problems.push(`${at}: expected an object`)
    return undefined
  }

  const { id, narration, cues = [] } = value
  if (typeof id !== 'string' || !SCENE_ID.test(id)) {
    problems.push(`${at}.id: expected letters, digits and hyphens, starting with a letter or digit`)
  }
  if (typeof narration !== 'string' || narration.trim() === '') {
    problems.push(`${at}.narration: expected a non-empty string`)
  }
  if (!Array.isArray(cues) || !cues.every((cue) => typeof cue === 'string' && cue.trim() !== '')) {
    problems.push(`${at}.cues: expected an array of non-empty strings`)
    return undefined
  }
  if (typeof id !== 'string' || !SCENE_ID.test(id) || typeof narration !== 'string') {
    return undefined
  }

  const characters = Array.from(narration)
  let from = 0
  for (const cue of cues) {
    const found = findCue(characters, cue, from)
    if (found === undefined) {
      problems.push(`${at}.cues: "${cue}" is not in the narration after the cue before it`)
      continue
    }

    from = found.end
  }

  return { id, narration, cues }
}

const voiceScenes = async (
  voice: Voice,
  script: NarrationScript,
  scriptFile: string
): Promise<Narration[] | undefined> => {
  try {
    return await voice.narrate(
      script.scenes.map(({ narration, cues }) => ({ narration, cues })),
      cacheDirOf(scriptFile)
    )
  } catch (err) {
    if (!(err instanceof VoiceError)) {
      throw err
    }

    console.error(`${scriptFile}: ${err.message}`)
    return undefined
  }
}

const copyAudio = (narration: Narration, target: string): string => {
  try {
    copyFileSync(narration.audioFile, target)
  } catch (err) {
    if (err instanceof Error && 'code' in err) {
      throw new NarrateError(`walkthrough: ${target} cannot be written: ${err.message}`)
    }

    throw err
  }

  return target
}

const destinationOf = (voice: Voice, id: string, outDir: string): string =>
  resolve(join(outDir, `${id}${voice.audioExtension}`))

const cueTimes = (
  scene: NarrationScene,
  alignment: Alignment
): { cue: string; atSeconds: number }[] => {
  let from = 0

  return scene.cues.map((cue) => {
    const found = findCue(alignment.characters, cue, from)
    const atSeconds =
      found === undefined ? undefined : alignment.character_start_times_seconds[found.start]
    if (found === undefined || atSeconds === undefined) {
      throw new NarrateError(
        `walkthrough: scene ${scene.id}'s cue "${cue}" is not in the voice's alignment`
      )
    }

    from = found.end

    return { cue, atSeconds }
  })
}
