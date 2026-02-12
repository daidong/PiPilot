/**
 * web - Web Search & Fetch Pack
 *
 * Combines Brave Search MCP (web/news/local/image/video search)
 * with the built-in fetch tool for full web access.
 *
 * Requires: BRAVE_API_KEY environment variable
 * Free tier: 2,000 queries/month, 1 QPS
 */
import { createStdioMCPProvider } from '../mcp/index.js'
import { mergePacks } from '../factories/define-pack.js'
import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import type { ParameterDefinition, Tool } from '../types/tool.js'
import { fetchTool } from '../tools/index.js'

export interface WebPackOptions {
  /** Brave Search API key. Falls back to process.env.BRAVE_API_KEY */
  braveApiKey?: string
  /** Tool name prefix for Brave tools. Default: none */
  toolPrefix?: string
  /** Request timeout in ms. Default: 30000 */
  timeout?: number
  /** Server startup timeout in ms. Default: 30000 */
  startTimeout?: number
  /** Include fetch tool. Default: true */
  includeFetch?: boolean
  /**
   * Whitelist of Brave tools to enable.
   * Default: all (brave_web_search, brave_local_search, etc.)
   * For free tier, consider limiting to ['brave_web_search'] to conserve quota.
   */
  enabledTools?: string[]
}

const BRAVE_TOOL_PREFIX = 'brave_'
const BRAVE_TOOL_DESC_MAX = 120
const BRAVE_PARAM_DESC_MAX = 80

function normalizeAndClamp(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

function compactParameterDefinition(def: ParameterDefinition): ParameterDefinition {
  const next: ParameterDefinition = { ...def }

  if (typeof next.description === 'string' && next.description.trim().length > 0) {
    next.description = normalizeAndClamp(next.description, BRAVE_PARAM_DESC_MAX)
  }

  if (next.items) {
    next.items = compactParameterDefinition(next.items)
  }

  if (next.properties) {
    const compacted: Record<string, ParameterDefinition> = {}
    for (const [name, property] of Object.entries(next.properties)) {
      compacted[name] = compactParameterDefinition(property)
    }
    next.properties = compacted
  }

  return next
}

/**
 * "Mild compaction" for Brave MCP tools:
 * - Keep all parameters and types intact
 * - Clamp verbose descriptions to reduce tool schema token overhead
 */
export function compactBraveToolSchemas(tools: Tool[]): Tool[] {
  return tools.map((tool) => {
    if (!tool.name.startsWith(BRAVE_TOOL_PREFIX)) return tool

    const compactedParams = Object.fromEntries(
      Object.entries(tool.parameters).map(([name, def]) => [name, compactParameterDefinition(def)])
    )

    const compactedDescription = normalizeAndClamp(tool.description, BRAVE_TOOL_DESC_MAX)

    return {
      ...tool,
      description: compactedDescription,
      parameters: compactedParams
    }
  })
}

/**
 * Creates a web search & fetch pack using Brave Search MCP server.
 *
 * Provides tools:
 * - brave_web_search: General web search
 * - brave_local_search: Local business search
 * - brave_news_search: News search
 * - brave_image_search: Image search
 * - brave_video_search: Video search
 * - brave_summarizer: Page summarization
 * - fetch: Direct HTTP URL retrieval (optional, enabled by default)
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   packs: [packs.safe(), await packs.web()]
 * })
 * ```
 */
export async function web(options: WebPackOptions = {}): Promise<Pack> {
  const {
    braveApiKey,
    toolPrefix,
    timeout = 30000,
    startTimeout = 30000,
    includeFetch = true,
    enabledTools
  } = options

  const apiKey = braveApiKey ?? process.env['BRAVE_API_KEY']
  if (!apiKey) {
    throw new Error(
      'Web pack requires BRAVE_API_KEY. ' +
      'Get a free key at https://brave.com/search/api/ (2,000 queries/month free).'
    )
  }

  // Build env vars
  const env: Record<string, string> = { BRAVE_API_KEY: apiKey }
  if (enabledTools?.length) {
    env['BRAVE_MCP_ENABLED_TOOLS'] = enabledTools.join(',')
  }

  // Create Brave Search MCP provider
  const provider = createStdioMCPProvider({
    id: 'brave-search',
    name: 'Brave Search',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server@2.0.69'],
    env,
    toolPrefix,
    timeout,
    startTimeout
  })

  const bravePacks = await provider.createPacks()
  const bravePack = bravePacks[0]
  if (!bravePack) {
    throw new Error('Failed to create Brave Search MCP pack')
  }
  const compactedBravePack: Pack = {
    ...bravePack,
    tools: compactBraveToolSchemas(bravePack.tools ?? [])
  }

  // Optionally merge with fetch tool
  if (includeFetch) {
    const fetchPack = definePack({
      id: 'web-fetch',
      description: 'HTTP fetch for direct URL retrieval',
      tools: [fetchTool as any]
    })
    return mergePacks(compactedBravePack, fetchPack)
  }

  return compactedBravePack
}
