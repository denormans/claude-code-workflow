import { buildCommand, buildRouteMap } from '@stricli/core'
import { runWorkflowHooksList, runWorkflowHooksRun } from '../workflow-hooks/main.ts'

const runCommand = buildCommand({
  docs: {
    brief: 'Run the hook steps configured for one workflow moment',
    fullDescription:
      'Loads the user (<config dir>/workflow-hooks.json), shared project ' +
      '(.claude/workflow-hooks.json) and private project (.claude/workflow-hooks.local.json) hook ' +
      "files — project files from the main checkout — runs the moment's command steps in that " +
      'order with `sh -c`, and prints its instruction steps for the agent to carry out. Prints a ' +
      'JSON result on stdout. Exit 0: every blocking step passed (a non-blocking one may have ' +
      'failed). Exit 1: a hooks file is invalid, or the moment is unknown (whether or not any ' +
      'hooks file exists). Exit 3: a blocking command step failed or timed out, and no later ' +
      'step ran.',
  },
  parameters: {
    flags: {
      moment: { kind: 'parsed', parse: String, brief: 'Moment id, such as cleanup.before' },
      ticket: {
        kind: 'parsed',
        parse: String,
        brief: 'Ticket id, passed to commands as WORKFLOW_TICKET',
        optional: true,
      },
      pr: {
        kind: 'parsed',
        parse: String,
        brief: 'Pull request URL, passed to commands as WORKFLOW_PR_URL',
        optional: true,
      },
      'tests-outcome': {
        kind: 'enum',
        values: ['pass', 'fail'],
        brief: 'Outcome of the gate or test run, for tests.after; passed as WORKFLOW_TESTS_OUTCOME',
        optional: true,
      },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  async func(flags: {
    moment: string
    ticket?: string
    pr?: string
    'tests-outcome'?: 'pass' | 'fail'
  }) {
    await runWorkflowHooksRun({
      moment: flags.moment,
      ticket: flags.ticket,
      pr: flags.pr,
      testsOutcome: flags['tests-outcome'],
    })
  },
})

const listCommand = buildCommand({
  docs: {
    brief: 'List the hook steps that will run at each moment, and where each comes from',
    fullDescription:
      'Read-only. Shows the three hook files and whether each is present, then every step by ' +
      'moment with its source file, kind (run or instruct), whether it blocks, and which project ' +
      'file disabled it. Exit 1 when a hooks file is invalid or --moment is unknown.',
  },
  parameters: {
    flags: {
      moment: {
        kind: 'parsed',
        parse: String,
        brief: 'Only this moment id',
        optional: true,
      },
      json: { kind: 'boolean', brief: 'Print JSON instead of the table' },
    },
    positional: { kind: 'tuple', parameters: [] },
  },
  func(flags: { moment?: string; json: boolean }) {
    runWorkflowHooksList({ moment: flags.moment, json: flags.json })
  },
})

export const workflowHooksRoutes = buildRouteMap({
  routes: {
    run: runCommand,
    list: listCommand,
  },
  docs: { brief: 'Run user and project hook steps at named workflow moments' },
})
