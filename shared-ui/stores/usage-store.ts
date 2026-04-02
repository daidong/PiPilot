/**
 * Usage Store - Token usage and cost tracking with persistence
 *
 * Tracks token usage and costs for:
 * - Current run (resets when new run starts)
 * - Session totals (accumulates within app session)
 * - All-time totals (persisted by framework tracing, survives app restarts)
 */

import { create } from 'zustand'

/**
 * Usage event from agent:usage IPC
 */
export interface UsageEvent {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens?: number
  cost: number
  rawCost?: number
  billableCost?: number
  authMode?: 'api-key' | 'none'
  billingSource?: 'api-key' | 'none'
  cacheHitRate: number
}

/**
 * Run summary from agent:done IPC
 */
export interface RunSummary {
  totalTokens: number
  totalCost: number
  cacheHitRate: number
  callCount: number
}

/**
 * Persisted totals structure (from framework usage file)
 */
interface PersistedTotals {
  totals: {
    tokens: number
    promptTokens: number
    completionTokens?: number
    cachedTokens: number
    cacheWriteTokens?: number
    cost: number
    calls: number
  }
}

interface UsageState {
  // Current run (resets when new run starts)
  runPromptTokens: number
  runCompletionTokens: number
  runCachedTokens: number
  runCacheWriteTokens: number
  runTokens: number
  runCost: number
  runCacheHitRate: number
  runCallCount: number

  // Session totals (accumulates within app session, but also persisted)
  sessionTokens: number
  sessionCost: number
  sessionCalls: number

  // All-time totals (persisted by framework)
  allTimeTokens: number
  allTimePromptTokens: number
  allTimeCompletionTokens: number
  allTimeCachedTokens: number
  allTimeCacheWriteTokens: number
  allTimeCost: number
  allTimeBillableCost: number
  allTimeCalls: number
  billingSource: 'api-key' | 'none'

  // Actions
  recordCall: (event: UsageEvent) => void
  completeRun: (summary: RunSummary) => void
  resetRun: () => void
  resetSession: () => void
  loadPersisted: () => Promise<void>
  resetAllTime: () => void
}

const api = (window as any).api

async function loadFromFramework(): Promise<PersistedTotals | null> {
  try {
    const data = await api?.getUsageTotals?.()
    return data ?? null
  } catch (e) {
    console.warn('[usage-store] Failed to load persisted totals:', e)
    return null
  }
}

