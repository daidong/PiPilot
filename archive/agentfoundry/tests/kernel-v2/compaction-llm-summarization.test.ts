/**
 * E2E test: LLM-driven compaction via CompactionEngineV2 + SummarizeFn
 *
 * Validates that:
 * 1. When llmSummarization=true and a summarizeFn is provided, it is called
 *    with the conversation text and its output is stored in the segment summary.
 * 2. When the summarizeFn throws, the engine falls back to heuristic summarization
 *    and still produces a valid segment.
 * 3. When llmSummarization=false (opt-out), summarizeFn is never called even if
 *    one is provided.
 * 4. The new default (llmSummarization=true) is reflected in resolveKernelV2Config.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

import { describe, it, expect, vi, type Mock } from 'vitest'

import { KernelV2Storage } from '../../src/kernel-v2/storage.js'
import { MemoryWriteGateV2 } from '../../src/kernel-v2/memory-write-gate-v2.js'
import { CompactionEngineV2, type SummarizeFn } from '../../src/kernel-v2/compaction-engine-v2.js'
import { resolveKernelV2Config } from '../../src/kernel-v2/defaults.js'

// Helpers

async function makeStorage(sessionId: string, turns = 5): Promise<[KernelV2Storage, string]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-comp-llm-'))
  const storage = new KernelV2Storage(dir)
  await storage.init()
  for (let i = 1; i <= turns; i++) {
    await storage.appendTurn(sessionId, { role: 'user', content: `Step ${i}: Analyse module-${i}.ts` })
    await storage.appendTurn(sessionId, { role: 'assistant', content: `Analysed module-${i}.ts. Found ${i} issue(s).` })
  }
  return [storage, dir]
}

function makeGate(storage: KernelV2Storage) {
  return new MemoryWriteGateV2(storage, { maxWritesPerTurn: 20, maxWritesPerSession: 500, preFlushReserve: 5 })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LLM-driven compaction (CompactionEngineV2)', () => {
  it('default config has llmSummarization=true', () => {
    const cfg = resolveKernelV2Config(undefined, 128_000, 'gpt-5.4')
    expect(cfg.compaction.llmSummarization).toBe(true)
  })

  it('can be opted out via config', () => {
    const cfg = resolveKernelV2Config(
      { compaction: { llmSummarization: false } },
      128_000,
      'gpt-5.4'
    )
    expect(cfg.compaction.llmSummarization).toBe(false)
  })

  it('calls summarizeFn and stores its output in the segment when llmSummarization=true', async () => {
    const SID = 'sess_llm_on'
    const [storage] = await makeStorage(SID)
    const gate = makeGate(storage)
    const cfg = resolveKernelV2Config({ compaction: { llmSummarization: true } }, 2000, 'gpt-5.4')

    const summarizeFn: Mock<SummarizeFn> = vi.fn(async (_text: string) =>
      '**Goal:** Analyse modules\n**Progress:** All 5 modules analysed\n**Remaining Work:** None'
    )

    const engine = new CompactionEngineV2(storage, gate, cfg, undefined, summarizeFn as SummarizeFn)
    const result = await engine.maybeCompact({
      sessionId: SID,
      promptTokens: 1900,
      protectedRecentTurns: 2
    })

    expect(result.compacted).toBe(true)
    expect(summarizeFn).toHaveBeenCalledOnce()

    // The conversation text passed to summarizeFn should contain turn content
    const callArg = summarizeFn.mock.calls[0]![0]
    expect(callArg).toContain('module-1.ts')
    expect(callArg).toContain('Analyse')

    // Segment summary should be the LLM output, not the heuristic fallback
    expect(result.segment!.summary).toBe(
      '**Goal:** Analyse modules\n**Progress:** All 5 modules analysed\n**Remaining Work:** None'
    )
  })

  it('falls back to heuristic summary when summarizeFn throws', async () => {
    const SID = 'sess_llm_fail'
    const [storage] = await makeStorage(SID)
    const gate = makeGate(storage)
    const cfg = resolveKernelV2Config({ compaction: { llmSummarization: true } }, 2000, 'gpt-5.4')

    const failingFn: SummarizeFn = vi.fn(async () => { throw new Error('LLM timeout') })
    const engine = new CompactionEngineV2(storage, gate, cfg, undefined, failingFn)

    const result = await engine.maybeCompact({
      sessionId: SID,
      promptTokens: 1900,
      protectedRecentTurns: 2
    })

    // Should still produce a segment (heuristic fallback)
    expect(result.compacted).toBe(true)
    expect(result.segment).toBeDefined()
    // Heuristic summary uses "- U: / A:" format
    expect(result.segment!.summary).toContain('- U:')
  })

  it('does NOT call summarizeFn when llmSummarization=false', async () => {
    const SID = 'sess_llm_off'
    const [storage] = await makeStorage(SID)
    const gate = makeGate(storage)
    const cfg = resolveKernelV2Config({ compaction: { llmSummarization: false } }, 2000, 'gpt-5.4')

    const summarizeFn: Mock<SummarizeFn> = vi.fn(async () => 'should never be called')
    const engine = new CompactionEngineV2(storage, gate, cfg, undefined, summarizeFn as SummarizeFn)

    const result = await engine.maybeCompact({
      sessionId: SID,
      promptTokens: 1900,
      protectedRecentTurns: 2
    })

    expect(result.compacted).toBe(true)
    expect(summarizeFn).not.toHaveBeenCalled()
    // Uses heuristic format
    expect(result.segment!.summary).toContain('- U:')
  })

  it('compaction prompt includes structured format instructions', async () => {
    const SID = 'sess_prompt_check'
    const [storage] = await makeStorage(SID, 6)
    const gate = makeGate(storage)
    const cfg = resolveKernelV2Config({ compaction: { llmSummarization: true } }, 2000, 'gpt-5.4')

    let receivedPrompt = ''
    const capturingFn: SummarizeFn = async (text) => {
      receivedPrompt = text
      return 'captured'
    }
    const engine = new CompactionEngineV2(storage, gate, cfg, undefined, capturingFn)
    await engine.maybeCompact({ sessionId: SID, promptTokens: 1900, protectedRecentTurns: 2 })

    // Prompt should include the structured format instructions
    expect(receivedPrompt).toContain('Goal:')
    expect(receivedPrompt).toContain('Progress:')
    expect(receivedPrompt).toContain('Remaining Work:')
    // And the actual conversation turns
    expect(receivedPrompt).toContain('User:')
    expect(receivedPrompt).toContain('Assistant:')
  })
})
