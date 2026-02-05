/**
 * Usage Store - Token usage and cost tracking with persistence
 *
 * Tracks token usage and costs for:
 * - Current run (resets when new run starts)
 * - Session totals (accumulates within app session)
 * - All-time totals (persisted to localStorage, survives app restarts)
 */

import { create } from 'zustand'

const STORAGE_KEY = 'personal-assistant:usage-totals'

/**
 * Usage event from agent:usage IPC
 */
export interface UsageEvent {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cost: number
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
 * Persisted totals structure
 */
interface PersistedTotals {
  tokens: number
  promptTokens: number
  cachedTokens: number
  cost: number
  calls: number
  lastUpdated: string
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

  // All-time totals (persisted to localStorage)
  allTimeTokens: number
  allTimePromptTokens: number
  allTimeCachedTokens: number
  allTimeCost: number
  allTimeCalls: number

  // Actions
  recordCall: (event: UsageEvent) => void
  completeRun: (summary: RunSummary) => void
  resetRun: () => void
  resetSession: () => void
  loadPersisted: () => void
  resetAllTime: () => void
}

/**
 * Load persisted totals from localStorage
 */
function loadFromStorage(): PersistedTotals | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (e) {
    console.warn('[usage-store] Failed to load persisted totals:', e)
  }
  return null
}

/**
 * Save totals to localStorage
 */
function saveToStorage(totals: PersistedTotals): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(totals))
  } catch (e) {
    console.warn('[usage-store] Failed to save totals:', e)
  }
}

export const useUsageStore = create<UsageState>((set, get) => {
  // Load persisted data on store creation
  const persisted = loadFromStorage()

  return {
    // Current run
    runTokens: 0,
    runCost: 0,
    runCacheHitRate: 0,
    runCallCount: 0,

    // Session totals (start from persisted values if available)
    sessionTokens: persisted?.tokens ?? 0,
    sessionCost: persisted?.cost ?? 0,
    sessionCalls: persisted?.calls ?? 0,

    // All-time totals (from persistence)
    allTimeTokens: persisted?.tokens ?? 0,
    allTimePromptTokens: persisted?.promptTokens ?? 0,
    allTimeCachedTokens: persisted?.cachedTokens ?? 0,
    allTimeCost: persisted?.cost ?? 0,
    allTimeCalls: persisted?.calls ?? 0,

    recordCall: (event: UsageEvent) => set((state) => {
      const newTokens = event.promptTokens + event.completionTokens
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
        allTimeCalls: state.allTimeCalls + 1
      }

      // Persist all-time totals
      saveToStorage({
        tokens: newState.allTimeTokens,
        promptTokens: newState.allTimePromptTokens,
        cachedTokens: newState.allTimeCachedTokens,
        cost: newState.allTimeCost,
        calls: newState.allTimeCalls,
        lastUpdated: new Date().toISOString()
      })

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
    loadPersisted: () => {
      const persisted = loadFromStorage()
      if (persisted) {
        set({
          allTimeTokens: persisted.tokens,
          allTimePromptTokens: persisted.promptTokens ?? 0,
          allTimeCachedTokens: persisted.cachedTokens ?? 0,
          allTimeCost: persisted.cost,
          allTimeCalls: persisted.calls,
          // Also restore to session totals
          sessionTokens: persisted.tokens,
          sessionCost: persisted.cost,
          sessionCalls: persisted.calls
        })
      }
    },

    // Reset all-time totals (user-initiated)
    resetAllTime: () => {
      localStorage.removeItem(STORAGE_KEY)
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
        allTimeCalls: 0
      })
    }
  }
})
