/**
 * kv-memory - Key-Value Memory Storage Pack
 *
 * Provides explicit memory storage for agents to save and retrieve information.
 * Uses file-based JSON storage in .agent-foundry/memory/
 *
 * IMPORTANT: This pack sets up runtime.memoryStorage which is required by:
 * - memory-put, memory-update, memory-delete tools
 * - memory.get, memory.search, memory.list context sources
 * - Pinned phase (context pipeline) for auto-loading pinned items
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import type { Runtime } from '../types/runtime.js'
import { memoryPut, memoryUpdate, memoryDelete } from '../tools/index.js'
import { memoryGet, memorySearch, memoryList } from '../context-sources/index.js'
import { createMemoryStorage } from '../core/memory-storage.js'

/**
 * KV Memory Pack - Key-Value memory storage for agents
 *
 * Tools (write operations):
 * - memory-put: Store new memory items
 * - memory-update: Update existing items
 * - memory-delete: Delete items
 *
 * Context Sources (read operations via ctx.get):
 * - memory.get: Get specific item by key
 * - memory.search: Search items by query
 * - memory.list: List items with filters
 */
export function kvMemory(): Pack {
  return definePack({
    id: 'kv-memory',
    description: 'Key-value memory storage: memory-put, memory-update, memory-delete tools + memory.get, memory.search, memory.list context sources',

    tools: [
      memoryPut as any,
      memoryUpdate as any,
      memoryDelete as any
    ],

    contextSources: [
      memoryGet as any,
      memorySearch as any,
      memoryList as any
    ],

    /**
     * Initialize memory storage on runtime.
     * This is REQUIRED for memory tools and pinned phase to work.
     */
    onInit: async (runtime: Runtime) => {
      // Only create if not already set (e.g., by another pack)
      if (!runtime.memoryStorage) {
        try {
          const memoryStorage = createMemoryStorage(runtime.projectPath)
          await memoryStorage.init()
          runtime.memoryStorage = memoryStorage
        } catch (error) {
          console.error('[kv-memory] Failed to initialize memory storage:', error)
          throw error
        }
      }
    },

    /**
     * Clean up memory storage on destroy.
     */
    onDestroy: async (runtime: Runtime) => {
      if (runtime.memoryStorage) {
        await runtime.memoryStorage.close()
      }
    },

    promptFragment: `
## Memory Storage

Store and retrieve information using the memory system.

### Writing (Tools)

Use tools for write operations:

1. **memory-put** - Store a new memory item
   \`\`\`json
   { "namespace": "user", "key": "code.style", "value": "typescript", "valueText": "User prefers TypeScript" }
   \`\`\`

2. **memory-update** - Update an existing item
   \`\`\`json
   { "namespace": "user", "key": "code.style", "value": "python" }
   \`\`\`

3. **memory-delete** - Delete an item
   \`\`\`json
   { "namespace": "session", "key": "temp.data", "reason": "Session ended" }
   \`\`\`

### Reading (Context Sources)

Use ctx.get for read operations:

1. **memory.get** - Get specific item by key
   \`\`\`
   ctx.get("memory.get", { namespace: "user", key: "code.style" })
   \`\`\`

2. **memory.search** - Search items by query
   \`\`\`
   ctx.get("memory.search", { query: "code preference" })
   \`\`\`

3. **memory.list** - List items with filters
   \`\`\`
   ctx.get("memory.list", { namespace: "project" })
   \`\`\`

### Namespaces

- **user**: User preferences and settings (persist across sessions)
- **project**: Project-specific information
- **session**: Current session context (may expire)

### Sensitivity Levels

- **public**: Safe to include in prompts
- **internal**: Default, excluded from external sharing
- **sensitive**: API keys, passwords (excluded from search by default)

### Best Practices

1. Use descriptive keys: "code.style", "api.endpoint", "db.connection"
2. Include valueText for human-readable descriptions
3. Tag items for easy searching: ["config", "preference"]
4. Use TTL for temporary data: { ttlDays: 7 }
    `.trim()
  })
}
