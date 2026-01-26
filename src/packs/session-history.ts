/**
 * session-history - Session History Pack
 *
 * Provides conversation history viewing:
 * - Session context sources: session.messages, session.trace, session.search, session.thread
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import {
  sessionMessages,
  sessionTrace,
  sessionSearch,
  sessionThread
} from '../context-sources/index.js'

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
