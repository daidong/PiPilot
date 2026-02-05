/**
 * edit - File editing tool
 *
 * Features:
 * - Uses readFileForEdit to bypass autoLimitRead (avoids truncation)
 * - Uniqueness detection (prevents accidental multi-replacements)
 * - Consistent output structure (count/truncated/error)
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface EditInput {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export interface EditOutput {
  /** Edited file path */
  path: string
  /** Number of replacements made */
  replacements: number
  /** Total file size in bytes (after editing) */
  bytes: number
}

export const edit: Tool<EditInput, EditOutput> = defineTool({
  name: 'edit',
  description: `Edit file contents. Replaces old_string with new_string. old_string must match exactly and be unique (or set replace_all=true).`,
  parameters: {
    path: {
      type: 'string',
      description: 'File path (relative to project root)',
      required: true
    },
    old_string: {
      type: 'string',
      description: 'Original content to replace (must match exactly)',
      required: true
    },
    new_string: {
      type: 'string',
      description: 'New content to replace with',
      required: true
    },
    replace_all: {
      type: 'boolean',
      description: 'Whether to replace all occurrences; defaults to replacing only the first',
      required: false,
      default: false
    }
  },
  activity: {
    formatCall: (a) => {
      const file = (a.path as string)?.split('/').pop() || ''
      return { label: `Edit ${file}`, icon: 'edit' }
    },
    formatResult: (_r, a) => {
      const file = (a?.path as string)?.split('/').pop() || ''
      return { label: `Edited ${file}`, icon: 'edit' }
    }
  },
  execute: async (input, { runtime }) => {
    // Use readFileForEdit to read the full file (bypasses autoLimitRead policy)
    // This ensures edits won't fail due to file truncation
    let content: string

    if (runtime.io.readFileForEdit) {
      const readResult = await runtime.io.readFileForEdit(input.path)
      if (!readResult.success) {
        return { success: false, error: readResult.error }
      }
      content = readResult.data!
    } else {
      // Fallback: use regular read (may be truncated)
      const readResult = await runtime.io.readFile(input.path)
      if (!readResult.success) {
        return { success: false, error: readResult.error }
      }
      content = readResult.data!

      // Check if content was truncated
      if (readResult.meta?.truncated) {
        return {
          success: false,
          error: `File too large for edit and was truncated. Consider using smaller edits or splitting the file.`
        }
      }
    }

    // Check if old_string exists
    if (!content.includes(input.old_string)) {
      return {
        success: false,
        error: `old_string not found in file: ${input.path}`
      }
    }

    // Check uniqueness (unless replace_all)
    const occurrences = content.split(input.old_string).length - 1
    if (!input.replace_all && occurrences > 1) {
      return {
        success: false,
        error: `old_string appears ${occurrences} times. Use replace_all=true or provide more context to make it unique.`
      }
    }

    // Perform replacement
    let newContent: string
    let replacements: number

    if (input.replace_all) {
      replacements = occurrences
      newContent = content.split(input.old_string).join(input.new_string)
    } else {
      replacements = 1
      newContent = content.replace(input.old_string, input.new_string)
    }

    // Write file
    const writeResult = await runtime.io.writeFile(input.path, newContent)

    if (!writeResult.success) {
      return { success: false, error: writeResult.error }
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
        replacements,
        bytes: newContent.length
      }
    }
  }
})
