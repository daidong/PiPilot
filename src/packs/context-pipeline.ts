/**
 * context-pipeline - Context Assembly Pipeline Pack
 *
 * Features:
 * - Enables the phased context assembly pipeline
 * - Provides ctx-expand tool for retrieving compressed history
 * - Sets up history compressor on runtime
 *
 * Use this pack when you want to enable smart context management with:
 * - Project Cards (long-term memory, always included when present)
 * - User-selected context (via agent.run options)
 * - Session history with compression
 * - On-demand expansion via ctx-expand
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import type { Runtime } from '../types/runtime.js'
import type { RuntimeWithCompressor } from '../types/context-pipeline.js'
import { ctxExpand } from '../tools/ctx-expand.js'
import { SimpleHistoryCompressor } from '../context/compressors/simple-compressor.js'

/**
 * Options for context pipeline pack
 */
export interface ContextPipelinePackOptions {
  /** Segment size for history compression (default: 20) */
  segmentSize?: number
  /** Maximum keywords per segment (default: 10) */
  maxKeywordsPerSegment?: number
}

/**
 * Context Pipeline Pack
 *
 * Provides:
 * - ctx-expand tool for retrieving compressed context
 * - History compressor setup
 * - Prompt fragment with usage instructions
 */
export function contextPipeline(options: ContextPipelinePackOptions = {}): Pack {
  const { segmentSize = 20, maxKeywordsPerSegment = 10 } = options

  return definePack({
    id: 'context-pipeline',
    description: 'Context assembly pipeline with history compression and on-demand expansion',

    tools: [
      ctxExpand as any
    ],

    policies: [],

    promptFragment: `
## Context Management

### History Index
When conversation history is long, older messages are compressed into an index.
Check the "History Index" section above for available segments and keywords.

### ctx-expand Tool
Use the ctx-expand tool to retrieve compressed context:

\`\`\`json
// Expand a segment
{ "type": "segment", "ref": "seg-0" }

// Get specific messages
{ "type": "message", "ref": "0-10" }
{ "type": "message", "ref": "last-5" }

// Retrieve memory
{ "type": "memory", "ref": "project:config" }

// Search through history
{ "type": "search", "ref": "authentication error" }
\`\`\`

### Best Practices
1. Check the History Index for relevant segment keywords
2. Use search to find specific topics in history
3. Expand only what you need to save tokens
4. Memory items tagged 'project-card' are always available (legacy 'pinned' is supported)
    `.trim(),

    onInit: async (runtime: Runtime) => {
      // Set up compressor on runtime
      const extendedRuntime = runtime as RuntimeWithCompressor
      extendedRuntime.compressor = new SimpleHistoryCompressor({
        segmentSize,
        maxKeywordsPerSegment
      })
    },

    onDestroy: async (runtime: Runtime) => {
      // Clean up compressor reference
      const extendedRuntime = runtime as RuntimeWithCompressor
      delete extendedRuntime.compressor
      delete extendedRuntime.compressedHistory
    }
  })
}

/**
 * Alias: contextPipelinePack
 */
export const contextPipelinePack = contextPipeline
