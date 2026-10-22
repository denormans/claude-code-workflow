import { VOICES } from '../walkthrough/voices.ts'
import type { ToolSpec } from './types.ts'

export const TOOL_SPECS: Readonly<Record<string, ToolSpec>> = {
  jira: {
    tool: 'jira',
    use: 'Jira MCP tools',
    onFailure:
      'STOP and tell the user Jira was configured/intended but the Jira MCP tools are not working. Do NOT fall back.',
    acceptsAnyPrefix: ['JIRA_', 'ATLASSIAN_'],
  },
  notion: {
    tool: 'notion',
    use: 'Notion MCP tools',
    onFailure:
      'STOP and tell the user Notion is configured but the Notion MCP tools are not working. Do NOT fall back.',
    requiresAll: ['NOTION_PAGE_URL'],
  },
  // One spec per walkthrough voice, so check-tools and walkthrough render name the same variables.
  ...Object.fromEntries(
    VOICES.map(({ tool, use, onFailure, variable }) => [
      tool,
      { tool, use, onFailure, requiresAll: [variable] },
    ])
  ),
}
