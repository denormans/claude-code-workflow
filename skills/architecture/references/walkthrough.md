# Walkthrough Videos

The Architecture skill gives each architecture doc a walkthrough video at the top of its hosted
Notion page: narrated by ElevenLabs, a macOS voice or a local Kokoro voice when one is
configured, and silent with the narration as subtitles when none is. The video tells the story of
the work in a few minutes, so the user can review the design by watching it. The skill writes the
script after the doc and renders it before hosting. Whenever a revision changes what the video
says, it re-renders before re-hosting.

Choosing the voice, the script format, narration, reveal rules, rendering, and frame checks are in the Walkthrough Video skill (`workflow:walkthrough-video`). Follow it, using the paths in §Files. Save the script and video beside the doc, and render with `--script "docs/plans/<doc-basename>.walkthrough.json" --out "docs/plans/<doc-basename>.walkthrough.mp4"`.

## Files

All of these sit beside the doc in `docs/plans/`. `<doc-basename>` is the doc's file name without
`.md`.

| File | What it is |
|---|---|
| `<doc-basename>.walkthrough.json` | The script. You write it. |
| `<doc-basename>.walkthrough.cache/` | Narration audio, cached by text and voice, and by the model and speed the CLI pins for ElevenLabs, by the scene's cues for a macOS voice, or by the Kokoro version the CLI pins for Kokoro. `walkthrough render` writes it; keep it between renders. |
| `<doc-basename>.walkthrough.mp4` | The video. |

The doc's first line under its title embeds the video: `![Walkthrough](<doc-basename>.walkthrough.mp4)`.
Hosting turns that line into a Notion video (`skills/workflow-guide/references/notification-protocol.md`
§Phase 1).

`walkthrough render`'s JSON summary says `overNotionLimit: true` when the video is over 20 MiB and
won't upload. Host the doc without the video and tell the user.

## Tell the story through the work

The video runs as long as the content needs. Scenes go in this order:

1. **Title.** The doc's title, with a one-line subtitle.
2. **The problem.** From the PRD, as bullets.
3. **North Star.** From the PRD, in a sentence or two.
4. **The shape of it.** One diagram of the whole design, with one step per story. It opens on the
   whole diagram, however small that makes it. Zoom in from a step, with `focus`, not before.
5. **Each story, in order.** Head each of its scenes `Story 2 of 5: <topic>` when there are more
   than three stories, and `Story 2: <topic>` otherwise. When the doc groups its stories into
   phases, head it `Phase A: Story 2 of 5: <topic>`, counting the stories within the phase. A story
   brings in what it needs at the point it matters:
   - the data shapes it adds or changes, shown against the existing shape when one exists;
   - the success criteria it serves;
   - the key decisions behind it;
   - its risks.

   Give a story as many scenes as that takes.
6. **Wrap-up.** The whole design once more, and what "done" looks like. End the narration by
   telling the viewer that all the details are in the Architecture doc in Notion, and that they can
   leave comments there.

There are no separate sections for success criteria, decisions, data or risks. Each one appears
inside the story it belongs to.

## Host the script

The user critiques the script as text, before or alongside the video. Once the architecture page is
hosted (`skills/workflow-guide/references/notification-protocol.md` §Phase 1), host the script as a
child page of it.

- **First time:**
  - Create the page with `notion-create-pages`, with `parent: { page_id: "<architecture page id>" }`
    and the title `Walkthrough script — <doc title>`.
  - Add `walkthrough-notion-page-id: <new page id>` to the architecture doc's frontmatter.
- **Afterwards:** update that page in place with `notion-update-page` and `command: "replace_content"`.

The page lists the scenes in order. For each scene it gives:
- the heading;
- what is on screen, in prose. For a diagram, that includes a key from each id to its label.
- the narration;
- the cues, each with what it lights.

## Revisions

When the user's review changes the design:
1. Edit the script wherever the change touches what the video says.
2. Re-render. A scene is voiced again, and charged, only when the cache holds no audio for its text
   in the voice, and the model and speed the CLI pins (for a macOS voice, the scene's cues; for
   Kokoro, the Kokoro version), now in use. Every other scene comes from the cache and costs
   nothing.
3. Re-host the doc and the script page.

A hosted video never contradicts its hosted doc.
