/**
 * grep - Content search tool
 *
 * Features:
 * - Non-shell execution (spawn + args array, prevents command injection)
 * - Source-level limiting (uses -m flag)
 * - Default excludes: node_modules/.git/dist etc.
 * - Consistent output structure (count/truncated/error)
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type { GrepMatch } from '../types/runtime.js'

export interface GrepInput {
  pattern: string
  cwd?: string
  type?: string
  limit?: number
  ignoreCase?: boolean
}

export interface GrepOutput {
  /** Search matches */
  matches: GrepMatch[]
  /** Number of matches */
  count: number
  /** Whether results were truncated */
  truncated: boolean
}

export const grep: Tool<GrepInput, GrepOutput> = defineTool({
  name: 'grep',
  description: `Search for a pattern across MULTIPLE files. Use grep to FIND which files contain a pattern. Do NOT grep a file you already read — you have its content. Auto-excludes node_modules, .git, dist. Results may be truncated.`,
  parameters: {
    pattern: {
      type: 'string',
      description: 'Search pattern (supports regular expressions)',
      required: true
    },
    cwd: {
      type: 'string',
      description: 'Starting directory for search (relative to project root)',
      required: false
    },
    type: {
      type: 'string',
      description: 'File type filter (e.g. ts, js, py)',
      required: false
    },
    limit: {
      type: 'number',
      description: 'Max number of results (default 100, subject to system hard limit)',
      required: false,
      default: 100
    },
    ignoreCase: {
      type: 'boolean',
      description: 'Whether to ignore case',
      required: false,
      default: false
    }
  },
  activity: {
    formatCall: (a) => {
      const pattern = (a.pattern as string) || ''
      return { label: `Grep "${pattern.slice(0, 30)}${pattern.length > 30 ? '...' : ''}"`, icon: 'search' }
    },
    formatResult: (r, a) => {
      const pattern = (a?.pattern as string) || ''
      const matches = (r.data as any)?.matches as unknown[] || (r.data as any)?.results as unknown[] || []
      return { label: `"${pattern.slice(0, 20)}": ${matches.length} matches`, icon: 'search' }
    }
  },
  execute: async (input, { runtime }) => {
    const limit = input.limit ?? 100

    const result = await runtime.io.grep(input.pattern, {
      cwd: input.cwd,
      type: input.type,
      limit,
      ignoreCase: input.ignoreCase
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    const matches = result.data!
    const meta = result.meta ?? {}

    const truncated = meta.truncated ?? false
    const header = truncated
      ? `Found ${matches.length}+ matches for "${input.pattern}" (truncated):`
      : `Found ${matches.length} match${matches.length !== 1 ? 'es' : ''} for "${input.pattern}"${matches.length > 0 ? ':' : ''}`
    const matchLines = matches.map(m => `${m.file}:${m.line}: ${m.text}`)
    const llmSummary = matches.length > 0 ? `${header}\n${matchLines.join('\n')}` : header

    return {
      success: true,
      data: { matches, count: matches.length, truncated },
      llmSummary
    }
  }
})
