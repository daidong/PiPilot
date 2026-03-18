import { countTokens } from '../utils/tokenizer.js'
import { KernelV2Storage } from './storage.js'
import type {
  KernelV2ResolvedConfig,
  KernelV2TelemetryEvent,
  V2CompactSegment,
  V2MemoryWriteCandidate,
  V2TurnRecord
} from './types.js'
import { MemoryWriteGateV2 } from './memory-write-gate-v2.js'

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

function splitByLogicalTurn(turns: V2TurnRecord[]): V2TurnRecord[][] {
  const grouped: V2TurnRecord[][] = []
  let current: V2TurnRecord[] = []

  for (const t of turns) {
    if (t.role === 'user') {
      if (current.length > 0) grouped.push(current)
      current = [t]
      continue
    }

    if (current.length === 0) {
      continue
    }
    current.push(t)
  }

  if (current.length > 0) grouped.push(current)
  return grouped
}

function extractReplayRefs(compacted: V2TurnRecord[]): Array<{ type: 'path' | 'url' | 'id'; value: string }> {
  const refs = new Map<string, { type: 'path' | 'url' | 'id'; value: string }>()
  for (const t of compacted) {
    const urls = t.content.match(/https?:\/\/\S+/g) ?? []
    for (const u of urls) {
      refs.set(`url:${u}`, { type: 'url', value: u })
    }

    const pathMatches = t.content.match(/[A-Za-z0-9._\/-]+\.[A-Za-z0-9]+(?::\d+)?/g) ?? []
    for (const p of pathMatches) {
      if (p.startsWith('http')) continue
      refs.set(`path:${p}`, { type: 'path', value: p })
    }

    const idMatches = t.content.match(/\b(?:task|turn|mem|seg|proj)_[a-z0-9_]+\b/g) ?? []
    for (const id of idMatches) {
      refs.set(`id:${id}`, { type: 'id', value: id })
    }
  }

  if (refs.size === 0 && compacted[0]) {
    refs.set(`id:${compacted[0].id}`, { type: 'id', value: compacted[0].id })
  }

  return [...refs.values()].slice(0, 20)
}

/**
 * Optional LLM-powered summarization function.
 * Receives a plain-text representation of the conversation turns to be compacted
 * and returns a structured summary string.
 */
export type SummarizeFn = (conversationText: string) => Promise<string>

const COMPACTION_PROMPT = `You are a context compaction assistant. The conversation below is about to be compressed.

Create a concise structured summary that preserves all critical information needed to continue the work:

## Summary Format
**Goal:** (one sentence describing the overall objective)
**Progress:** (what has been accomplished)
**Key Decisions:** (important choices made and why)
**Files Modified/Read:** (list any relevant file paths)
**Remaining Work:** (what still needs to be done)
**Important Context:** (any other facts the agent must remember)

Keep the summary under 600 tokens. Be specific, not generic.`

export class CompactionEngineV2 {
  constructor(
    private readonly storage: KernelV2Storage,
    private readonly gate: MemoryWriteGateV2,
    private readonly config: KernelV2ResolvedConfig,
    private readonly telemetry?: (event: KernelV2TelemetryEvent) => void,
    private readonly summarizeFn?: SummarizeFn
  ) {}

  private emit(event: string, payload: Record<string, unknown>, message: string): void {
    this.telemetry?.({ event, payload, message })
  }

  shouldCompact(promptTokens: number): boolean {
    if (!this.config.compaction.enabled) return false
    const ratio = this.config.contextWindow > 0 ? (promptTokens / this.config.contextWindow) : 0
    return ratio >= this.config.budget.softThreshold
  }

  async maybeCompact(params: {
    sessionId: string
    promptTokens: number
    protectedRecentTurns: number
    preFlushCandidates?: V2MemoryWriteCandidate[]
  }): Promise<{ compacted: boolean; segment?: V2CompactSegment }> {
    if (!this.shouldCompact(params.promptTokens)) {
      return { compacted: false }
    }

    const turns = await this.storage.getSessionTurns(params.sessionId)
    const grouped = splitByLogicalTurn(turns)
    if (grouped.length <= params.protectedRecentTurns) {
      return { compacted: false }
    }

    if (this.config.compaction.preFlush.enabled) {
      this.emit('compaction.preflush.triggered', { sessionId: params.sessionId }, `preflush session=${params.sessionId}`)
      const candidates = params.preFlushCandidates ?? []
      for (const candidate of candidates) {
        await this.gate.writeCandidate(candidate, params.sessionId, 'preflush')
      }
    }

    const compactable = grouped.slice(0, Math.max(0, grouped.length - params.protectedRecentTurns))
    const flat = compactable.flat()
    if (flat.length === 0) {
      return { compacted: false }
    }

    const turnRange: [number, number] = [flat[0]!.index, flat[flat.length - 1]!.index]

    // Build summary — LLM-powered when configured, otherwise heuristic
    let summaryText: string
    const useLLM = this.config.compaction.llmSummarization && this.summarizeFn
    if (useLLM) {
      try {
        const conversationText = compactable.map(turn => {
          return turn.map(t => {
            const roleLabel = t.role === 'user' ? 'User' : t.role === 'assistant' ? 'Assistant' : 'Tool'
            return `${roleLabel}: ${t.content.slice(0, 800)}`
          }).join('\n')
        }).join('\n\n---\n\n')
        summaryText = await this.summarizeFn!(`${COMPACTION_PROMPT}\n\n## Conversation\n${conversationText}`)
        this.emit('compaction.llm_summary.success', { sessionId: params.sessionId, turns: flat.length }, `llm-summary session=${params.sessionId}`)
      } catch (err: unknown) {
        // Fall back to heuristic on LLM failure
        const msg = err instanceof Error ? err.message : String(err)
        this.emit('compaction.llm_summary.failed', { sessionId: params.sessionId, error: msg }, `llm-summary-failed session=${params.sessionId}`)
        summaryText = compactable.slice(-20).map(turn => {
          const user = turn.find(t => t.role === 'user')
          const assistant = turn.find(t => t.role === 'assistant')
          return `- U: ${user?.content.slice(0, 120) ?? ''}\n  A: ${assistant?.content.slice(0, 120) ?? ''}`
        }).join('\n')
      }
    } else {
      summaryText = compactable.slice(-20).map(turn => {
        const user = turn.find(t => t.role === 'user')
        const assistant = turn.find(t => t.role === 'assistant')
        return `- U: ${user?.content.slice(0, 120) ?? ''}\n  A: ${assistant?.content.slice(0, 120) ?? ''}`
      }).join('\n')
    }

    const replayRefs = extractReplayRefs(flat)
    if (this.config.compaction.requireReplayRefs && replayRefs.length === 0) {
      this.emit('compaction.replay_contract.failed', { sessionId: params.sessionId, turnRange }, `replay-contract-failed session=${params.sessionId}`)
      return { compacted: false }
    }

    const segment: V2CompactSegment = {
      id: generateId('seg'),
      sessionId: params.sessionId,
      turnRange,
      summary: summaryText,
      replayRefs,
      createdAt: new Date().toISOString()
    }

    await this.storage.appendCompactSegment(segment)

    this.emit('compaction.segment.created', {
      sessionId: params.sessionId,
      segmentId: segment.id,
      turnRange,
      replayRefs: replayRefs.length,
      savedApproxTokens: countTokens(summaryText)
    }, `segment-created id=${segment.id} turns=${turnRange[0]}-${turnRange[1]}`)

    return { compacted: true, segment }
  }
}
