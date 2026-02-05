/**
 * write - File writing tool
 *
 * Features:
 * - Atomic writes (temp file + rename)
 * - Permission preservation (inherits original file permissions)
 * - Size limits (prevents memory/disk overflow)
 * - Consistent output structure (count/truncated/error)
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface WriteInput {
  path: string
  content: string
}

export interface WriteOutput {
  /** Written file path */
  path: string
  /** Bytes written */
  bytes: number
  /** Whether the file was newly created */
  created: boolean
}

export const write: Tool<WriteInput, WriteOutput> = defineTool({
  name: 'write',
  description: `Write file contents. Creates if missing, overwrites if exists. Atomic writes with permission preservation.`,
  parameters: {
    path: {
      type: 'string',
      description: 'File path (relative to project root)',
      required: true
    },
    content: {
      type: 'string',
      description: 'Content to write',
      required: true
    }
  },
  activity: {
    formatCall: (a) => {
      const file = (a.path as string)?.split('/').pop() || ''
      return { label: `Write ${file}`, icon: 'file' }
    },
    formatResult: (r, a) => {
      const file = ((r.data as any)?.path as string || (a?.path as string) || '').split('/').pop() || ''
      return { label: `Wrote ${file}`, icon: 'file' }
    }
  },
  execute: async (input, { runtime }) => {
    // Check if file already exists
    const existsResult = await runtime.io.exists(input.path)
    const existed = existsResult.success && existsResult.data === true

    const result = await runtime.io.writeFile(input.path, input.content)

    if (!result.success) {
      return {
        success: false,
        error: result.error
      }
    }

    // Bump file revision for read-dup guard (per-run)
    const guard = runtime.sessionState.get<{ fileRevisions: Map<string, number> }>('ioGuard')
    if (guard?.fileRevisions) {
      const current = guard.fileRevisions.get(input.path) ?? 0
      guard.fileRevisions.set(input.path, current + 1)
    }

    return {
      success: true,
      data: {
        path: input.path,
        bytes: input.content.length,
        created: !existed
      }
    }
  }
})
