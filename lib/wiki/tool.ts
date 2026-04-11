/**
 * Wiki Lookup Tool — read-only access to the global paper wiki.
 *
 * Always registered (never returns null). Returns "Wiki not available" at
 * execute time if the wiki directory doesn't exist yet. This ensures the
 * coordinator always has the tool and the RFC fallback contract is met.
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { toAgentResult } from '../tools/tool-utils.js'
import { getWikiRoot } from './types.js'
import { safeReadFile } from './io.js'

export function createWikiLookupTool(): AgentTool {
  return {
    name: 'wiki_lookup',
    label: 'Wiki Lookup',
    description: 'Search or read the global paper wiki. Contains LLM-generated summaries of papers from all projects. Use to check existing knowledge before launching literature searches.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query (paper title, topic keyword, concept name)' }),
      page: Type.Optional(Type.String({ description: 'Exact page slug to read (e.g., "arxiv-2301-12345" or concept slug). Omit for search.' })),
    }),
    execute: async (_toolCallId, params, _signal): Promise<AgentToolResult> => {
      const { query, page } = params as { query: string; page?: string }
      const wikiRoot = getWikiRoot()

      // Runtime check — wiki may not exist yet
      if (!existsSync(wikiRoot)) {
        return toAgentResult('wiki_lookup', { success: true, data: 'Wiki not available.' })
      }

      // Direct page read
      if (page) {
        for (const subdir of ['papers', 'concepts']) {
          const filePath = join(wikiRoot, subdir, `${page}.md`)
          const content = safeReadFile(filePath)
          if (content) {
            const truncated = content.length > 50_000 ? content.slice(0, 50_000) + '\n\n[truncated]' : content
            return toAgentResult('wiki_lookup', { success: true, data: truncated })
          }
        }
        return toAgentResult('wiki_lookup', { success: true, data: `No wiki page found for slug: ${page}` })
      }

      // Search mode — scan papers/ and concepts/ for query matches
      const queryLower = query.toLowerCase()
      const results: Array<{ title: string; slug: string; type: string; snippet: string }> = []

      for (const subdir of ['papers', 'concepts']) {
        const dir = join(wikiRoot, subdir)
        if (!existsSync(dir)) continue

        const files = readdirSync(dir).filter(f => f.endsWith('.md'))
        for (const file of files) {
          const content = safeReadFile(join(dir, file))
          if (!content) continue
          if (!content.toLowerCase().includes(queryLower)) continue

          const titleMatch = content.match(/^#\s+(.+)$/m)
          const title = titleMatch ? titleMatch[1] : file.replace('.md', '')
          const slug = file.replace('.md', '')

          // Extract snippet around first match
          const idx = content.toLowerCase().indexOf(queryLower)
          const start = Math.max(0, idx - 100)
          const end = Math.min(content.length, idx + query.length + 200)
          const snippet = (start > 0 ? '...' : '') + content.slice(start, end).trim() + (end < content.length ? '...' : '')

          results.push({ title, slug, type: subdir === 'papers' ? 'paper' : 'concept', snippet })
        }
      }

      if (results.length === 0) {
        const indexContent = safeReadFile(join(wikiRoot, 'index.md'))
        if (indexContent) {
          return toAgentResult('wiki_lookup', {
            success: true,
            data: `No pages match "${query}". Wiki index:\n\n${indexContent.slice(0, 5000)}`
          })
        }
        return toAgentResult('wiki_lookup', { success: true, data: `No wiki pages match "${query}".` })
      }

      const formatted = results.slice(0, 10).map(r =>
        `## ${r.title}\nType: ${r.type} | Slug: ${r.slug}\n${r.snippet}`
      ).join('\n\n---\n\n')

      const header = `Found ${results.length} result${results.length > 1 ? 's' : ''} for "${query}":\n\n`
      return toAgentResult('wiki_lookup', { success: true, data: header + formatted })
    }
  }
}
