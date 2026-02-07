/**
 * todo - Task tracking pack
 *
 * Provides structured todo/task management built on kv-memory storage.
 * Requires kv-memory pack (or initializes memory storage automatically).
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import type { Runtime } from '../types/runtime.js'
import { todoAdd } from '../tools/todo-add.js'
import { todoUpdate } from '../tools/todo-update.js'
import { todoComplete } from '../tools/todo-complete.js'
import { todoRemove } from '../tools/todo-remove.js'
import { todoList } from '../context-sources/todo-list.js'
import { todoGet } from '../context-sources/todo-get.js'

/**
 * Todo Pack - Structured task tracking for agents
 *
 * Tools (write operations):
 * - todo-add: Create a new todo item
 * - todo-update: Update an existing item
 * - todo-complete: Mark an item as done
 * - todo-remove: Delete an item
 *
 * Context Sources (read operations via ctx.get):
 * - todo.list: List/filter todo items
 * - todo.get: Get a single item with sub-tasks
 */
export function todo(): Pack {
  return definePack({
    id: 'todo',
    description: 'Task tracking: todo-add, todo-update, todo-complete, todo-remove tools + todo.list, todo.get context sources',

    tools: [
      todoAdd as any,
      todoUpdate as any,
      todoComplete as any,
      todoRemove as any
    ],

    contextSources: [
      todoList as any,
      todoGet as any
    ],

    /**
     * Ensure memory storage is available (kv-memory must init first, or we create it).
     */
    onInit: async (runtime: Runtime) => {
      // Kernel V2 sets runtime.memoryStorage during init.
      // If it's missing, something went wrong — log a warning.
      if (!runtime.memoryStorage) {
        console.warn('[todo] runtime.memoryStorage not set. Kernel V2 should have initialized it.')
      }
    },

    promptFragment: `
## Todo List

Track tasks using the todo system.

### Creating Tasks (Tools)

1. **todo-add** - Create a new task
   \`\`\`json
   { "title": "Fix login bug", "priority": "high", "tags": ["backend"] }
   \`\`\`

2. **todo-update** - Update a task
   \`\`\`json
   { "id": "todo-xxx", "status": "in_progress" }
   \`\`\`

3. **todo-complete** - Mark task as done
   \`\`\`json
   { "id": "todo-xxx" }
   \`\`\`

4. **todo-remove** - Delete a task
   \`\`\`json
   { "id": "todo-xxx" }
   \`\`\`

### Viewing Tasks (Context Sources)

1. **todo.list** - List tasks with filters
   \`\`\`
   ctx.get("todo.list", { status: "pending", priority: "high" })
   \`\`\`

2. **todo.get** - Get task details and sub-tasks
   \`\`\`
   ctx.get("todo.get", { id: "todo-xxx" })
   \`\`\`

### Task Status Flow

pending → in_progress → done
pending → blocked → in_progress → done

### Priorities

critical > high > medium > low
    `.trim()
  })
}
