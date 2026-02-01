/**
 * Memory Search Pack - BM25 full-text search over markdown memory files
 *
 * Indexes markdown files in specified directories into a SQLite FTS5 database,
 * exposing memory_search and memory_get tools for retrieval.
 */

import { join } from 'path'
import { definePack } from '../factories/define-pack.js'
import { defineTool } from '../factories/define-tool.js'
import { MemoryIndex } from '../core/memory-index.js'
import type { Pack } from '../types/pack.js'
import type { Runtime } from '../types/runtime.js'

export interface MemorySearchPackOptions {
  /** Directories to index (absolute paths) */
  dirs: string[]
  /** Extra individual files to index (absolute paths) */
  extraFiles?: string[]
}

const MEMORY_INDEX_KEY = '__memoryIndex'

function getIndex(runtime: Runtime): MemoryIndex | null {
  return (runtime as any)[MEMORY_INDEX_KEY] ?? null
}

const memorySearchTool = defineTool({
  name: 'memory_search',
  description: 'Search through memory files (daily logs, notes, preferences) using full-text search. Returns matching snippets with file paths and line numbers.',
  parameters: {
    query: {
      type: 'string',
      description: 'Search query (keywords, phrases)',
      required: true
    },
    limit: {
      type: 'number',
      description: 'Maximum number of results (default: 10)',
      required: false
    }
  },
  execute: async (input: { query: string; limit?: number }, context) => {
    const index = getIndex(context.runtime)
    if (!index) {
      return { success: false, error: 'Memory index not initialized' }
    }

    const results = index.search(input.query, input.limit ?? 10)
    return {
      success: true,
      data: {
        results,
        count: results.length
      }
    }
  }
})

const memoryGetTool = defineTool({
  name: 'memory_get',
  description: 'Read content from a specific memory file, optionally by line range. Use after memory_search to read full context around a match.',
  parameters: {
    path: {
      type: 'string',
      description: 'Absolute file path (from memory_search results)',
      required: true
    },
    startLine: {
      type: 'number',
      description: 'Start line number (1-based, optional)',
      required: false
    },
    endLine: {
      type: 'number',
      description: 'End line number (1-based, inclusive, optional)',
      required: false
    }
  },
  execute: async (input: { path: string; startLine?: number; endLine?: number }, context) => {
    const index = getIndex(context.runtime)
    if (!index) {
      return { success: false, error: 'Memory index not initialized' }
    }

    const content = index.get(input.path, input.startLine, input.endLine)
    if (content === null) {
      return { success: false, error: `File not found: ${input.path}` }
    }

    return {
      success: true,
      data: { content }
    }
  }
})

export function memorySearch(options: MemorySearchPackOptions): Pack {
  return definePack({
    id: 'memory-search',
    description: 'Full-text search over markdown memory files using BM25 (memory_search, memory_get)',

    tools: [memorySearchTool as any, memoryGetTool as any],

    promptFragment: [
      'You have access to a searchable memory index of markdown files (daily logs, notes, user preferences).',
      'Use memory_search to find past conversations, preferences, facts from daily logs.',
      'Use memory_get to read specific file sections after finding them with memory_search.'
    ].join(' '),

    async onInit(runtime: Runtime) {
      const projectPath = (runtime as any).projectPath || process.cwd()
      const dbPath = join(projectPath, '.agent-foundry', 'memory-search.db')

      const index = new MemoryIndex(dbPath, options.dirs, options.extraFiles ?? [])
      await index.init()
      index.startWatcher();

      (runtime as any)[MEMORY_INDEX_KEY] = index
    },

    async onDestroy(runtime: Runtime) {
      const index = getIndex(runtime)
      if (index) {
        index.close()
        delete (runtime as any)[MEMORY_INDEX_KEY]
      }
    }
  })
}
