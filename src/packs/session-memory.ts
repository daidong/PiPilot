/**
 * session-memory - Session History and Long-Term Memory Pack
 *
 * Provides conversation history management and long-term memory:
 * - Session context sources: session.recent, session.search, session.thread
 * - Facts and decisions: facts.list, decisions.list
 * - Memory tools: fact-remember, fact-forget
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import type { Runtime } from '../types/runtime.js'
import {
  sessionRecent,
  sessionSearch,
  sessionThread,
  factsList,
  decisionsList
} from '../context-sources/index.js'
import { factRemember, factForget } from '../tools/index.js'
import { FileFactsDecisionsStore } from '../core/facts-decisions-store.js'

/**
 * Session Memory Pack - Conversation history and long-term memory
 *
 * Context Sources (read operations):
 * - session.recent: Get recent conversation turns
 * - session.search: Search conversation history
 * - session.thread: Expand context around a message
 * - facts.list: List learned facts
 * - decisions.list: List decisions
 *
 * Tools (write operations):
 * - fact-remember: Add facts or decisions
 * - fact-forget: Delete facts or deprecate decisions
 */
export function sessionMemory(): Pack {
  // Store reference for cleanup
  let store: FileFactsDecisionsStore | null = null

  return definePack({
    id: 'session-memory',
    description: 'Session history and long-term memory: session.recent, session.search, session.thread, facts.list, decisions.list + fact-remember, fact-forget tools',

    tools: [
      factRemember as any,
      factForget as any
    ],

    contextSources: [
      sessionRecent as any,
      sessionSearch as any,
      sessionThread as any,
      factsList as any,
      decisionsList as any
    ],

    onInit: async (runtime: Runtime) => {
      // Initialize facts/decisions store
      store = new FileFactsDecisionsStore(runtime.projectPath)
      await store.init()
      // Attach to runtime for tools and context sources to use
      ;(runtime as any).factsDecisionsStore = store
    },

    onDestroy: async (_runtime: Runtime) => {
      // Clean up store
      if (store) {
        await store.close()
        store = null
      }
    },

    promptFragment: `
## Session & Memory Management

### Session Context (Conversation History)

1. **session.recent** - Get recent conversation turns
   \`\`\`
   ctx.get("session.recent", { turns: 10 })
   \`\`\`

2. **session.search** - Search conversation history
   \`\`\`
   ctx.get("session.search", { query: "database design", k: 5 })
   \`\`\`

3. **session.thread** - Expand context around a message
   \`\`\`
   ctx.get("session.thread", { anchorMessageId: "msg_xxx", windowTurns: 5 })
   \`\`\`

### Long-Term Memory

1. **facts.list** - Get learned facts (preferences, constraints)
   \`\`\`
   ctx.get("facts.list", { topics: ["preference"], confidence: "confirmed" })
   \`\`\`

2. **decisions.list** - Get decisions with status
   \`\`\`
   ctx.get("decisions.list", { status: "active" })
   \`\`\`

### Memory Tools

1. **fact-remember** - Add facts or decisions
   \`\`\`json
   { "type": "fact", "content": "User prefers TypeScript", "topics": ["preference"], "confidence": "confirmed" }
   { "type": "decision", "content": "Use PostgreSQL for this project" }
   \`\`\`

2. **fact-forget** - Delete facts or deprecate decisions
   \`\`\`json
   { "type": "fact", "id": "fact_xxx", "reason": "No longer accurate" }
   { "type": "decision", "id": "dec_xxx", "reason": "Requirements changed" }
   \`\`\`

### Recommended Workflow

1. **Get recent context first**:
   ctx.get("session.recent", { turns: 12 })

2. **Search for specific topics**:
   ctx.get("session.search", { query: "...", k: 8 })

3. **Expand context around a match**:
   ctx.get("session.thread", { anchorMessageId: "msg_xxx" })

4. **Check long-term memory**:
   ctx.get("facts.list", { topics: ["preference"] })
   ctx.get("decisions.list", { status: "active" })

### Notes

- Facts with confidence="inferred" may need user confirmation
- Decisions are never deleted, only deprecated (for audit trail)
- Always include provenance when citing from memory
- Check coverage.complete to know if results are exhaustive
    `.trim()
  })
}
