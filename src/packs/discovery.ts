/**
 * discovery - Context Source Discovery Pack
 *
 * Provides meta context sources for discovering and understanding
 * available context sources:
 * - ctx.catalog: List available sources
 * - ctx.describe: Get full documentation for a source
 * - ctx.route: Get routing recommendations based on intent
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import {
  ctxCatalog,
  ctxDescribe,
  ctxRoute
} from '../context-sources/index.js'

/**
 * Discovery Pack - Context source discovery and routing
 *
 * Context Sources:
 * - ctx.catalog: List available context sources grouped by namespace
 * - ctx.describe: Get full documentation for a specific source
 * - ctx.route: Get routing recommendations based on intent
 *
 * This pack helps agents understand and navigate the context system.
 */
export function discovery(): Pack {
  return definePack({
    id: 'discovery',
    description: 'Context source discovery: ctx.catalog, ctx.describe, ctx.route for navigating available sources',

    tools: [],

    contextSources: [
      ctxCatalog as any,
      ctxDescribe as any,
      ctxRoute as any
    ],

    promptFragment: `
## Context Source Discovery

Use these meta sources to understand and navigate the context system:

### 1. ctx.catalog - List Available Sources
\`\`\`
ctx.get("ctx.catalog")                        // List all sources
ctx.get("ctx.catalog", { namespace: "repo" }) // Filter by namespace
ctx.get("ctx.catalog", { kind: "search" })    // Filter by kind
\`\`\`

Returns a summary of available sources grouped by namespace, including:
- Source ID and kind (index, search, open, get)
- One-line description
- Cost tier (cheap, medium, expensive)

### 2. ctx.describe - Get Full Documentation
\`\`\`
ctx.get("ctx.describe", { id: "repo.search" })
ctx.get("ctx.describe", { id: "docs.open" })
\`\`\`

Returns complete documentation including:
- Parameter schema with types and defaults
- Examples with explanations
- Common errors and fixes
- Workflow suggestions
- Related sources

### 3. ctx.route - Get Routing Recommendations
\`\`\`
ctx.get("ctx.route", { intent: "search", query: "authentication" })
ctx.get("ctx.route", { intent: "browse", namespace: "docs" })
ctx.get("ctx.route", { intent: "auto", query: "find all API endpoints" })
\`\`\`

**Supported intents:**
- **search**: Find something by query
- **browse**: Get an overview/index
- **read**: Read specific content
- **lookup**: Get specific item by key
- **explore**: Understand structure
- **remember**: Store information (suggests tools)
- **recall**: Retrieve stored info
- **auto**: Auto-detect from query

Returns ranked recommendations with:
- Confidence scores
- Suggested parameters
- Example calls
- Workflow suggestions

### Recommended Workflow

1. **Starting a new task?**
   \`ctx.get("ctx.route", { intent: "auto", query: "what you need" })\`

2. **Not sure what sources exist?**
   \`ctx.get("ctx.catalog")\`

3. **Need help with a specific source?**
   \`ctx.get("ctx.describe", { id: "source.id" })\`

### Context Kind Reference

| Kind | Purpose | Example Sources |
|------|---------|-----------------|
| index | Overview/listing | repo.index, docs.index |
| search | Find by query | repo.search, docs.search |
| open | Read content | repo.file, docs.open |
| get | Exact lookup | memory.get, ctx.describe |

### Tips

- Always check \`coverage.complete\` in responses
- Use \`next\` suggestions for follow-up queries
- Prefer cheaper sources when multiple options exist
- Use namespace filtering to narrow down options
    `.trim()
  })
}
