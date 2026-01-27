/**
 * session-history - Session History Pack
 *
 * Provides conversation history viewing:
 * - Session context sources: session.messages, session.trace, session.search, session.thread
 *
 * IMPORTANT: This pack sets up runtime.messageStore which is required by:
 * - session.messages, session.trace, session.search, session.thread context sources
 * - ctx-expand tool (for message expansion)
 * - Session phase (context pipeline) for including recent messages
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import type { Runtime } from '../types/runtime.js'
import {
  sessionMessages,
  sessionTrace,
  sessionSearch,
  sessionThread
} from '../context-sources/index.js'
import { createMessageStore } from '../core/message-store.js'

/**
 * Session History Pack - Conversation history viewing
 *
 * Context Sources (read operations):
 * - session.messages: Get recent conversation messages
 * - session.trace: Get operation trace (tool calls, file ops)
 * - session.search: Search conversation history
 * - session.thread: Expand context around a message
 */
export function sessionHistory(): Pack {
  return definePack({
    id: 'session-history',
    description: 'Session history viewing: session.messages, session.trace, session.search, session.thread context sources',

    tools: [],

    contextSources: [
      sessionMessages as any,
      sessionTrace as any,
      sessionSearch as any,
      sessionThread as any
    ],

    /**
     * Initialize message store on runtime.
     * This is REQUIRED for session context sources and ctx-expand to work.
     */
    onInit: async (runtime: Runtime) => {
      // Only create if not already set (e.g., by another pack)
      if (!runtime.messageStore) {
        const messageStore = createMessageStore(runtime.projectPath)
        await messageStore.init()
        runtime.messageStore = messageStore
      }
    },

    /**
     * Clean up message store on destroy.
     */
    onDestroy: async (runtime: Runtime) => {
      if (runtime.messageStore) {
        await runtime.messageStore.close()
      }
    },

    promptFragment: `
## Session History

View conversation history using these context sources:

1. **session.messages** - Get recent conversation messages
   \`\`\`
   ctx.get("session.messages", { turns: 10 })
   \`\`\`

2. **session.trace** - Get operation trace (tool calls, file operations)
   \`\`\`
   ctx.get("session.trace", { limit: 20, type: "tool" })
   \`\`\`

3. **session.search** - Search conversation history
   \`\`\`
   ctx.get("session.search", { query: "database design", k: 5 })
   \`\`\`

4. **session.thread** - Expand context around a message
   \`\`\`
   ctx.get("session.thread", { anchorMessageId: "msg_xxx", windowTurns: 5 })
   \`\`\`

### Key Differences

| Source | What it returns |
|--------|-----------------|
| session.messages | User/assistant conversation text |
| session.trace | Tool calls, file operations, context fetches |

### Notes

- Check coverage.complete to know if results are exhaustive
- Use session.search to find specific topics in history
    `.trim()
  })
}
