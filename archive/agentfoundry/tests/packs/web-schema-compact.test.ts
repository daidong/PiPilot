import { describe, expect, it } from 'vitest'

import type { Tool } from '../../src/types/tool.js'
import { compactBraveToolSchemas } from '../../src/packs/web.js'

function longText(seed: string): string {
  return `${seed} `.repeat(30).trim()
}

describe('compactBraveToolSchemas', () => {
  it('compacts descriptions for brave_* tools while preserving schema shape', () => {
    const braveTool: Tool = {
      name: 'brave_web_search',
      description: longText('General web search over Brave index with optional advanced controls.'),
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: longText('Search query text used by the Brave web search endpoint.')
        },
        freshness: {
          type: 'string',
          required: false,
          description: longText('Freshness filter for recency control over returned results.')
        },
        nested: {
          type: 'object',
          required: false,
          description: longText('Nested options'),
          properties: {
            include: {
              type: 'array',
              description: longText('Nested include filter'),
              items: {
                type: 'string',
                description: longText('Nested include item')
              }
            }
          }
        }
      },
      execute: async () => ({ success: true, data: {} })
    }

    const compacted = compactBraveToolSchemas([braveTool])[0]
    expect(compacted).toBeTruthy()
    expect(compacted?.name).toBe('brave_web_search')
    expect(compacted?.description.length).toBeLessThanOrEqual(120)
    expect(compacted?.parameters.query.description?.length ?? 0).toBeLessThanOrEqual(80)
    expect(compacted?.parameters.freshness.description?.length ?? 0).toBeLessThanOrEqual(80)
    expect(compacted?.parameters.nested.description?.length ?? 0).toBeLessThanOrEqual(80)
    expect(compacted?.parameters.nested.properties?.include.description?.length ?? 0).toBeLessThanOrEqual(80)
  })

  it('leaves non-brave tools unchanged', () => {
    const nonBraveTool: Tool = {
      name: 'read',
      description: longText('Read file content from project workspace.'),
      parameters: {
        path: { type: 'string', required: true, description: longText('File path') }
      },
      execute: async () => ({ success: true, data: {} })
    }

    const compacted = compactBraveToolSchemas([nonBraveTool])[0]
    expect(compacted).toBe(nonBraveTool)
  })
})
