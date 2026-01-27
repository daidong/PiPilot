/**
 * Selected Phase - Assembles user-selected context
 *
 * Priority: 80
 * Budget: percentage 30%
 *
 * This phase processes user-specified context selections from agent.run() options.
 * Supported selection types:
 * - memory: Memory key lookup
 * - file: File path reading
 * - messages: Message range retrieval
 * - url: URL fetching (if supported)
 * - custom: Custom resolver function
 */

import type {
  ContextPhase,
  ContextFragment,
  AssemblyContext,
  ContextSelection
} from '../../types/context-pipeline.js'
import { PHASE_PRIORITIES, DEFAULT_BUDGETS } from '../pipeline.js'

/**
 * Configuration for selected phase
 */
export interface SelectedPhaseConfig {
  /** Maximum tokens per file */
  maxTokensPerFile?: number
  /** Maximum tokens per memory item */
  maxTokensPerMemory?: number
}

/**
 * Create the selected phase
 */
export function createSelectedPhase(config: SelectedPhaseConfig = {}): ContextPhase {
  const { maxTokensPerFile = 5000, maxTokensPerMemory = 2000 } = config

  return {
    id: 'selected',
    priority: PHASE_PRIORITIES.selected,
    budget: DEFAULT_BUDGETS.selected,

    async assemble(ctx: AssemblyContext): Promise<ContextFragment[]> {
      const { runtime, selectedContext } = ctx
      const fragments: ContextFragment[] = []

      // If no selections, return empty
      if (!selectedContext || selectedContext.length === 0) {
        return fragments
      }

      // Add header
      const headerContent = '## Selected Context'
      fragments.push({
        source: 'selected:header',
        content: headerContent,
        tokens: estimateTokens(headerContent)
      })

      // Process each selection
      for (const selection of selectedContext) {
        try {
          const fragment = await resolveSelection(selection, runtime, {
            maxTokensPerFile,
            maxTokensPerMemory
          })
          if (fragment) {
            fragments.push(fragment)
          }
        } catch (error) {
          console.error(`[SelectedPhase] Failed to resolve selection:`, selection, error)
          // Add error fragment so user knows something went wrong
          fragments.push({
            source: `selected:error:${selection.type}:${selection.ref}`,
            content: `[Error loading ${selection.type}:${selection.ref}]`,
            tokens: 20,
            metadata: { error: String(error) }
          })
        }
      }

      return fragments
    },

    // Only enable if there are selections
    enabled(ctx: AssemblyContext): boolean {
      return (ctx.selectedContext?.length ?? 0) > 0
    }
  }
}

/**
 * Resolve a context selection to a fragment
 */
async function resolveSelection(
  selection: ContextSelection,
  runtime: import('../../types/runtime.js').Runtime,
  config: { maxTokensPerFile: number; maxTokensPerMemory: number }
): Promise<ContextFragment | null> {
  const maxTokens = selection.maxTokens

  switch (selection.type) {
    case 'memory':
      return resolveMemorySelection(selection, runtime, maxTokens ?? config.maxTokensPerMemory)

    case 'file':
      return resolveFileSelection(selection, runtime, maxTokens ?? config.maxTokensPerFile)

    case 'messages':
      return resolveMessagesSelection(selection, runtime, maxTokens)

    case 'url':
      return resolveUrlSelection(selection, runtime, maxTokens)

    case 'custom':
      if (selection.resolve) {
        return selection.resolve(runtime)
      }
      return null

    default:
      console.warn(`[SelectedPhase] Unknown selection type: ${selection.type}`)
      return null
  }
}

/**
 * Resolve memory selection
 */
async function resolveMemorySelection(
  selection: ContextSelection,
  runtime: import('../../types/runtime.js').Runtime,
  maxTokens: number
): Promise<ContextFragment | null> {
  if (!runtime.memoryStorage) {
    return {
      source: `selected:memory:${selection.ref}`,
      content: `[Memory storage not available]`,
      tokens: 10
    }
  }

  // Parse namespace:key format
  const parts = selection.ref.split(':')
  const namespace = parts[0] ?? 'project'
  const keyParts = parts.slice(1)
  const key = keyParts.length > 0 ? keyParts.join(':') : namespace

  const item = await runtime.memoryStorage.get(
    keyParts.length > 0 ? namespace : 'project', // Default to 'project' namespace
    keyParts.length > 0 ? key : namespace
  )

  if (!item) {
    return {
      source: `selected:memory:${selection.ref}`,
      content: `[Memory key not found: ${selection.ref}]`,
      tokens: 15
    }
  }

  let content: string
  if (item.valueText) {
    content = `### Memory: ${item.key}\n\n${item.valueText}`
  } else if (typeof item.value === 'string') {
    content = `### Memory: ${item.key}\n\n${item.value}`
  } else {
    content = `### Memory: ${item.key}\n\n\`\`\`json\n${JSON.stringify(item.value, null, 2)}\n\`\`\``
  }

  // Truncate if needed
  const tokens = estimateTokens(content)
  if (tokens > maxTokens) {
    content = truncateToTokens(content, maxTokens)
  }

  return {
    source: `selected:memory:${selection.ref}`,
    content,
    tokens: Math.min(tokens, maxTokens),
    metadata: { key: item.key, namespace: item.namespace }
  }
}

