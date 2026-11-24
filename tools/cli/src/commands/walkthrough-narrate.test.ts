import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getRequestedExitCode, setRequestedExitCode } from '../runtime-exit-code.ts'
import { stderrBeyondNodeWarnings } from '../testing/subprocess-stderr.ts'
import { ownerProblem, runWalkthroughNarrate } from '../walkthrough/narrate.ts'
import { VOICES } from '../walkthrough/voices.ts'
import { writeKokoroStubs } from '../testing/kokoro-stubs.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

const NARRATION = 'Hello there. Goodbye now.'

const alignment = {
  characters: [...NARRATION],
  character_start_times_seconds: [...NARRATION].map((_, i) => i * 0.1),
  character_end_times_seconds: [...NARRATION].map((_, i) => (i + 1) * 0.1),
}

interface Fixture {
  dir: string
  script: string
  outDir: string
  apiBase: string
  requests: string[]
  stdout: string[]
  stderr: ReturnType<typeof mock.method>
}

const withFixture = async (
  scenes: unknown[],
  run: (fixture: Fixture) => Promise<void>
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-narrate-test-'))
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      req.method === 'GET'
        ? '{}'
        : JSON.stringify({ audio_base64: Buffer.from('mp3').toString('base64'), alignment })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const script = join(dir, 's.json')
  writeFileSync(script, JSON.stringify({ scenes }))
  const stderr = mock.method(console, 'error', () => undefined)
  setRequestedExitCode(0)
  try {
    await run({
      dir,
      script,
      outDir: join(dir, 'out'),
      apiBase: `http://127.0.0.1:${port}`,
      requests,
      stdout: [],
      stderr,
    })
  } finally {
    stderr.mock.restore()
    setRequestedExitCode(0)
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const goodScenes = [{ id: 'intro', narration: NARRATION, cues: ['Hello', 'Goodbye'] }]

test('walkthrough narrate: voices each scene to <id>.mp3 and reports durations and cue times', async () => {
  await withFixture(goodScenes, async (f) => {
    await runWalkthroughNarrate(f.script, f.outDir, {
      env: { ELEVEN_LABS_API_KEY: 'k' },
      apiBase: f.apiBase,
      stdout: (chunk) => f.stdout.push(chunk),
    })
    const audio = join(f.outDir, 'intro.mp3')
    assert.equal(readFileSync(audio, 'utf-8'), 'mp3')
    assert.deepEqual(JSON.parse(f.stdout.join('')), {
      narrated: true,
      voice: 'elevenlabs',
      scenes: [
        {
          id: 'intro',
          audioFile: audio,
          durationSeconds: alignment.character_end_times_seconds.at(-1),
          cues: [
            { cue: 'Hello', atSeconds: 0 },
            { cue: 'Goodbye', atSeconds: alignment.character_start_times_seconds[13] },
          ],
        },
      ],
    })
    assert.equal(getRequestedExitCode(), 0)
    assert.deepEqual(f.stderr.mock.calls, [])
  })
})

test('walkthrough narrate: a second run makes no ElevenLabs request', async () => {
  await withFixture(goodScenes, async (f) => {
    const runs: string[] = []
    const options = {
      env: { ELEVEN_LABS_API_KEY: 'k' },
      apiBase: f.apiBase,
      stdout: (chunk: string) => runs.push(chunk),
    }
    await runWalkthroughNarrate(f.script, f.outDir, options)
    const afterFirst = f.requests.length
    assert.ok(afterFirst > 0)
    await runWalkthroughNarrate(f.script, f.outDir, options)
    assert.equal(f.requests.length, afterFirst)
    assert.equal(runs.length, 2)
    assert.equal(runs[1], runs[0])
  })
})

test('walkthrough narrate: with no voice configured it reports reading time and writes no audio', async () => {
  await withFixture(goodScenes, async (f) => {
    await runWalkthroughNarrate(f.script, f.outDir, {
      env: {},
      stdout: (chunk) => f.stdout.push(chunk),
    })
    // 15 characters a second, and 0.4 seconds after the first sentence: "Goodbye" starts at
    // character 13, and the 25 characters end at 25 / 15 + 0.4.
    const output = JSON.parse(f.stdout.join(''))
    const [scene] = output.scenes
    assert.equal(Number(scene.durationSeconds.toFixed(3)), 2.067)
    assert.equal(Number(scene.cues[1].atSeconds.toFixed(3)), 1.267)
    assert.deepEqual(output, {
      narrated: false,
      voice: null,
      scenes: [
        {
          id: 'intro',
          audioFile: null,
          durationSeconds: scene.durationSeconds,
          cues: [
            { cue: 'Hello', atSeconds: 0 },
            { cue: 'Goodbye', atSeconds: scene.cues[1].atSeconds },
          ],
        },
      ],
    })
    assert.equal(existsSync(f.outDir), false)
    assert.equal(getRequestedExitCode(), 0)
    assert.deepEqual(
      f.stderr.mock.calls.map((call) => call.arguments),
      [
        [
          'walkthrough: none of ELEVEN_LABS_API_KEY, WALKTHROUGH_MAC_VOICE or ' +
            'WALKTHROUGH_KOKORO_VOICE is set, so no scene is voiced and every audioFile is null.',
        ],
      ]
    )
  })
})

test('walkthrough narrate: an invalid script exits 1 with no ElevenLabs request', async () => {
  const invalid = [
    {
      scenes: [{ id: 'a', narration: NARRATION, cues: ['Absent'] }],
      problem: 'scenes[0].cues: "Absent" is not in the narration after the cue before it',
    },
    {
      scenes: [goodScenes[0], goodScenes[0]],
      problem: 'scenes[1].id: "intro" is used by an earlier scene',
    },
    {
      scenes: [goodScenes[0], { ...goodScenes[0], id: 'Intro' }],
      problem: 'scenes[1].id: "Intro" differs only by case from "intro"',
    },
    {
      scenes: [{ id: 'a/b', narration: NARRATION }],
      problem:
        'scenes[0].id: expected letters, digits and hyphens, starting with a letter or digit',
    },
  ]
  for (const { scenes, problem } of invalid) {
    await withFixture(scenes, async (f) => {
      await runWalkthroughNarrate(f.script, f.outDir, {
        env: { ELEVEN_LABS_API_KEY: 'k' },
        apiBase: f.apiBase,
        stdout: (chunk) => f.stdout.push(chunk),
      })
      assert.equal(getRequestedExitCode(), 1)
      assert.deepEqual(f.requests, [])
      assert.deepEqual(f.stdout, [])
      assert.equal(existsSync(f.outDir), false)
      assert.deepEqual(
        f.stderr.mock.calls.map((call) => call.arguments),
        [[`${f.script}: ${problem}`]]
      )
    })
  }
})

test('walkthrough narrate: an uninstalled macOS voice exits 1 before voicing', async () => {
  await withFixture(goodScenes, async (f) => {
    writeFileSync(
      join(f.dir, 'say'),
      `#!/bin/sh
[ "$2" = '?' ] && { printf '%s\\n' 'Tester              en_US    # Hello! My name is Tester.'; exit 0; }
echo call >> "${f.dir}/say-calls"
exit 0
`
    )
    writeFileSync(join(f.dir, 'ffprobe'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(f.dir, 'say'), 0o755)
    chmodSync(join(f.dir, 'ffprobe'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${f.dir}:${path ?? ''}`
    try {
      await runWalkthroughNarrate(f.script, f.outDir, {
        env: { WALKTHROUGH_MAC_VOICE: 'Nobody' },
        stdout: (chunk) => f.stdout.push(chunk),
      })
    } finally {
      process.env.PATH = path
    }
    assert.equal(getRequestedExitCode(), 1)
    assert.deepEqual(
      f.stderr.mock.calls.map((call) => call.arguments),
      [
        [
          'walkthrough: WALKTHROUGH_MAC_VOICE names "Nobody", which is not an installed voice; ' +
            "say -v '?' lists them.",
        ],
      ]
    )
    assert.deepEqual(f.stdout, [])
    assert.equal(existsSync(join(f.dir, 'say-calls')), false)
  })
})

test('walkthrough narrate: a Kokoro voice without ffmpeg exits 2 before voicing, a macOS voice runs without it', async () => {
  await withFixture(goodScenes, async (f) => {
    // PATH holds only these stand-ins, so there is no ffmpeg; they call tools by absolute path.
    writeFileSync(
      join(f.dir, 'say'),
      `#!/bin/sh
[ "$2" = '?' ] && { printf '%s\\n' 'Tester              en_US    # Hello! My name is Tester.'; exit 0; }
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
/bin/cat > "$out"
`
    )
    writeFileSync(
      join(f.dir, 'ffprobe'),
      '#!/bin/sh\n[ "$1" = -version ] && exit 0\nfor last; do :; done\n/usr/bin/wc -c < "$last" | /usr/bin/tr -d \' \'\n'
    )
    chmodSync(join(f.dir, 'say'), 0o755)
    chmodSync(join(f.dir, 'ffprobe'), 0o755)
    const path = process.env.PATH
    process.env.PATH = f.dir
    try {
      await runWalkthroughNarrate(f.script, f.outDir, {
        env: { WALKTHROUGH_KOKORO_VOICE: 'af_heart' },
        stdout: (chunk) => f.stdout.push(chunk),
      })
      assert.equal(getRequestedExitCode(), 2)
      assert.deepEqual(
        f.stderr.mock.calls.map((call) => call.arguments),
        [['walkthrough: ffmpeg is not on PATH; install it (brew install ffmpeg).']]
      )
      assert.deepEqual(f.stdout, [])
      assert.equal(existsSync(f.outDir), false)

      setRequestedExitCode(0)
      f.stderr.mock.resetCalls()
      await runWalkthroughNarrate(f.script, f.outDir, {
        env: { WALKTHROUGH_MAC_VOICE: 'Tester' },
        stdout: (chunk) => f.stdout.push(chunk),
      })
    } finally {
      process.env.PATH = path
    }
    assert.equal(getRequestedExitCode(), 0)
    assert.deepEqual(f.stderr.mock.calls, [])
    assert.equal(JSON.parse(f.stdout.join('')).voice, 'mac')
    assert.equal(readFileSync(join(f.outDir, 'intro.m4a'), 'utf-8'), NARRATION)
  })
})

test('walkthrough narrate: an out dir that is a regular file exits 1 before any scene is voiced', async () => {
  await withFixture(goodScenes, async (f) => {
    writeFileSync(
      join(f.dir, 'say'),
      `#!/bin/sh
[ "$2" = '?' ] && { printf '%s\\n' 'Tester              en_US    # Hello! My name is Tester.'; exit 0; }
echo call >> "${f.dir}/say-calls"
exit 0
`
    )
    writeFileSync(join(f.dir, 'ffprobe'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(f.dir, 'say'), 0o755)
    chmodSync(join(f.dir, 'ffprobe'), 0o755)
    writeFileSync(f.outDir, 'not a directory')
    const path = process.env.PATH
    process.env.PATH = `${f.dir}:${path ?? ''}`
    try {
      await runWalkthroughNarrate(f.script, f.outDir, {
        env: { WALKTHROUGH_MAC_VOICE: 'Tester' },
        stdout: (chunk) => f.stdout.push(chunk),
      })
    } finally {
      process.env.PATH = path
    }
    assert.equal(getRequestedExitCode(), 1)
    assert.deepEqual(
      f.stderr.mock.calls.map((call) => call.arguments),
      [
        [
          `walkthrough: ${f.outDir} cannot be used as the out dir: ` +
            `EEXIST: file already exists, mkdir '${f.outDir}'`,
        ],
      ]
    )
    assert.deepEqual(f.stdout, [])
    assert.equal(existsSync(join(f.dir, 'say-calls')), false)
    assert.equal(readFileSync(f.outDir, 'utf-8'), 'not a directory')
  })
})

interface VoiceCase {
  name: 'elevenlabs' | 'mac' | 'kokoro'
  env: NodeJS.ProcessEnv
  audioExtension: '.mp3' | '.m4a'
  ran: (f: Fixture) => boolean
}

const voiceCases: VoiceCase[] = [
  {
    name: 'elevenlabs',
    env: { ELEVEN_LABS_API_KEY: 'k' },
    audioExtension: '.mp3',
    ran: (f) => f.requests.length > 0,
  },
  {
    name: 'mac',
    env: { WALKTHROUGH_MAC_VOICE: 'Tester' },
    audioExtension: '.m4a',
    ran: (f) => existsSync(join(f.dir, 'say-calls')),
  },
  {
    name: 'kokoro',
    env: { WALKTHROUGH_KOKORO_VOICE: 'af_heart' },
    audioExtension: '.m4a',
    ran: (f) => existsSync(join(f.dir, 'uv-calls')),
  },
]

// Stand-ins for every tool a voice runs. `say` copies its narration to its output file and logs
// each call to <dir>/say-calls, `ffprobe` reports one second per byte, `ffmpeg` writes an empty
// output file, and `uv` is the Kokoro stand-in that logs to <dir>/uv-calls.
const writeVoiceStubs = (dir: string): void => {
  writeFileSync(
    join(dir, 'say'),
    `#!/bin/sh
[ "$2" = '?' ] && { printf '%s\\n' 'Tester              en_US    # Hello! My name is Tester.'; exit 0; }
echo call >> "${dir}/say-calls"
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
/bin/cat > "$out"
`
  )
  writeFileSync(
    join(dir, 'ffprobe'),
    '#!/bin/sh\n[ "$1" = -version ] && exit 0\nfor last; do :; done\n/usr/bin/wc -c < "$last" | /usr/bin/tr -d \' \'\n'
  )
  writeFileSync(
    join(dir, 'ffmpeg'),
    '#!/bin/sh\n[ "$1" = -version ] && exit 0\nfor last; do :; done\n: > "$last"\n'
  )
  writeKokoroStubs(dir)
  writeFileSync(join(dir, 'uv-cached'), '')
  for (const stub of ['say', 'ffprobe', 'ffmpeg']) {
    chmodSync(join(dir, stub), 0o755)
  }
}

const withStubsOnPath = async (dir: string, run: () => Promise<void>): Promise<void> => {
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  try {
    await run()
  } finally {
    process.env.PATH = path
  }
}

test('walkthrough narrate: a cache dir that is a regular file exits 1 before any scene is voiced, for every voice', async () => {
  for (const voice of voiceCases) {
    await withFixture(goodScenes, async (f) => {
      writeVoiceStubs(f.dir)
      const cacheDir = join(f.dir, 's.cache')
      writeFileSync(cacheDir, 'not a directory')

      await withStubsOnPath(f.dir, async () => {
        await runWalkthroughNarrate(f.script, f.outDir, {
          env: voice.env,
          apiBase: f.apiBase,
          stdout: (chunk) => f.stdout.push(chunk),
        })
      })

      assert.equal(getRequestedExitCode(), 1, voice.name)
      assert.deepEqual(
        f.stderr.mock.calls.map((call) => call.arguments),
        [
          [
            `walkthrough: ${cacheDir} cannot be used as the cache dir: ` +
              `EEXIST: file already exists, mkdir '${cacheDir}'`,
          ],
        ],
        voice.name
      )
      assert.deepEqual(f.stdout, [], voice.name)
      assert.equal(voice.ran(f), false, voice.name)
      assert.equal(readFileSync(cacheDir, 'utf-8'), 'not a directory')

      setRequestedExitCode(0)
      await runWalkthroughNarrate(f.script, f.outDir, {
        env: {},
        stdout: (chunk) => f.stdout.push(chunk),
      })
      assert.equal(getRequestedExitCode(), 0)
      assert.equal(JSON.parse(f.stdout.join('')).narrated, false)
    })
  }
})

test(
  'walkthrough narrate: a fully cached run needs no writable cache dir, a scene to voice does',
  { skip: process.getuid?.() === 0 && 'root ignores directory mode bits' },
  async () => {
    await withFixture(goodScenes, async (f) => {
      const cacheDir = join(f.dir, 's.cache')
      const runs: string[] = []
      const options = {
        env: { ELEVEN_LABS_API_KEY: 'k' },
        apiBase: f.apiBase,
        stdout: (chunk: string) => runs.push(chunk),
      }
      await runWalkthroughNarrate(f.script, f.outDir, options)
      const afterFirst = f.requests.length
      assert.ok(afterFirst > 0)
      assert.deepEqual(
        [...readdirSync(f.outDir), ...readdirSync(cacheDir)].filter((name) => name.startsWith('.')),
        []
      )

      chmodSync(cacheDir, 0o555)
      try {
        await runWalkthroughNarrate(f.script, f.outDir, options)
        assert.equal(getRequestedExitCode(), 0)
        assert.equal(f.requests.length, afterFirst)
        assert.equal(runs.length, 2)
        assert.equal(runs[1], runs[0])
        assert.equal(f.stderr.mock.calls.length, 0)

        writeFileSync(
          f.script,
          JSON.stringify({
            scenes: [...goodScenes, { id: 'extra', narration: 'Another scene.', cues: [] }],
          })
        )
        await runWalkthroughNarrate(f.script, f.outDir, options)
      } finally {
        chmodSync(cacheDir, 0o755)
      }

      assert.equal(getRequestedExitCode(), 1)
      assert.equal(f.requests.length, afterFirst)
      assert.equal(runs.length, 2)
      assert.deepEqual(
        f.stderr.mock.calls.map((call) => call.arguments),
        [
          [
            `walkthrough: ${cacheDir} cannot be used as the cache dir: ` +
              `EACCES: cannot create files in '${cacheDir}'`,
          ],
        ]
      )
    })
  }
)

test(
  'walkthrough narrate: a dir that cannot take new files exits 1 before any scene is voiced',
  { skip: process.getuid?.() === 0 && 'root ignores directory mode bits' },
  async () => {
    for (const role of ['out dir', 'cache dir'] as const) {
      await withFixture(goodScenes, async (f) => {
        writeVoiceStubs(f.dir)
        const dir = role === 'out dir' ? f.outDir : join(f.dir, 's.cache')
        mkdirSync(dir)
        chmodSync(dir, 0o600)

        try {
          await withStubsOnPath(f.dir, async () => {
            await runWalkthroughNarrate(f.script, f.outDir, {
              env: { WALKTHROUGH_MAC_VOICE: 'Tester' },
              stdout: (chunk) => f.stdout.push(chunk),
            })
          })
        } finally {
          chmodSync(dir, 0o755)
        }

        assert.equal(getRequestedExitCode(), 1, role)
        assert.deepEqual(
          f.stderr.mock.calls.map((call) => call.arguments),
          [
            [
              `walkthrough: ${dir} cannot be used as the ${role}: EACCES: cannot create files in '${dir}'`,
            ],
          ],
          role
        )
        assert.deepEqual(f.stdout, [], role)
        assert.equal(existsSync(join(f.dir, 'say-calls')), false, role)
        assert.deepEqual(readdirSync(dir), [], role)
      })
    }
  }
)

test('walkthrough narrate: a directory where a scene audio goes exits 1 before any scene is voiced, for every voice', async () => {
  for (const voice of voiceCases) {
    await withFixture(goodScenes, async (f) => {
      writeVoiceStubs(f.dir)
      const destination = join(f.outDir, `intro${voice.audioExtension}`)
      mkdirSync(destination, { recursive: true })

      await withStubsOnPath(f.dir, async () => {
        await runWalkthroughNarrate(f.script, f.outDir, {
          env: voice.env,
          apiBase: f.apiBase,
          stdout: (chunk) => f.stdout.push(chunk),
        })
      })

      assert.equal(getRequestedExitCode(), 1, voice.name)
      assert.deepEqual(
        f.stderr.mock.calls.map((call) => call.arguments),
        [[`walkthrough: ${destination} cannot be written: it is not a regular file`]],
        voice.name
      )
      assert.deepEqual(f.stdout, [], voice.name)
      assert.equal(voice.ran(f), false, voice.name)
    })
  }
})

test('walkthrough narrate: existing writable audio is overwritten, and a failed check leaves it untouched', async () => {
  const scenes = [
    { id: 'first', narration: 'First scene.', cues: [] },
    { id: 'second', narration: 'Second scene.', cues: [] },
  ]
  await withFixture(scenes, async (f) => {
    writeVoiceStubs(f.dir)
    const env = { WALKTHROUGH_MAC_VOICE: 'Tester' }
    const first = join(f.outDir, 'first.m4a')
    const second = join(f.outDir, 'second.m4a')
    mkdirSync(f.outDir, { recursive: true })
    writeFileSync(first, 'old audio')

    await withStubsOnPath(f.dir, async () => {
      await runWalkthroughNarrate(f.script, f.outDir, {
        env,
        stdout: (chunk) => f.stdout.push(chunk),
      })
    })
    assert.equal(getRequestedExitCode(), 0)
    assert.equal(readFileSync(first, 'utf-8'), 'First scene.')
    assert.equal(readFileSync(second, 'utf-8'), 'Second scene.')

    rmSync(second)
    mkdirSync(second)
    writeFileSync(first, 'old audio')
    rmSync(join(f.dir, 'say-calls'))
    rmSync(join(f.dir, 's.cache'), { recursive: true })
    setRequestedExitCode(0)

    await withStubsOnPath(f.dir, async () => {
      await runWalkthroughNarrate(f.script, f.outDir, {
        env,
        stdout: (chunk) => f.stdout.push(chunk),
      })
    })
    assert.equal(getRequestedExitCode(), 1)
    assert.equal(readFileSync(first, 'utf-8'), 'old audio')
    assert.equal(existsSync(join(f.dir, 'say-calls')), false)
  })
})

const twoScenes = [
  { id: 'first', narration: 'First scene.', cues: [] },
  { id: 'second', narration: 'Second scene.', cues: [] },
]

const runWithMacVoice = async (f: Fixture): Promise<void> => {
  await withStubsOnPath(f.dir, async () => {
    await runWalkthroughNarrate(f.script, f.outDir, {
      env: { WALKTHROUGH_MAC_VOICE: 'Tester' },
      stdout: (chunk) => f.stdout.push(chunk),
    })
  })
}

test(
  'walkthrough narrate: an existing file only the owner can write is overwritten, a read-only one exits 1 before voicing',
  { skip: process.getuid?.() === 0 && 'root ignores file mode bits' },
  async () => {
    await withFixture(twoScenes, async (f) => {
      writeVoiceStubs(f.dir)
      const first = join(f.outDir, 'first.m4a')
      const second = join(f.outDir, 'second.m4a')
      mkdirSync(f.outDir, { recursive: true })
      writeFileSync(first, 'old audio', { mode: 0o200 })
      chmodSync(first, 0o200)

      await runWithMacVoice(f)
      assert.equal(getRequestedExitCode(), 0)
      chmodSync(first, 0o644)
      assert.equal(readFileSync(first, 'utf-8'), 'First scene.')

      writeFileSync(first, 'old audio')
      chmodSync(first, 0o200)
      writeFileSync(second, 'old audio')
      chmodSync(second, 0o400)
      rmSync(join(f.dir, 's.cache'), { recursive: true })
      rmSync(join(f.dir, 'say-calls'))
      setRequestedExitCode(0)
      f.stdout.length = 0
      f.stderr.mock.resetCalls()

      await runWithMacVoice(f)
      chmodSync(first, 0o644)
      assert.equal(getRequestedExitCode(), 1)
      assert.deepEqual(
        f.stderr.mock.calls.map((call) => call.arguments),
        [[`walkthrough: ${second} cannot be written: EACCES: permission denied, open '${second}'`]]
      )
      assert.deepEqual(f.stdout, [])
      assert.equal(existsSync(join(f.dir, 'say-calls')), false)
      assert.equal(readFileSync(first, 'utf-8'), 'old audio')
      assert.equal(readFileSync(second, 'utf-8'), 'old audio')
    })
  }
)

test('a scene destination that is not a regular file exits 1 without being opened, through the CLI', () => {
  const shapes: Record<string, (dir: string, dest: string) => void> = {
    fifo: (_dir, dest) => mkfifo(dest),
    'link to a fifo': (dir, dest) => {
      mkfifo(join(dir, 'pipe'))
      symlinkSync(join(dir, 'pipe'), dest)
    },
    'link to a directory': (dir, dest) => {
      mkdirSync(join(dir, 'folder'))
      symlinkSync(join(dir, 'folder'), dest)
    },
  }

  for (const [shape, make] of Object.entries(shapes)) {
    const dir = mkdtempSync(join(tmpdir(), 'walkthrough-narrate-kind-test-'))

    try {
      writeVoiceStubs(dir)
      const outDir = join(dir, 'out')
      const dest = join(outDir, 'one.m4a')
      mkdirSync(outDir)
      make(dir, dest)
      writeFileSync(
        join(dir, 's.json'),
        JSON.stringify({ scenes: [{ id: 'one', narration: 'Hello there.' }] })
      )
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        WALKTHROUGH_MAC_VOICE: 'Tester',
      }
      delete env.ELEVEN_LABS_API_KEY
      delete env.WALKTHROUGH_KOKORO_VOICE

      const result = spawnSync(
        process.execPath,
        [
          '--experimental-transform-types',
          mainTsPath,
          'walkthrough',
          'narrate',
          '--script',
          join(dir, 's.json'),
          '--out-dir',
          outDir,
        ],
        { encoding: 'utf8', timeout: 20_000, env }
      )

      assert.equal(result.status, 1, shape)
      assert.equal(result.stdout, '', shape)
      assert.equal(
        stderrBeyondNodeWarnings(result.stderr),
        `walkthrough: ${dest} cannot be written: it is not a regular file`,
        shape
      )
      assert.equal(existsSync(join(dir, 'say-calls')), false, shape)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('ownerProblem refuses a file another user owns, except for root, and where there is no uid', () => {
  assert.equal(ownerProblem(1000, 1000), undefined)
  assert.equal(ownerProblem(0, 1000), 'it is owned by another user')
  assert.equal(ownerProblem(1000, 1001), 'it is owned by another user')
  assert.equal(ownerProblem(1000, 0), undefined)
  assert.equal(ownerProblem(1000, undefined), undefined)
})

const mkfifo = (path: string): void => {
  assert.equal(spawnSync('mkfifo', [path]).status, 0)
}

test('a broken symbolic link at a scene destination exits 1 before voicing, and a link to a writable file is written through', async () => {
  const oneScene = goodScenes.map((scene) => ({ ...scene, id: 'one' }))
  const shapes: Record<string, (f: Fixture, dest: string) => string> = {
    direct: (f, dest) => {
      const target = join(f.dir, 'missing', 'x.m4a')
      symlinkSync(target, dest)
      return target
    },
    'link to a broken link': (f, dest) => {
      const target = join(f.dir, 'missing', 'x.m4a')
      symlinkSync(target, join(f.dir, 'hop'))
      symlinkSync(join(f.dir, 'hop'), dest)
      return target
    },
    'target whose parent exists': (f, dest) => {
      const target = join(f.dir, 'present', 'x.m4a')
      mkdirSync(join(f.dir, 'present'))
      symlinkSync(target, dest)
      return target
    },
    'dot-dot after a link': (f, dest) => {
      const target = join(f.dir, 'sib', 'x.m4a')
      mkdirSync(join(f.dir, 'real', 'deep'), { recursive: true })
      mkdirSync(join(f.dir, 'sib'))
      mkdirSync(join(f.dir, 'real', 'sib'))
      symlinkSync(join(f.dir, 'real', 'deep'), join(f.dir, 'lnk'))
      symlinkSync(join(f.dir, 'lnk', '..', 'sib', 'x.m4a'), dest)
      return target
    },
  }

  for (const [shape, make] of Object.entries(shapes)) {
    await withFixture(oneScene, async (f) => {
      writeVoiceStubs(f.dir)
      const dest = join(f.outDir, 'one.m4a')
      mkdirSync(f.outDir, { recursive: true })
      const target = make(f, dest)

      await runWithMacVoice(f)

      assert.equal(getRequestedExitCode(), 1, shape)
      assert.deepEqual(
        f.stderr.mock.calls.map((call) => call.arguments),
        [[`walkthrough: ${dest} cannot be written: it is a broken symbolic link`]],
        shape
      )
      assert.deepEqual(f.stdout, [], shape)
      assert.equal(existsSync(join(f.dir, 'say-calls')), false, shape)
      assert.equal(existsSync(target), false, shape)
      assert.equal(existsSync(join(f.dir, 'real', 'sib', 'x.m4a')), false, shape)
    })
  }

  await withFixture(oneScene, async (f) => {
    writeVoiceStubs(f.dir)
    const elsewhere = join(f.dir, 'elsewhere.m4a')
    mkdirSync(f.outDir, { recursive: true })
    writeFileSync(elsewhere, 'old audio')
    symlinkSync(elsewhere, join(f.outDir, 'one.m4a'))

    await runWithMacVoice(f)

    assert.equal(getRequestedExitCode(), 0)
    assert.equal(readFileSync(elsewhere, 'utf-8'), NARRATION)
  })
})

test('voices: isCached reports a hit only for the scene the voice has cached, and writes nothing', async () => {
  for (const voice of voiceCases) {
    await withFixture(goodScenes, async (f) => {
      writeVoiceStubs(f.dir)
      const entry = VOICES.find(({ name }) => name === voice.name)
      const probe = entry?.fromEnv({ env: voice.env, apiBase: f.apiBase })
      assert.ok(probe !== undefined, voice.name)
      const cacheDir = join(f.dir, 'probe.cache')
      const scene = { narration: 'Hello there.', cues: ['Hello'] }

      await withStubsOnPath(f.dir, async () => {
        assert.equal(probe.isCached(scene, cacheDir), false, voice.name)
        assert.equal(existsSync(cacheDir), false, voice.name)

        await probe.narrate([scene], cacheDir)
        assert.equal(probe.isCached(scene, cacheDir), true, voice.name)
        assert.equal(
          probe.isCached({ narration: 'Other words.', cues: ['Other'] }, cacheDir),
          false
        )
        // Only a macOS voice keys its cache by the cues.
        assert.equal(
          probe.isCached({ narration: 'Hello there.', cues: [] }, cacheDir),
          voice.name !== 'mac',
          voice.name
        )
      })
    })
  }
})

test('walkthrough narrate: a failure after voicing exits 1 with one message and no summary', async () => {
  const unaligned = [{ id: 'x', narration: 'Zzzz zzzz.', cues: ['Zzzz'] }]
  await withFixture(unaligned, async (f) => {
    await runWalkthroughNarrate(f.script, f.outDir, {
      env: { ELEVEN_LABS_API_KEY: 'k' },
      apiBase: f.apiBase,
      stdout: (chunk) => f.stdout.push(chunk),
    })
    assert.equal(getRequestedExitCode(), 1)
    assert.deepEqual(
      f.stderr.mock.calls.map((call) => call.arguments),
      [[`walkthrough: scene x's cue "Zzzz" is not in the voice's alignment`]]
    )
    assert.deepEqual(f.stdout, [])
  })
})

test('CLI: walkthrough narrate --out-dir writes each scene to <id>.m4a and prints the summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-narrate-cli-test-'))
  try {
    // The say stand-in copies the narration it is given to its output file; the ffprobe stand-in
    // reports one second per byte.
    writeFileSync(
      join(dir, 'say'),
      `#!/bin/sh
[ "$2" = '?' ] && { printf '%s\\n' 'Tester              en_US    # Hello! My name is Tester.'; exit 0; }
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
cat > "$out"
`
    )
    writeFileSync(
      join(dir, 'ffprobe'),
      '#!/bin/sh\n[ "$1" = -version ] && exit 0\nfor last; do :; done\nwc -c < "$last" | tr -d \' \'\n'
    )
    chmodSync(join(dir, 'say'), 0o755)
    chmodSync(join(dir, 'ffprobe'), 0o755)
    writeFileSync(
      join(dir, 's.json'),
      JSON.stringify({ scenes: [{ id: 'one', narration: 'Hello there.' }] })
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      WALKTHROUGH_MAC_VOICE: 'Tester',
    }
    delete env.ELEVEN_LABS_API_KEY
    delete env.WALKTHROUGH_KOKORO_VOICE

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-transform-types',
        mainTsPath,
        'walkthrough',
        'narrate',
        '--script',
        join(dir, 's.json'),
        '--out-dir',
        join(dir, 'out'),
      ],
      { encoding: 'utf8', timeout: 60_000, env }
    )

    assert.equal(result.status, 0)
    assert.equal(stderrBeyondNodeWarnings(result.stderr), '')
    assert.equal(
      result.stdout,
      JSON.stringify({
        narrated: true,
        voice: 'mac',
        scenes: [
          { id: 'one', audioFile: join(dir, 'out', 'one.m4a'), durationSeconds: 12, cues: [] },
        ],
      }) + '\n'
    )
    assert.equal(readFileSync(join(dir, 'out', 'one.m4a'), 'utf-8'), 'Hello there.')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
