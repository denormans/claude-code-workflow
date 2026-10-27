// Race helper for conversation-node.test.ts: signals READY, blocks until the parent writes GO, then
// posts one question through runItemAdd so several of these hit a session with no node at once.
// HOME, CLAUDE_CODE_SESSION_ID and AI_WORKFLOW_APP_BIN come from the inherited environment.
import { existsSync, writeFileSync } from 'node:fs'

import { getRequestedExitCode } from '../../runtime-exit-code.ts'
import { runItemAdd } from '../item.ts'

const [, , readyPath, goPath] = process.argv

const sleeper = new Int32Array(new SharedArrayBuffer(4))
const goDeadline = Date.now() + 15_000
writeFileSync(readyPath!, '')

while (!existsSync(goPath!)) {
  if (Date.now() >= goDeadline) {
    console.error(`conversation-race-child: timed out waiting for GO at ${goPath}`)
    process.exit(1)
  }
  Atomics.wait(sleeper, 0, 0, 5)
}

runItemAdd('question', `Race ${process.pid}?`, {
  recommend: 'Ship it',
  stalls: 'none',
  whyMine: 'scope',
})
process.exitCode = getRequestedExitCode() ?? 0
