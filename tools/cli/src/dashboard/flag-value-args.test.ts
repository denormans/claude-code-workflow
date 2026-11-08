import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApplication, buildCommand, run } from '@stricli/core'
import { flagValueArgs } from './invoke.ts'

const parseThroughStricli = async (
  args: string[]
): Promise<{ value: string | null; err: string }> => {
  let received: string | null = null
  let err = ''
  const command = buildCommand({
    func: (flags: { val: string }) => {
      received = flags.val
    },
    parameters: { flags: { val: { kind: 'parsed', parse: String, brief: 'value' } } },
    docs: { brief: 'probe' },
  })
  const app = buildApplication(command, { name: 'probe' })
  const sink = { write: (s: string) => void (err += s) }
  await run(app, args, { process: { stdout: sink, stderr: sink } })
  return { value: received, err }
}

const VALUES = [
  '--help',
  '-h',
  '--session',
  '--',
  'a=b',
  'Lede\n\nbody',
  '--help\nmore',
  '',
  'a\rb',
  'a\u2028b',
  'a\u2029b',
  'plain',
]

test('flagValueArgs: a real Stricli parse hands the command exactly the value, for every shape', async () => {
  for (const value of VALUES) {
    const { value: received, err } = await parseThroughStricli([...flagValueArgs('--val', value)])
    assert.equal(received, value, `value ${JSON.stringify(value)} (stderr: ${err})`)
  }
})
