/**
 * memory-put - Tool for storing memory items
 *
 * Features:
 * - Store key-value pairs with metadata
 * - Support for namespaces, tags, and sensitivity levels
 * - Automatic provenance tracking
 * - TTL support for auto-expiration
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type { MemoryNamespace, MemorySensitivity, MemoryItem } from '../types/memory.js'
import { coerceDeep } from '../utils/schema-coercion.js'

export interface MemoryPutInput {
  /** Namespace for isolation (user, project, session) */
  namespace: MemoryNamespace
  /** Key within namespace (dot-separated path, e.g., "writing.style") */
  key: string
  /** Value to store (any JSON-serializable data) */
  value: unknown
  /** Human-readable description of the value */
  valueText?: string
  /** Tags for categorization and search */
  tags?: string[]
  /** Sensitivity level (public, internal, sensitive) */
  sensitivity?: MemorySensitivity
  /** Time-to-live in days (auto-expire after this many days) */
  ttlDays?: number
  /** Whether to overwrite if key already exists (default: false) */
  overwrite?: boolean
}

export interface MemoryPutOutput {
  /** Whether the operation succeeded */
  success: boolean
  /** The stored memory item */
  item?: MemoryItem
  /** Full key in format "namespace:key" */
  fullKey?: string
  /** Error message if failed */
  error?: string
  /** Whether this was an overwrite of existing item */
  overwritten?: boolean
}

export const memoryPut: Tool<MemoryPutInput, MemoryPutOutput> = defineTool({
  name: 'memory-put',
  description: `Store a memory item for later retrieval.

## Usage
- Use namespaces to isolate different types of data:
  - "user": User preferences, settings
  - "project": Project-specific information
  - "session": Current session context
- Keys are dot-separated paths: "writing.style", "api.endpoint"
- Include valueText for human-readable description

## Examples
- Store user preference: { namespace: "user", key: "code.style", value: "typescript", valueText: "User prefers TypeScript" }
- Store project info: { namespace: "project", key: "db.connection", value: {...}, sensitivity: "sensitive" }

## Notes
- Use ctx.get("memory.get") or ctx.get("memory.search") to retrieve items
- Sensitive items are excluded from search by default`,
  parameters: {
    namespace: {
      type: 'string',
      description: 'Namespace for isolation (user, project, session, or custom)',
      required: true
    },
    key: {
      type: 'string',
      description: 'Key within namespace (lowercase, dot-separated, e.g., "writing.style")',
      required: true
    },
    value: {
      type: 'object',
      description: 'Value to store (any JSON-serializable data)',
      required: true
    },
    valueText: {
      type: 'string',
      description: 'Human-readable description of the value',
      required: false
    },
    tags: {
      type: 'array',
      description: 'Tags for categorization and search',
      required: false
    },
    sensitivity: {
      type: 'string',
      description: 'Sensitivity level: public, internal (default), sensitive',
      required: false
    },
    ttlDays: {
      type: 'number',
      description: 'Auto-expire after this many days',
      required: false
    },
    overwrite: {
      type: 'boolean',
      description: 'Whether to overwrite existing item (default: false)',
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

      // Coerce string values to their intended types
      // This is needed because OpenAI Responses API requires additionalProperties: { type: 'string' }
      // See: src/utils/schema-coercion.ts for details
      const coercedValue = coerceDeep(input.value)

      // Check if item already exists
      const existing = await memoryStorage.has(input.namespace, input.key)
      if (existing && !input.overwrite) {
        return {
          success: false,
          error: `Key "${input.namespace}:${input.key}" already exists. Use overwrite: true to replace.`
        }
      }

      // Store the item
      const item = await memoryStorage.put({
        namespace: input.namespace,
        key: input.key,
        value: coercedValue,
        valueText: input.valueText,
        tags: input.tags,
        sensitivity: input.sensitivity,
        ttlDays: input.ttlDays,
        overwrite: input.overwrite,
        provenance: {
          createdBy: 'model'
        }
      })

      return {
        success: true,
        item,
        fullKey: `${input.namespace}:${input.key}`,
        overwritten: existing
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
})
