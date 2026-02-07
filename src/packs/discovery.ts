/**
 * discovery - Context Source Discovery Pack
 *
 * Provides meta context sources for discovering and understanding
 * available context sources:
 * - ctx.catalog: List available sources
 * - ctx.describe: Get full documentation for a source
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import {
  ctxCatalog,
  ctxDescribe
} from '../context-sources/index.js'

/**
 * Discovery Pack - Context source discovery
 *
 * Context Sources:
 * - ctx.catalog: List available context sources grouped by namespace
 * - ctx.describe: Get full documentation for a specific source
 *
 * This pack helps agents understand and navigate the context system.
 */
export function discovery(): Pack {
  return definePack({
    id: 'discovery',
    description: 'Context source discovery: ctx.catalog, ctx.describe for navigating available sources',

    tools: [],

    contextSources: [
      ctxCatalog as any,
      ctxDescribe as any
    ],

    promptFragment: `
## Context Source Discovery

Use these meta sources to understand and navigate the context system:

### 1. ctx.catalog - List Available Sources
\`\`\`
ctx.get("ctx.catalog")                        // List all sources
ctx.get("ctx.catalog", { namespace: "session" }) // Filter by namespace
ctx.get("ctx.catalog", { kind: "search" })    // Filter by kind
\`\`\`

Returns a summary of available sources grouped by namespace, including:
- Source ID and kind (index, search, open, get)
- One-line description
- Cost tier (cheap, medium, expensive)

### 2. ctx.describe - Get Full Documentation
\`\`\`
ctx.get("ctx.describe", { id: "docs.open" })
ctx.get("ctx.describe", { id: "memory.get" })
\`\`\`

Returns complete documentation including:
- Parameter schema with types and defaults
- Examples with explanations
- Common errors and fixes
- Related sources

### Context Kind Reference

| Kind | Purpose | Example Sources |
|------|---------|-----------------|
| index | Overview/listing | docs.index, memory.list |
| search | Find by query | docs.search, memory.search |
| open | Read content | docs.open |
| get | Exact lookup | memory.get, ctx.describe |

### Tips

- Always check \`coverage.complete\` in responses
- Use \`next\` suggestions for follow-up queries
- Prefer cheaper sources when multiple options exist
- Use namespace filtering to narrow down options
    `.trim()
  })
}
