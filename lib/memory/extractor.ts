/**
 * Auto-Memory Background Extractor (Phase 2)
 *
 * Runs after each chat() turn (fire-and-forget) to automatically extract
 * memory-worthy information from the conversation.
 *
 * Gated by RESEARCH_COPILOT_AUTO_EXTRACT=1 (default OFF).
 * Uses completeSimple() with the main model's system prompt for prompt cache hits.
 */

import type { Model, TextContent } from '@mariozechner/pi-ai'
import { completeSimple } from '@mariozechner/pi-ai'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import {
  type MemoryType,
  ensureMemoryDir,
  memoryFilename,
  writeMemoryFile,
  listMemoryFiles,
  updateAgentMdIndex,
  type MemoryEntry
} from './memory-utils.js'

export interface ExtractionConfig {
  projectPath: string
  model: Model<any>
  apiKey: string
  systemPrompt: string
  debug?: boolean
}

interface ExtractedMemory {
  type: MemoryType
  name: string
  description: string
  content: string
}

const VALID_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference']

const EXTRACTION_PROMPT = `Analyze the recent conversation above and extract information worth remembering across sessions.

Rules:
- Only extract DURABLE, IMPORTANT information — things a future session would need.
- Types: "user" (preferences/background), "feedback" (behavior corrections), "project" (decisions/deadlines), "reference" (external pointers).
- Ignore text inside "[Previous conversation summary]" or "[Session context]" markers — that is old context, not new information.
- Do NOT extract: routine task results, ephemeral details, things already in workspace files.
- Each memory should be atomic — one concept per entry.
- If nothing is worth saving, return an empty array.

Return ONLY a JSON array (no markdown fences, no explanation):
[{"type":"user|feedback|project|reference","name":"short-name","description":"one line","content":"full text"}]
Or: []`

/**
 * Convert AgentMessage[] to simple {role, content} pairs for completeSimple().
 * Truncates long tool results to keep token count reasonable.
 */
function simplifyMessages(
  messages: AgentMessage[],
  maxMessages: number
): Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }> {
  const recent = messages.slice(-maxMessages)
  const result: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }> = []

  for (const msg of recent) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue

    let content = ''
    if (typeof msg.content === 'string') {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'type' in block) {
          if (block.type === 'text' && 'text' in block) {
            const text = (block as any).text as string
            content += text.length > 500 ? text.slice(0, 500) + '...[truncated]' : text
            content += '\n'
          } else if (block.type === 'tool_use' && 'name' in block) {
            content += `[Called ${(block as any).name}]\n`
          }
        }
      }
    }

    content = content.trim()
    if (content) {
      result.push({
        role: msg.role as 'user' | 'assistant',
        content: content.slice(0, 2000),
        timestamp: Date.now()
      })
    }
  }

  return result
}

/**
 * Check if the agent called save-memory during the most recent turn.
 * Walk backwards from the end until we hit a user message.
 */
function agentCalledSaveMemoryThisTurn(messages: AgentMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user') break
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'type' in block && block.type === 'tool_use') {
          if ((block as any).name === 'save-memory') return true
        }
      }
    }
  }
  return false
}

/**
 * Maybe extract memories from the conversation. Fire-and-forget.
 *
 * Gates: env var → turn frequency → mutex (agent already saved this turn).
 */
export async function maybeExtractMemories(
  config: ExtractionConfig,
  messages: AgentMessage[],
  turnCount: number,
  extractEveryN: number = 3
): Promise<void> {
  if (process.env.RESEARCH_COPILOT_AUTO_EXTRACT === '0') return
  if (turnCount % extractEveryN !== 0) return
  if (agentCalledSaveMemoryThisTurn(messages)) {
    if (config.debug) console.log('[Extractor] Skipped — agent called save-memory this turn')
    return
  }

  try {
    const simplified = simplifyMessages(messages, 20)
    if (simplified.length < 2) return // need at least a user+assistant pair

    simplified.push({
      role: 'user',
      content: EXTRACTION_PROMPT,
      timestamp: Date.now()
    })

    const result = await completeSimple(config.model, {
      systemPrompt: config.systemPrompt,
      messages: simplified
    }, {
      maxTokens: 1024,
      apiKey: config.apiKey
    })

    const textContent = result.content.find((c): c is TextContent => c.type === 'text')
    const text = textContent?.text?.trim() ?? ''
    if (!text || text === '[]') return

    // Parse JSON — handle optional markdown fences
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\[[\s\S]*?\])/)
    const jsonStr = jsonMatch?.[1]?.trim() ?? text
    const extracted: ExtractedMemory[] = JSON.parse(jsonStr)

    if (!Array.isArray(extracted) || extracted.length === 0) return

    ensureMemoryDir(config.projectPath)

    let written = 0
    for (const mem of extracted) {
      if (!mem.type || !mem.name || !mem.content) continue
      if (!VALID_TYPES.includes(mem.type as MemoryType)) continue

      const entry: MemoryEntry = {
        frontmatter: {
          name: mem.name,
          description: (mem.description || mem.content.slice(0, 120)).replace(/\n/g, ' '),
          type: mem.type as MemoryType
        },
        content: mem.content,
        filename: memoryFilename(mem.type as MemoryType, mem.name)
      }
      writeMemoryFile(config.projectPath, entry)
      written++
    }

    if (written > 0) {
      const allEntries = listMemoryFiles(config.projectPath)
      updateAgentMdIndex(config.projectPath, allEntries)
      if (config.debug) {
        console.log(`[Extractor] Saved ${written} memories from conversation`)
      }
    }
  } catch (err) {
    if (config.debug) {
      console.warn('[Extractor] Failed:', err)
    }
  }
}
