# Rendering with walkthrough render

## Write the script

The script is JSON:

```typescript
interface WalkthroughScript {
  title: string
  palette: 'classic' | 'everglade' | 'origami'  // a diagram palette
  scenes: Scene[]
}

interface Scene {
  heading: string          // shown on screen
  narration: string        // spoken; one narration per scene
  visual:
    | { kind: 'title'; subtitle?: string }
    | { kind: 'bullets'; bullets: string[] }
    | { kind: 'diagram'; d2: string }
    | { kind: 'sequence'; mermaid: string }
  steps?: Step[]           // timed reveals, in narration order
}

interface Step {
  cue: string       // a phrase copied exactly from the scene's narration
  show: string[]    // diagram: D2 ids; bullets: bullet indexes as strings ("0");
                    // sequence: participant ids and message indexes as strings ("0")
  focus?: string[]  // diagram only: D2 ids for the camera to frame
}
```

`palette` is a diagram palette. For an architecture doc's video, use the doc's `diagram-palette`.

### Steps

What lights up when is the part a viewer notices. In a scene the architecture conventions cover
(`SKILL.md` §When it discusses architecture), steps follow these rules. No other scene is bound by
them:

- **Light what the cue sentence names, and the ends of every line it lights.** A step's `show`
  holds what its sentence talks about: usually one box, or one line with the two boxes it joins.
  Never light most of a diagram in one step; a viewer can't follow that.
- **Light a line with both of its ends.** A step that lights an edge also lists, in the same
  `show`, the two shapes the edge joins, or its one shape for an edge from a shape to itself. A
  step that lights a message also lists its sender and receiver, or its one participant for a
  message to itself.
- **Give each step time.** Put cues at least a sentence apart, so every step stays on screen for a
  few seconds before the next.
- **Diagrams open whole and undimmed.** A diagram or sequence scene first shows the whole diagram
  at full strength, however large it is. Everything dims at the first cue, so start the first cue a
  sentence or so in, after the viewer has seen the whole.
- **Bullets start muted.** Every bullet is on screen from the start, muted, and each turns solid at
  its cue. Give each bullet its own step.
- **Use `focus` to zoom.** Use it when the step's boxes are small in a large diagram. Leave it out
  otherwise. A sequence scene can't zoom.

In a diagram scene, `show` and `focus` take D2 ids:
- a shape is its path: `rd`, `rd.d2c`;
- an edge is `(<from> <operator> <to>)[<n>]`, with the operator as written (`->`, `<-`, `<->`,
  `--`): `(docs.d2 -> rd.d2c)[0]`. The number n counts from 0 within one source, operator and
  target, so `a -> b`, `a <-> b` and `b -> a` are each `[0]`, and a second `a -> b` is
  `(a -> b)[1]`;
- an edge inside a container is written inside its path: `rd.(d2c -> ras)[0]`.

In a sequence scene, `show` takes:
- a participant, by the id in the Mermaid source: `rd` for `participant rd as Renderer`;
- a message, by its place among the messages, counting from 0 in source order: `"0"` is the first
  arrow. Notes, blocks such as `loop` and `alt`, and activations are not messages and are not
  counted.

A participant glows, box and lifeline. A message's arrow and label turn yellow, and its sender and
receiver glow with it.

### Diagrams

In a scene the architecture conventions cover, draw each diagram in the house style
(`skills/workflow-guide/references/diagrams.md`), with its reading order and shape rules. In the
video of an architecture doc, reuse the doc's diagrams and their ids where they fit, so the video
and the doc agree, and draw a diagram of the video's own when the story needs a narrower view.

## Render

```bash
walkthrough render --script "<name>.json" --out "<name>.mp4"
```

- The command checks the whole script before it spends anything: the schema, every cue against its
  narration, every diagram compiling, and every `show` id existing. A non-zero exit with a list of
  problems means fix the script and re-run.
- Exit 2 means a tool it needs isn't usable:
  - `ffmpeg -version` doesn't run cleanly, whether `ffmpeg` is missing or broken;
  - `ELEVEN_LABS_API_KEY` is unset, `WALKTHROUGH_MAC_VOICE` is set, and `say` or `ffprobe` doesn't
    run cleanly, whether it is missing or broken (`say` is macOS-only);
  - `WALKTHROUGH_KOKORO_VOICE` is set, the other two voices are unset, and `uv --version` doesn't
    run cleanly, whether `uv` is missing or broken;
  - `hyperframes browser ensure`, run through `npx`, doesn't exit 0. For example: `npx` is missing,
    the HyperFrames package can't be fetched, or no Chrome can be found or downloaded.
- An ElevenLabs error exits 1 with its status. Stop and report ElevenLabs as broken, the same as
  `check-tools`' `onFailure`. Scenes already voiced stay cached.
- With `ELEVEN_LABS_API_KEY` unset, a `WALKTHROUGH_MAC_VOICE` naming a voice that isn't installed
  exits 1 before anything renders.
  Stop and report it, the same as `check-tools`' `onFailure` for `mac-voice`.
- With the other two voices unset, a `WALKTHROUGH_KOKORO_VOICE` that isn't an English Kokoro
  speaker name exits 1 before anything renders, and one Kokoro doesn't have, or can't download,
  exits 1 when the scenes are voiced. Stop and report it, the same as `check-tools`' `onFailure`
  for `kokoro-voice`.
- stdout is a JSON summary. `narrated: false` means the video was rendered silent, with subtitles.
  `voice` says which voice narrated it: `elevenlabs`, `mac`, `kokoro`, or `null`.

### Watch it before delivering

Pull a few frames as PNGs, one per diagram or sequence scene, at the scene's busiest step; in a
silent video, also one per title and bullets scene, and in a video with no diagram or sequence
scene, one per scene:
`ffmpeg -loglevel error -ss "<seconds>" -i "<mp4>" -frames:v 1 "<scratchpad>/<name>.png"`. Have an
`artifact-viewer` check each frame:
- in a scene the architecture conventions cover, the lit elements are what the cue names, plus both
  ends of every lit edge or message;
- in a scene the architecture conventions cover, the diagram reads in one direction;
- nothing is clipped;
- each frame matches what its narration says at that moment;
- in a silent video, the subtitle reads cleanly and sits below the diagram, not over it.

Never write raw video frames (`.rgb`, rawvideo) to disk: the user's antivirus deletes them as
malware. Use PNG.
