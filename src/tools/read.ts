/**
 * read - File reading tool
 *
 * Features:
 * - Streams large files
 * - Hard limits on maxBytes/maxLines
 * - Consistent output structure (count/truncated/error)
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface ReadInput {
  path: string
  encoding?: BufferEncoding
  offset?: number
  limit?: number
}

export interface ReadOutput {
  /** File content */
  content: string
  /** Total line count (may be actual or estimated before truncation) */
  lines: number
  /** Whether the content was truncated */
  truncated: boolean
  /** Bytes read */
  bytes: number
}

/** Extract filename from a path */
function getFileName(path: string): string {
  if (!path) return ''
  return path.split('/').pop() || path
}

export const read: Tool<ReadInput, ReadOutput> = defineTool({
  name: 'read',
  description: `Read file contents. Supports encoding, offset, and line limit. Large files are auto-truncated; use offset/limit to paginate.`,
  parameters: {
    path: {
      type: 'string',
      description: 'File path (relative to project root)',
      required: true
    },
    encoding: {
      type: 'string',
      description: 'File encoding, defaults to utf-8',
      required: false,
      default: 'utf-8'
    },
    offset: {
      type: 'number',
      description: 'Starting line number (0-based)',
      required: false
    },
    limit: {
      type: 'number',
      description: 'Maximum number of lines to read (subject to system hard limit)',
      required: false
    }
  },
  activity: {
    formatCall: (a) => ({ label: `Read ${getFileName(a.path as string)}`, icon: 'file' }),
    formatResult: (r, a) => {
      const lines = ((r.data as any)?.lines as number) ?? ((r.data as any)?.content as string)?.split('\n').length ?? 0
      return { label: `Read ${getFileName(a?.path as string)} (${lines} lines)`, icon: 'file' }
    }
  },
  execute: async (input, { runtime }) => {
    const result = await runtime.io.readFile(input.path, {
      encoding: input.encoding,
      offset: input.offset,
      limit: input.limit
    })

    if (!result.success) {
      return {
        success: false,
        error: result.error
      }
    }

    const content = result.data!
    const meta = result.meta ?? {}

    return {
      success: true,
      data: {
        content,
        lines: meta.lines ?? content.split('\n').length,
        truncated: meta.truncated ?? false,
        bytes: meta.bytes ?? content.length
      }
    }
  }
})
