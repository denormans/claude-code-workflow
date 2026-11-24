---
name: walkthrough-video
description: Use when making any narrated or walkthrough video — a product or code walkthrough, explainer, demo, screencast, or video tour — whether or not the request says "walkthrough". Uses the voice the user has configured instead of a default one, and covers scripting, rendering, and checking the result. Applies the established architecture conventions to an architecture doc's video, and to the scenes of any other video that show architecture.
---

# Walkthrough Video

Every narrated video uses the user's configured voice. Never synthesize speech any other way, and never pick a voice yourself.

## 1. Choose the voice

Follow `references/voice.md`.

## 2. Choose how to draw it

| The video | Draw it with | Voice it with |
|---|---|---|
| Works as slides, diagrams, or sequence flows, including the video of an architecture doc | `walkthrough render` (`references/render.md`) | Built in |
| Needs custom visuals, such as a screen recording, animation, or real product UI, even if some scenes show architecture | Whatever suits the video | `walkthrough narrate` (below) |

Visuals are your call outside architecture. Choose what explains the subject best.

### When it discusses architecture

The architecture conventions are the house diagram style (`skills/workflow-guide/references/diagrams.md`), the reveal rules in `references/render.md` §Steps, and the architecture checks in `references/render.md` §Watch it before delivering. They apply to every scene of the video of an architecture doc. In any other video that shows architecture, they apply to the scenes that show architecture and to no others, since they may not suit every walkthrough. A video with no architecture follows none of them. The palette is set once for the video, so the doc's `diagram-palette` is used only for the video of an architecture doc.

The story order in `skills/architecture/references/walkthrough.md` is for the video of an architecture doc. Follow it only when making that video.

## 3. Write the narration

Write it to be heard: plain spoken sentences, no markdown, no ids, and no file paths read out. Say what a thing is for, not what it is called in the code. Don't mention the voice or how it was made.

## 4. Voice custom visuals

```bash
walkthrough narrate --script "<name>.json" --out-dir "<dir>"
```

The script lists the scenes:

```json
{ "scenes": [{ "id": "intro", "narration": "Spoken text.", "cues": ["Spoken"] }] }
```

An `id` is letters, digits, and hyphens, and no two ids may differ only by case. Each cue is a phrase copied exactly from its narration, in order. Narration is cached in `<name>.cache/` beside the script, so keep it between runs.

stdout is JSON with `narrated`, `voice`, and per scene `id`, `audioFile`, `durationSeconds`, and `cues` (`cue`, `atSeconds`). Time the visuals to those values. With `narrated: false` no voice is configured and `audioFile` is `null`, so show the narration as subtitles for `durationSeconds`, and tell the user in one line that the video is silent and subtitled because no voice is configured.

Exit 2 means a tool the voice needs can't run. Exit 1 means a voice that is configured but can't be used (an uninstalled macOS voice or an unsupported Kokoro speaker), an invalid or unreadable script, an unusable `--out-dir`, an unusable `<name>.cache/` when a scene still needs voicing, a failed voice, a cue missing from the voice's timing, or an audio file that can't be written. Stop and report either one, and never fall back to another voice.

## 5. Check it before delivering

For a video made with `walkthrough render`, pull and check frames as `references/render.md` §Watch it before delivering says. For a video with custom visuals, pull one frame per scene, and have the `artifact-viewer` check that nothing is clipped and that each frame matches what its narration says at that moment. In a scene the architecture conventions cover, also apply the architecture checks in `references/render.md` §Watch it before delivering. Pull frames as PNGs, never as raw video frames, as that section says.
