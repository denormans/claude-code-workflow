import { buildCommand, buildRouteMap } from '@stricli/core'
import { runWalkthroughRender } from '../walkthrough/main.ts'

const renderCommand = buildCommand({
  docs: {
    brief: 'Render a walkthrough script to an MP4, narrated or subtitled',
    fullDescription:
      'Reads a walkthrough script (JSON), checks every scene before voicing any of it, voices ' +
      "each scene's narration (reusing <script-basename>.cache/ beside the script for narration " +
      "that has not changed; with a macOS voice, changing a scene's cues re-voices it too), and " +
      'renders the scenes with HyperFrames to the given MP4. ElevenLabs voices it when ' +
      'ELEVEN_LABS_API_KEY is set; otherwise the macOS voice WALKTHROUGH_MAC_VOICE ' +
      "names does, as listed by say -v '?'; otherwise the Kokoro speaker " +
      'WALKTHROUGH_KOKORO_VOICE names does, run locally through uv. With none of them, the ' +
      'video is rendered without a voice: ' +
      'each scene lasts as long as reading its narration takes, and the narration is shown as ' +
      'subtitles. Prints a JSON summary to stdout, whose narrated and voice fields say which. ' +
      'Exits 2 when ffmpeg is missing, HyperFrames cannot find or download Chrome, or the chosen ' +
      'voice needs say, ffprobe or uv and it cannot run; 1 when the script is invalid, the macOS ' +
      'voice is not installed, the Kokoro speaker is not an English Kokoro speaker, Kokoro does ' +
      'not have it or it cannot be downloaded, or voicing or the render fails. ' +
      'ELEVEN_LABS_VOICE_ID picks the ' +
      'ElevenLabs voice; the built-in voice is used when it is unset, and changing it re-voices ' +
      'every scene.',
  },
  parameters: {
    flags: {
      script: {
        kind: 'parsed',
        parse: String,
        brief: 'Path to the walkthrough script JSON',
        optional: false,
      },
      out: {
        kind: 'parsed',
        parse: String,
        brief: 'Path of the MP4 to write',
        optional: false,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  async func(flags: { script: string; out: string }) {
    await runWalkthroughRender(flags.script, flags.out)
  },
})

export const walkthroughRoutes = buildRouteMap({
  routes: { render: renderCommand },
  docs: { brief: 'Architecture walkthrough videos' },
})
