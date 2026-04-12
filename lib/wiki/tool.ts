/**
 * Legacy Wiki Lookup — compatibility shim (RFC-005 §8.6).
 *
 * `wiki_lookup` is preserved only so old prompts, saved sessions, or
 * downstream callers that hard-coded the tool name keep working. It
 * dispatches to the RFC-005 tools:
 *
 *   - wiki_lookup(query)           → wiki_search(query)
 *   - wiki_lookup(query, page)     → wiki_get(slug=page, sections=['page:full'])
 *
 * Scheduled for removal one release after RFC-005 lands.
 * NEW code should call wiki_search / wiki_get directly.
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { createWikiSearchTool, createWikiGetTool } from './wiki-tools.js'

export function createWikiLookupTool(): AgentTool {
  // Instantiate delegates once per shim instance. Factories are cheap and
  // stateless; this avoids re-creating them on every execute() call.
  const search = createWikiSearchTool()
  const get = createWikiGetTool()

  return {
    name: 'wiki_lookup',
    label: 'Wiki Lookup (legacy shim)',
    description:
      'DEPRECATED: prefer wiki_search (topic search) or wiki_get (targeted memory read). ' +
      'This tool is a compatibility shim that dispatches to the RFC-005 memory tools. ' +
      'Scheduled for removal one release after RFC-005 ships. ' +
      'Calls with a `page` parameter route to wiki_get; calls with only `query` route to wiki_search.',
    parameters: Type.Object({
      query: Type.String({
        description: 'Search query (topic or keyword). Ignored when `page` is provided.',
      }),
      page: Type.Optional(Type.String({
        description: 'Exact page slug. When set, this call dispatches to wiki_get and returns the full Markdown body.',
      })),
    }),
    execute: async (toolCallId, params, signal): Promise<AgentToolResult<unknown>> => {
      const { query, page } = params as { query: string; page?: string }
      if (page) {
        return get.execute(
          toolCallId,
          { slug: page, sections: ['page:full'] } as unknown,
          signal,
        )
      }
      return search.execute(
        toolCallId,
        { query, k: 10 } as unknown,
        signal,
      )
    },
  }
}
