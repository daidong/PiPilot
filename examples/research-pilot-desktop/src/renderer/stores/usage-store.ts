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
    cachedTokens: number
    cost: number
    calls: number
  }
}

interface UsageState {
  // Current run (resets when new run starts)
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
  allTimeCachedTokens: number
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
    allTimeCachedTokens: 0,
    allTimeCost: 0,
    allTimeBillableCost: 0,
    allTimeCalls: 0,
    billingSource: 'none',

    recordCall: (event: UsageEvent) => set((state) => {
      const newTokens = event.promptTokens + event.completionTokens
      const billableCost = event.billableCost ?? event.cost
      const newState = {
        runTokens: state.runTokens + newTokens,
        runCost: state.runCost + event.cost,
        runCacheHitRate: event.cacheHitRate,
        runCallCount: state.runCallCount + 1,
        // Also accumulate to session/all-time
        sessionTokens: state.sessionTokens + newTokens,
        sessionCost: state.sessionCost + event.cost,
        sessionCalls: state.sessionCalls + 1,
        allTimeTokens: state.allTimeTokens + newTokens,
        allTimePromptTokens: state.allTimePromptTokens + event.promptTokens,
        allTimeCachedTokens: state.allTimeCachedTokens + event.cachedTokens,
        allTimeCost: state.allTimeCost + event.cost,
        allTimeBillableCost: state.allTimeBillableCost + billableCost,
        allTimeCalls: state.allTimeCalls + 1,
        billingSource: event.billingSource ?? state.billingSource
      }

      return newState
    }),

    completeRun: (_summary: RunSummary) => {
      // Run is complete - don't reset, just keep the stats visible
      // The session/all-time totals are already accumulated in recordCall
    },

    // Reset run stats - called when a NEW run starts (not when old one ends)
    resetRun: () => set({
      runTokens: 0,
      runCost: 0,
      runCacheHitRate: 0,
      runCallCount: 0
    }),

    // Reset session stats (but keep all-time)
    resetSession: () => set({
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
        set({
          allTimeTokens: persisted.totals.tokens ?? 0,
          allTimePromptTokens: persisted.totals.promptTokens ?? 0,
          allTimeCachedTokens: persisted.totals.cachedTokens ?? 0,
          allTimeCost: persisted.totals.cost ?? 0,
          allTimeBillableCost: persisted.totals.cost ?? 0,
          allTimeCalls: persisted.totals.calls ?? 0,
          billingSource: 'api-key',
          // Also restore to session totals
          sessionTokens: persisted.totals.tokens ?? 0,
          sessionCost: persisted.totals.cost ?? 0,
          sessionCalls: persisted.totals.calls ?? 0
        })
      }
    },

    // Reset all-time totals (user-initiated)
    resetAllTime: () => {
      api?.resetUsageTotals?.().catch?.(() => {})
      set({
        runTokens: 0,
        runCost: 0,
        runCacheHitRate: 0,
        runCallCount: 0,
        sessionTokens: 0,
        sessionCost: 0,
        sessionCalls: 0,
        allTimeTokens: 0,
        allTimePromptTokens: 0,
        allTimeCachedTokens: 0,
        allTimeCost: 0,
        allTimeBillableCost: 0,
        billingSource: 'none',
        allTimeCalls: 0
      })
    }
  }
})
