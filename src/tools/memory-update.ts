/**
 * memory-update - Tool for updating existing memory items
 *
 * Features:
 * - Partial updates to existing items
 * - Update value, valueText, tags, status, or sensitivity
 * - Maintains history and provenance tracking
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type { MemoryNamespace, MemorySensitivity, MemoryStatus, MemoryItem } from '../types/memory.js'

export interface MemoryUpdateInput {
  /** Namespace of the item to update */
  namespace: MemoryNamespace
  /** Key of the item to update */
  key: string
  /** New value (if updating) */
  value?: unknown
  /** New human-readable description (if updating) */
  valueText?: string
  /** New tags (if updating) */
  tags?: string[]
  /** New status (active or deprecated) */
  status?: MemoryStatus
  /** New sensitivity level */
  sensitivity?: MemorySensitivity
}

export interface MemoryUpdateOutput {
  /** Whether the operation succeeded */
  success: boolean
  /** The updated memory item */
  item?: MemoryItem
  /** Full key in format "namespace:key" */
  fullKey?: string
  /** Error message if failed */
  error?: string
  /** Fields that were updated */
  updatedFields?: string[]
}

export const memoryUpdate: Tool<MemoryUpdateInput, MemoryUpdateOutput> = defineTool({
  name: 'memory-update',
  description: `Update an existing memory item.

## Usage
- Provide namespace and key to identify the item
- Include only the fields you want to update
- Use status: "deprecated" to mark items as outdated

## Examples
- Update value: { namespace: "user", key: "code.style", value: "python" }
- Add tags: { namespace: "project", key: "db.config", tags: ["database", "config"] }
- Deprecate item: { namespace: "session", key: "temp.data", status: "deprecated" }

## Notes
- Item must exist; use memory-put to create new items
- Updates are atomic and tracked in history`,
  parameters: {
    namespace: {
      type: 'string',
      description: 'Namespace of the item to update',
      required: true
    },
    key: {
      type: 'string',
      description: 'Key of the item to update',
      required: true
    },
    value: {
      type: 'object',
      description: 'New value (if updating)',
      required: false
    },
    valueText: {
      type: 'string',
      description: 'New human-readable description (if updating)',
      required: false
    },
    tags: {
      type: 'array',
      description: 'New tags (if updating)',
      required: false
    },
    status: {
      type: 'string',
      description: 'New status: active or deprecated',
      required: false
    },
    sensitivity: {
      type: 'string',
      description: 'New sensitivity level: public, internal, sensitive',
      required: false
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

      // Check if item exists
      const existing = await memoryStorage.get(input.namespace, input.key)
      if (!existing) {
        return {
          success: false,
          error: `Key "${input.namespace}:${input.key}" not found. Use memory-put to create new items.`
        }
      }

      // Build update options
      const updateOptions: {
        value?: unknown
        valueText?: string
        tags?: string[]
        status?: MemoryStatus
        sensitivity?: MemorySensitivity
      } = {}

      const updatedFields: string[] = []

      if (input.value !== undefined) {
        updateOptions.value = input.value
        updatedFields.push('value')
      }
      if (input.valueText !== undefined) {
        updateOptions.valueText = input.valueText
        updatedFields.push('valueText')
      }
      if (input.tags !== undefined) {
        updateOptions.tags = input.tags
        updatedFields.push('tags')
      }
      if (input.status !== undefined) {
        updateOptions.status = input.status
        updatedFields.push('status')
      }
      if (input.sensitivity !== undefined) {
        updateOptions.sensitivity = input.sensitivity
        updatedFields.push('sensitivity')
      }

      if (updatedFields.length === 0) {
        return {
          success: false,
          error: 'No fields to update. Provide at least one of: value, valueText, tags, status, sensitivity.'
        }
      }

      // Update the item
      const item = await memoryStorage.update(input.namespace, input.key, updateOptions)

      if (!item) {
        return {
          success: false,
          error: `Failed to update "${input.namespace}:${input.key}".`
        }
      }

      return {
        success: true,
        item,
        fullKey: `${input.namespace}:${input.key}`,
        updatedFields
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
})
