import { kokoroEntry } from './kokoro.ts'
import { macVoiceEntry } from './mac-voice.ts'
import type { Voice, VoiceContext, VoiceEntry } from './narration.ts'
import { elevenLabsEntry } from './tts.ts'

// The walkthrough's voices, in priority order (FLOW-437): the first one whose variable is set
// narrates the walkthrough. check-tools reports one spec per voice from this list as well.
//
// To add a voice, write a module that exports a VoiceEntry: the variable that turns it on, its
// check-tools text, and a fromEnv that builds its Voice. The Voice checks what it needs in
// problem(), and its narrate() caches under a key of its own in the cache directory it is given.
// Then add the entry here, where its priority falls.
export const VOICES: readonly VoiceEntry[] = [elevenLabsEntry, macVoiceEntry, kokoroEntry]

export interface VoiceChoice {
  entry: VoiceEntry
  voice: Voice
  // Configured voices after the chosen one, which don't narrate.
  ignored: VoiceEntry[]
}

// The first configured voice, or undefined when none is.
export const chooseVoice = (
  context: VoiceContext,
  entries: readonly VoiceEntry[] = VOICES
): VoiceChoice | undefined => {
  const configured = entries.flatMap((entry) => {
    const voice = entry.fromEnv(context)

    return voice === undefined ? [] : [{ entry, voice }]
  })

  if (configured.length === 0) {
    return undefined
  }

  const [{ entry, voice }, ...rest] = configured

  return { entry, voice, ignored: rest.map((later) => later.entry) }
}

export const ignoredMessage = (chosen: VoiceEntry, ignored: VoiceEntry): string =>
  `walkthrough: ${chosen.variable} is set, so ${chosen.label} voices the walkthrough and ` +
  `${ignored.variable} is ignored.`

export const silentMessage = (entries: readonly VoiceEntry[] = VOICES): string =>
  `walkthrough: none of ${listOf(entries.map(({ variable }) => variable))} is set, so the ` +
  'walkthrough is rendered without a voice, with the narration as subtitles.'

// "A", "A or B", "A, B or C".
const listOf = (names: string[]): string =>
  names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
