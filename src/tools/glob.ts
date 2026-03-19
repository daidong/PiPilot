/**
 * glob - File matching tool
 *
 * Features:
 * - Hard limit on maxResults
 * - Auto-merges default ignore patterns
 * - Consistent output structure (count/truncated/error)
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface GlobInput {
  pattern: string
  cwd?: string
  ignore?: string[]
}

export interface GlobOutput {
  /** List of matched files */
  files: string[]
  /** Number of matches */
  count: number
  /** Whether results were truncated */
  truncated: boolean
  /** Total matches (before truncation) */
  total?: number
}

export const glob: Tool<GlobInput, GlobOutput> = defineTool({
  name: 'glob',
  description: `Match files using glob patterns (e.g. "**/*.ts"). Auto-ignores node_modules, .git, dist, etc.`,
  parameters: {
    pattern: {
      type: 'string',
      description: 'Glob pattern (e.g. **/*.ts)',
      required: true
    },
    cwd: {
      type: 'string',
      description: 'Starting directory for search (relative to project root)',
      required: false
    },
    ignore: {
      type: 'array',
      description: 'Additional ignore patterns (merged with default ignores)',
      required: false,
      items: { type: 'string' }
    }
  },
  activity: {
    formatCall: (a) => ({ label: `Glob ${(a.pattern as string) || ''}`, icon: 'search' }),
    formatResult: (r, a) => {
      const pattern = (a?.pattern as string) || ''
      const files = (r.data as any)?.files as string[] || (r.data as any)?.matches as string[] || []
      return { label: `${pattern}: ${files.length} files`, icon: 'search' }
    }
  },
  execute: async (input, { runtime }) => {
    const result = await runtime.io.glob(input.pattern, {
      cwd: input.cwd,
      ignore: input.ignore
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    const files = result.data!
    const meta = result.meta ?? {}

    const truncated = meta.truncated ?? false
    const total = meta.total
    const header = truncated
      ? `Found ${total ?? files.length}+ files matching "${input.pattern}" (showing ${files.length}):`
      : `Found ${files.length} file${files.length !== 1 ? 's' : ''} matching "${input.pattern}"${files.length > 0 ? ':' : ''}`
    const llmSummary = files.length > 0 ? `${header}\n${files.join('\n')}` : header

    return {
      success: true,
      data: { files, count: files.length, truncated, total },
      llmSummary
    }
  }
})
