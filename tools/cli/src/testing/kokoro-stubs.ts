import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A stand-in for `uv`, put on PATH by the Kokoro tests. `uv --version` succeeds. The offline probe
// (`-c ""`) succeeds only once `<dir>/uv-cached` exists. A helper run appends what it was asked to
// `<dir>/uv-calls`, writes an empty WAV per scene, and replies with one word per space-separated
// word of the text, a second each. The speakers af_nosuch, af_unfetched, af_broken and af_garbled
// stand in for an unknown speaker (exit 3), one that could not be downloaded (exit 4), a crash
// (exit 1) and a reply that is not JSON.
export const writeKokoroStubs = (dir: string): void => {
  writeFileSync(
    join(dir, 'uv'),
    `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('uv 0.13.1'); process.exit(0) }
if (args.includes('-c')) process.exit(existsSync(${JSON.stringify(join(dir, 'uv-cached'))}) ? 0 : 1)
const request = JSON.parse(readFileSync(0, 'utf8'))
appendFileSync(${JSON.stringify(join(dir, 'uv-calls'))}, JSON.stringify({
  offline: args.includes('--offline'),
  voice: request.voice,
  langCode: request.langCode,
  speed: request.speed,
  texts: request.scenes.map(({ text }) => text),
}) + '\\n')
if (request.voice === 'af_nosuch') process.exit(3)
if (request.voice === 'af_unfetched') process.exit(4)
if (request.voice === 'af_broken') process.exit(1)
if (request.voice === 'af_garbled') { process.stdout.write('not json'); process.exit(0) }
const scenes = request.scenes.map(({ text, wav }) => {
  writeFileSync(wav, '')
  const words = text.split(' ').map((word, i) => ({ text: word, start: i, end: i + 1 }))
  return { duration: words.length, words }
})
process.stdout.write(JSON.stringify({ scenes }))
`
  )
  chmodSync(join(dir, 'uv'), 0o755)
}
