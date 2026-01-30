/**
 * memory-delete - Tool for deleting memory items
 *
 * Features:
 * - Delete individual memory items by namespace and key
 * - Requires reason for audit trail
 * - Soft delete with history tracking
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type { MemoryNamespace } from '../types/memory.js'

export interface MemoryDeleteInput {
  /** Namespace of the item to delete */
  namespace: MemoryNamespace
  /** Key of the item to delete */
  key: string
  /** Reason for deletion (for audit trail) */
  reason?: string
}

export interface MemoryDeleteOutput {
  /** Whether the operation succeeded */
  success: boolean
  /** Full key of deleted item */
  fullKey?: string
  /** Error message if failed */
  error?: string
  /** Whether the item existed */
  existed?: boolean
}

export const memoryDelete: Tool<MemoryDeleteInput, MemoryDeleteOutput> = defineTool({
  name: 'memory-delete',
  description: `Delete a memory item by namespace and key. Permanent but tracked in history. Prefer memory-update with status "deprecated" for soft delete.`,
  parameters: {
    namespace: {
      type: 'string',
      description: 'Namespace of the item to delete',
      required: true
    },
    key: {
      type: 'string',
      description: 'Key of the item to delete',
      required: true
    },
    reason: {
      type: 'string',
      description: 'Reason for deletion (for audit trail)',
      required: false
    }
  },
  activity: {
    formatCall: (a) => {
      const key = (a.key as string) || ''
      return { label: key ? `Delete: ${key.slice(0, 40)}` : 'Delete memory', icon: 'memory' }
    },
    formatResult: (_r, a) => {
      const key = (a?.key as string) || ''
      return { label: key ? `Deleted "${key.slice(0, 30)}"` : 'Deleted memory', icon: 'memory' }
    }
  },
  execute: async (input, { runtime }) => {
    try {
      // Get memory storage from runtime
      const memoryStorage = runtime.memoryStorage
      if (!memoryStorage) {
        return {
          success: false,
          error: 'Memory storage not available. Make sure kv-memory pack is loaded.'
        }
      }

      const fullKey = `${input.namespace}:${input.key}`

      // Check if item exists
      const existing = await memoryStorage.has(input.namespace, input.key)
      if (!existing) {
        return {
          success: false,
          error: `Key "${fullKey}" not found.`,
          existed: false
        }
      }

      // Delete the item
      const deleted = await memoryStorage.delete(
        input.namespace,
        input.key,
        input.reason ?? 'Deleted via memory-delete tool'
      )

      if (!deleted) {
        return {
          success: false,
          error: `Failed to delete "${fullKey}".`,
          existed: true
        }
      }

      return {
        success: true,
        fullKey,
        existed: true
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
})