export const useUsageStore = create<UsageState>((set, get) => {
  return {
    // Current run
    runPromptTokens: 0,
    runCompletionTokens: 0,
    runCachedTokens: 0,
    runCacheWriteTokens: 0,
    runTokens: 0,
    runCost: 0,
    runCacheHitRate: 0,
    runCallCount: 0,

    // Session totals (start at zero; hydrated after project load)
    sessionTokens: 0,
    sessionCost: 0,
    sessionCalls: 0,

    // All-time totals (from framework persistence)
    allTimeTokens: 0,
    allTimePromptTokens: 0,
    allTimeCompletionTokens: 0,
    allTimeCachedTokens: 0,
    allTimeCacheWriteTokens: 0,
    allTimeCost: 0,
    allTimeBillableCost: 0,
    allTimeCalls: 0,
    billingSource: 'none',

    recordCall: (event: UsageEvent) => set((state) => {
      // Total tokens this call: prompt + completion + cached (all processed by LLM)
      const callTokens = event.promptTokens + event.completionTokens + event.cachedTokens
      const cacheWrite = event.cacheWriteTokens ?? 0
      const billableCost = event.billableCost ?? event.cost

      // Run-level weighted average cache hit rate
      const newRunPrompt = state.runPromptTokens + event.promptTokens
      const newRunCached = state.runCachedTokens + event.cachedTokens
      const totalRunInput = newRunPrompt + newRunCached
      const runCacheHitRate = totalRunInput > 0 ? newRunCached / totalRunInput : 0

      return {
        runPromptTokens: newRunPrompt,
        runCompletionTokens: state.runCompletionTokens + event.completionTokens,
        runCachedTokens: newRunCached,
        runCacheWriteTokens: state.runCacheWriteTokens + cacheWrite,
        runTokens: state.runTokens + callTokens,
        runCost: state.runCost + event.cost,
        runCacheHitRate,
        runCallCount: state.runCallCount + 1,
        // Session
        sessionTokens: state.sessionTokens + callTokens,
        sessionCost: state.sessionCost + event.cost,
        sessionCalls: state.sessionCalls + 1,
        // All-time
        allTimeTokens: state.allTimeTokens + callTokens,
        allTimePromptTokens: state.allTimePromptTokens + event.promptTokens,
        allTimeCompletionTokens: state.allTimeCompletionTokens + event.completionTokens,
        allTimeCachedTokens: state.allTimeCachedTokens + event.cachedTokens,
        allTimeCacheWriteTokens: state.allTimeCacheWriteTokens + cacheWrite,
        allTimeCost: state.allTimeCost + event.cost,
        allTimeBillableCost: state.allTimeBillableCost + billableCost,
        allTimeCalls: state.allTimeCalls + 1,
        billingSource: event.billingSource ?? state.billingSource
      }
    }),

    completeRun: (_summary: RunSummary) => {
      // Run is complete - don't reset, just keep the stats visible
      // The session/all-time totals are already accumulated in recordCall
    },

    // Reset run stats - called when a NEW run starts (not when old one ends)
    resetRun: () => set({
      runPromptTokens: 0,
      runCompletionTokens: 0,
      runCachedTokens: 0,
      runCacheWriteTokens: 0,
      runTokens: 0,
      runCost: 0,
      runCacheHitRate: 0,
      runCallCount: 0
    }),

    // Reset session stats (but keep all-time)
    resetSession: () => set({
      runPromptTokens: 0,
      runCompletionTokens: 0,
      runCachedTokens: 0,
      runCacheWriteTokens: 0,
      runTokens: 0,
      runCost: 0,
      runCacheHitRate: 0,
      runCallCount: 0,
      sessionTokens: 0,
      sessionCost: 0,
      sessionCalls: 0
    }),

    // Load persisted totals (called on app start)
    loadPersisted: async () => {
      const persisted = await loadFromFramework()
      if (persisted?.totals) {
        const t = persisted.totals
        set({
          allTimeTokens: t.tokens ?? 0,
          allTimePromptTokens: t.promptTokens ?? 0,
          allTimeCompletionTokens: t.completionTokens ?? 0,
          allTimeCachedTokens: t.cachedTokens ?? 0,
          allTimeCacheWriteTokens: t.cacheWriteTokens ?? 0,
          allTimeCost: t.cost ?? 0,
          allTimeBillableCost: t.cost ?? 0,
          allTimeCalls: t.calls ?? 0,
          billingSource: 'api-key',
          // Also restore to session totals
          sessionTokens: t.tokens ?? 0,
          sessionCost: t.cost ?? 0,
          sessionCalls: t.calls ?? 0
        })
      }
    },

    // Reset all-time totals (user-initiated)
    resetAllTime: () => {
      api?.resetUsageTotals?.().catch?.(() => {})
      set({
        runPromptTokens: 0,
        runCompletionTokens: 0,
        runCachedTokens: 0,
        runCacheWriteTokens: 0,
        runTokens: 0,
        runCost: 0,
        runCacheHitRate: 0,
        runCallCount: 0,
        sessionTokens: 0,
        sessionCost: 0,
        sessionCalls: 0,
        allTimeTokens: 0,
        allTimePromptTokens: 0,
        allTimeCompletionTokens: 0,
        allTimeCachedTokens: 0,
        allTimeCacheWriteTokens: 0,
        allTimeCost: 0,
        allTimeBillableCost: 0,
        billingSource: 'none',
        allTimeCalls: 0
      })
    }
  }
})
