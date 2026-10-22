import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kokoroEntry } from './kokoro.ts'
import { macVoiceEntry } from './mac-voice.ts'
import { DEFAULT_VOICE_ID, MODEL_ID, SPEED, elevenLabsEntry } from './tts.ts'
import { chooseVoice, ignoredMessage, silentMessage } from './voices.ts'

const ALIGNMENT = {
  characters: ['H'],
  character_start_times_seconds: [0],
  character_end_times_seconds: [1],
}

test('chooseVoice picks by priority', () => {
  assert.equal(chooseVoice({ env: {} }), undefined)

  const both = chooseVoice({
    env: { ELEVEN_LABS_API_KEY: 'k', WALKTHROUGH_MAC_VOICE: 'Tester' },
  })
  assert.equal(both?.entry, elevenLabsEntry)
  assert.equal(both?.voice.name, 'elevenlabs')
  assert.deepEqual(both?.ignored, [macVoiceEntry])

  const mac = chooseVoice({ env: { WALKTHROUGH_MAC_VOICE: 'Tester' } })
  assert.equal(mac?.entry, macVoiceEntry)
  assert.deepEqual(mac?.ignored, [])

  const all = chooseVoice({
    env: {
      ELEVEN_LABS_API_KEY: 'k',
      WALKTHROUGH_MAC_VOICE: 'Tester',
      WALKTHROUGH_KOKORO_VOICE: 'af_heart',
    },
  })
  assert.equal(all?.entry, elevenLabsEntry)
  assert.deepEqual(all?.ignored, [macVoiceEntry, kokoroEntry])

  const kokoro = chooseVoice({ env: { WALKTHROUGH_KOKORO_VOICE: 'af_heart' } })
  assert.equal(kokoro?.entry, kokoroEntry)
  assert.equal(kokoro?.voice.billsPerCharacter, false)
})

test('an empty variable is unset', () => {
  const choice = chooseVoice({ env: { ELEVEN_LABS_API_KEY: '', WALKTHROUGH_MAC_VOICE: 'Tester' } })
  assert.equal(choice?.entry, macVoiceEntry)
  assert.deepEqual(choice?.ignored, [])
})

test('messages name the variables of the voices involved', () => {
  assert.equal(
    ignoredMessage(elevenLabsEntry, macVoiceEntry),
    'walkthrough: ELEVEN_LABS_API_KEY is set, so ElevenLabs voices the walkthrough and WALKTHROUGH_MAC_VOICE is ignored.'
  )
  assert.equal(
    silentMessage([elevenLabsEntry]),
    'walkthrough: none of ELEVEN_LABS_API_KEY is set, so the walkthrough is rendered without a voice, with the narration as subtitles.'
  )
  assert.equal(
    ignoredMessage(macVoiceEntry, kokoroEntry),
    'walkthrough: WALKTHROUGH_MAC_VOICE is set, so a macOS voice voices the walkthrough and WALKTHROUGH_KOKORO_VOICE is ignored.'
  )
  assert.equal(
    silentMessage(),
    'walkthrough: none of ELEVEN_LABS_API_KEY, WALKTHROUGH_MAC_VOICE or WALKTHROUGH_KOKORO_VOICE is set, so the walkthrough is rendered without a voice, with the narration as subtitles.'
  )
})

test('only ElevenLabs bills per character', () => {
  assert.equal(
    elevenLabsEntry.fromEnv({ env: { ELEVEN_LABS_API_KEY: 'k' } })?.billsPerCharacter,
    true
  )
  assert.equal(
    macVoiceEntry.fromEnv({ env: { WALKTHROUGH_MAC_VOICE: 'Tester' } })?.billsPerCharacter,
    false
  )
})

test('a cache written before the voices were registered still hits, for each voice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voices-test-'))
  const savedPath = process.env.PATH
  try {
    const elevenKey = createHash('sha256')
      .update(DEFAULT_VOICE_ID + MODEL_ID + SPEED + 'Hello.')
      .digest('hex')
    writeFileSync(join(dir, `${elevenKey}.mp3`), 'audio')
    writeFileSync(
      join(dir, `${elevenKey}.json`),
      JSON.stringify({ audioFile: `${elevenKey}.mp3`, alignment: ALIGNMENT })
    )
    const eleven = await elevenLabsEntry
      .fromEnv({ env: { ELEVEN_LABS_API_KEY: 'k' }, apiBase: 'http://127.0.0.1:9' })
      ?.narrate([{ narration: 'Hello.', cues: [] }], dir)
    assert.deepEqual(eleven, [
      { audioFile: join(dir, `${elevenKey}.mp3`), alignment: ALIGNMENT, cached: true },
    ])

    const macKey = createHash('sha256')
      .update(JSON.stringify(['mac', 'Tester', 'Hello.', []]))
      .digest('hex')
    writeFileSync(join(dir, `${macKey}.m4a`), 'audio')
    writeFileSync(
      join(dir, `${macKey}.json`),
      JSON.stringify({ audioFile: `${macKey}.m4a`, alignment: ALIGNMENT })
    )
    const empty = join(dir, 'empty')
    mkdirSync(empty)
    process.env.PATH = empty
    const mac = await macVoiceEntry
      .fromEnv({ env: { WALKTHROUGH_MAC_VOICE: 'Tester' } })
      ?.narrate([{ narration: 'Hello.', cues: [] }], dir)
    assert.deepEqual(mac, [
      { audioFile: join(dir, `${macKey}.m4a`), alignment: ALIGNMENT, cached: true },
    ])
  } finally {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
})