/**
 * Resolve file selection
 */
async function resolveFileSelection(
  selection: ContextSelection,
  runtime: import('../../types/runtime.js').Runtime,
  maxTokens: number
): Promise<ContextFragment | null> {
  try {
    const result = await runtime.io.readFile(selection.ref)

    if (!result.success) {
      return {
        source: `selected:file:${selection.ref}`,
        content: `[File not found: ${selection.ref}]`,
        tokens: 15
      }
    }

    let content = `### File: ${selection.ref}\n\n\`\`\`\n${result.data}\n\`\`\``

    // Truncate if needed
    const tokens = estimateTokens(content)
    if (tokens > maxTokens) {
      content = truncateToTokens(content, maxTokens)
    }

    return {
      source: `selected:file:${selection.ref}`,
      content,
      tokens: Math.min(tokens, maxTokens),
      metadata: { path: selection.ref }
    }
  } catch (error) {
    return {
      source: `selected:file:${selection.ref}`,
      content: `[Error reading file: ${selection.ref}]`,
      tokens: 15
    }
  }
}

/**
 * Resolve messages selection
 * Format: "start-end" (e.g., "0-10" or "last-5")
 */
async function resolveMessagesSelection(
  selection: ContextSelection,
  runtime: import('../../types/runtime.js').Runtime,
  maxTokens?: number
): Promise<ContextFragment | null> {
  if (!runtime.messageStore) {
    return {
      source: `selected:messages:${selection.ref}`,
      content: `[Message store not available]`,
      tokens: 10
    }
  }

  // Parse range format
  const ref = selection.ref
  let startIdx = 0
  let endIdx = 10

  if (ref.startsWith('last-')) {
    const count = parseInt(ref.slice(5), 10)
    if (!isNaN(count)) {
      // Get total message count first
      const recentMsgs = await runtime.messageStore.getRecentMessages(runtime.sessionId, 1000)
      startIdx = Math.max(0, recentMsgs.length - count)
      endIdx = recentMsgs.length
    }
  } else if (ref.includes('-')) {
    const parts = ref.split('-')
    const start = parseInt(parts[0] ?? '0', 10)
    const end = parseInt(parts[1] ?? '10', 10)
    if (!isNaN(start) && !isNaN(end)) {
      startIdx = start
      endIdx = end
    }
  }

  const messages = await runtime.messageStore.getMessageRange(runtime.sessionId, startIdx, endIdx)

  if (messages.length === 0) {
    return {
      source: `selected:messages:${selection.ref}`,
      content: `[No messages in range: ${selection.ref}]`,
      tokens: 15
    }
  }

  // Format messages
  const formattedMsgs = messages.map(m => {
    const roleLabel = m.role.charAt(0).toUpperCase() + m.role.slice(1)
    return `**${roleLabel}**: ${m.content}`
  })

  let content = `### Messages ${startIdx}-${endIdx}\n\n${formattedMsgs.join('\n\n')}`

  // Truncate if needed
  const tokens = estimateTokens(content)
  if (maxTokens && tokens > maxTokens) {
    content = truncateToTokens(content, maxTokens)
  }

  return {
    source: `selected:messages:${selection.ref}`,
    content,
    tokens: maxTokens ? Math.min(tokens, maxTokens) : tokens,
    metadata: { range: [startIdx, endIdx] }
  }
}

/**
 * Resolve URL selection (placeholder - requires fetch capability)
 */
async function resolveUrlSelection(
  selection: ContextSelection,
  _runtime: import('../../types/runtime.js').Runtime,
  _maxTokens?: number
): Promise<ContextFragment | null> {
  // URL fetching would require network capability
  // For now, return a placeholder
  return {
    source: `selected:url:${selection.ref}`,
    content: `[URL fetching not implemented: ${selection.ref}]`,
    tokens: 15
  }
}

/**
 * Estimate token count
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 3)
}

/**
 * Truncate content to fit token limit
 */
function truncateToTokens(content: string, maxTokens: number): string {
  const maxChars = maxTokens * 3 - 30
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars) + '\n[...truncated]'
}
