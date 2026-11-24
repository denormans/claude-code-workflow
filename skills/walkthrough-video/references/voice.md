# Choosing the voice

Run `check-tools --require elevenlabs,mac-voice,kokoro-voice` first. A `failed` result for any of
them: stop and print the reason. Otherwise the first configured voice narrates the video:
- `elevenlabs` configured: ElevenLabs narrates it. `ELEVEN_LABS_VOICE_ID` overrides the voice the
  CLI pins, per project.
- else `mac-voice` configured: the macOS voice `WALKTHROUGH_MAC_VOICE` names narrates it, free and
  local. The name is as `say -v '?'` lists it. Premium voices, downloaded under System Settings →
  Accessibility → Read & Speak → System voice → Manage Voices… (Spoken Content before macOS 26),
  sound far better than the built-in compact ones.
- else `kokoro-voice` configured: the Kokoro speaker `WALKTHROUGH_KOKORO_VOICE` names, such as
  `af_heart`, narrates it, free and local. Only American (`a…`) and British (`b…`) English
  speakers can be used. It needs uv. The first `walkthrough render` or `walkthrough narrate`
  downloads the model and its packages, about 2 GB and 6 minutes, measured on one cold run in
  October 2026. Run that command in the background. When its stderr says Kokoro is not set up
  yet, tell the user it is downloading the model and its packages, about 2 GB, and will take
  several minutes.
- none: `walkthrough render` makes the video without a voice: each scene lasts as long as
  reading its narration takes, and the narration shows as subtitles. `walkthrough narrate` voices
  nothing and reports each scene's reading time for you to draw the subtitles against. Tell the
  user in one line that the walkthrough is silent and subtitled because no voice is configured.

With more than one configured, the first in this order wins, and `walkthrough render` and
`walkthrough narrate` say on stderr which voices they ignored.
