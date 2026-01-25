/**
 * docs - Document Library Management Pack
 *
 * Provides document indexing and retrieval for large document libraries:
 * - docs.index: List indexed documents
 * - docs.search: Search documents by query
 * - docs.open: Read document content
 *
 * Requires index to be built via: agent-foundry index-docs
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import {
  docsIndex,
  docsSearch,
  docsOpen
} from '../context-sources/index.js'

/**
 * Docs Pack - Document Library Management
 *
 * Context Sources (read operations):
 * - docs.index: List indexed documents with metadata
 * - docs.search: Search documents by keyword query
 * - docs.open: Read document content by path or chunk
 *
 * Prerequisites:
 * - Run `agent-foundry index-docs --paths <dirs>` to build index
 * - Index stored in .agent-foundry/docs_index.json
 */
export function docs(): Pack {
  return definePack({
    id: 'docs',
    description: 'Document library management: docs.index, docs.search, docs.open for indexed document retrieval',

    tools: [],

    contextSources: [
      docsIndex as any,
      docsSearch as any,
      docsOpen as any
    ],

    promptFragment: `
## Document Library Management

Access indexed documents through a three-layer architecture:

### 1. docs.index - Browse Document Library
\`\`\`
ctx.get("docs.index")                           // List all documents
ctx.get("docs.index", { type: "markdown" })     // Filter by type
ctx.get("docs.index", { category: "api" })      // Filter by category
ctx.get("docs.index", { tags: ["guide"] })      // Filter by tags
ctx.get("docs.index", { sortBy: "modified" })   // Sort by modified/title/size
\`\`\`

### 2. docs.search - Find Relevant Documents
\`\`\`
ctx.get("docs.search", { query: "authentication" })     // Search by keyword
ctx.get("docs.search", { query: "setup", type: "markdown", limit: 10 })
ctx.get("docs.search", { query: "API", includePreview: true })
\`\`\`

### 3. docs.open - Read Document Content
\`\`\`
ctx.get("docs.open", { path: "docs/guide.md" })                 // Read first 150 lines
ctx.get("docs.open", { path: "docs/guide.md", startLine: 151 }) // Continue reading
ctx.get("docs.open", { path: "docs/api.md", chunkId: "chunk_002" })  // Read specific chunk
ctx.get("docs.open", { path: "docs/guide.md", includeOutline: true }) // Include outline
\`\`\`

### Recommended Workflow

1. **Explore the library first**:
   \`ctx.get("docs.index")\` - Understand what documents exist

2. **Search for relevant content**:
   \`ctx.get("docs.search", { query: "your topic" })\` - Find matching documents

3. **Read specific documents**:
   \`ctx.get("docs.open", { path: "..." })\` - Read content

4. **Continue reading if needed**:
   Check \`coverage.complete\` in response - if false, use \`startLine\` to continue

### Notes

- **Build index first**: Run \`agent-foundry index-docs --paths docs\` before using
- **Check coverage**: Large documents may be paginated, check coverage.limitations
- **Use chunks**: For long documents, use chunkId from search results
- **Rebuild on changes**: Run index-docs again after document updates
- **Incremental updates**: Use \`--incremental\` flag for faster rebuilds
    `.trim()
  })
}
