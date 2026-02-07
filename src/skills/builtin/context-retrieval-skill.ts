/**
 * Context Retrieval Skill
 *
 * Provides procedural knowledge for using context sources:
 * - ctx-get: Unified context retrieval
 * - Understanding available context sources
 * - Best practices for context usage
 */

import { defineSkill } from '../define-skill.js'
import type { Skill } from '../../types/skill.js'

/**
 * Context Retrieval Skill
 */
export const contextRetrievalSkill: Skill = defineSkill({
  id: 'context-retrieval-skill',
  name: 'Context Retrieval',
  shortDescription: 'Retrieve and use context from session, memory, docs, and other sources',

  instructions: {
    summary: `Context retrieval via **ctx-get** tool:
- **session.***: Operation traces
- **memory.***: Persistent key-value storage
- **docs.***: Project documentation
- **meta.***: Project structure information`,

    procedures: `
## ctx-get Tool
Unified interface for all context sources.

### Parameters
- \`source\`: Context source ID (e.g., "session.trace", "memory.get")
- \`params\`: Source-specific parameters

### Available Sources

#### Session Context
| Source | Description | Params |
|--------|-------------|--------|
| session.trace | Execution trace events | types, limit |

#### Memory Context
| Source | Description | Params |
|--------|-------------|--------|
| memory.get | Get stored value | key |
| memory.list | List keys | prefix, limit |
| memory.search | Search memory | query, limit |

#### Documentation Context
| Source | Description | Params |
|--------|-------------|--------|
| docs.readme | Project README | - |
| docs.contributing | Contribution guide | - |
| docs.api | API documentation | path |

#### Meta Context
| Source | Description | Params |
|--------|-------------|--------|
| meta.structure | Project structure | depth |
| meta.dependencies | Package dependencies | - |
| meta.config | Project configuration | - |

## Best Practices

### Efficient Context Usage
1. Request only needed context sources
2. Use appropriate limits to control token usage
3. Prefer specific queries over broad retrieval
4. Cache results when making multiple related requests

### Context Priority
1. **Recent session**: Most relevant for current task
2. **Stored memory**: Accumulated knowledge
3. **Project docs**: Reference information
4. **Meta info**: Structural understanding

### Token Management
- Context sources have budget limits
- Prioritize most relevant sources
- Use search/filter before full retrieval
`,

    examples: `
## Get Session Trace
\`\`\`json
{
  "tool": "ctx-get",
  "input": {
    "source": "session.trace",
    "params": { "limit": 10 }
  }
}
\`\`\`

## Get Memory Value
\`\`\`json
{
  "tool": "ctx-get",
  "input": {
    "source": "memory.get",
    "params": { "key": "user.preferences" }
  }
}
\`\`\`

## List Memory Keys
\`\`\`json
{
  "tool": "ctx-get",
  "input": {
    "source": "memory.list",
    "params": { "prefix": "project.", "limit": 20 }
  }
}
\`\`\`

## Get Project Structure
\`\`\`json
{
  "tool": "ctx-get",
  "input": {
    "source": "meta.structure",
    "params": { "depth": 2 }
  }
}
\`\`\`
`,

    troubleshooting: `
## Common Issues

### "Unknown context source"
- Check source ID spelling
- Verify the context source pack is loaded
- Use \`meta.sources\` to list available sources

### Empty results
- Verify data exists in the source
- Check parameter spelling and types
- Try broader search query

### Token budget exceeded
- Reduce limit parameter
- Use more specific queries
- Prioritize essential sources

### Stale context
- Session context refreshes each turn
- Memory context persists across sessions
- Use search to find recent relevant items
`
  },

  tools: ['ctx-get'],
  loadingStrategy: 'lazy',

  estimatedTokens: {
    summary: 50,
    full: 500
  },

  tags: ['context', 'retrieval', 'memory', 'session']
})

export default contextRetrievalSkill
