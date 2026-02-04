/**
 * Usage Store - Token usage and cost tracking
 *
 * Tracks token usage and costs for both current run and session totals.
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

interface UsageState {
  // Current run
  runTokens: number
  runCost: number
  runCacheHitRate: number
  runCallCount: number

  // Session totals
  sessionTokens: number
  sessionCost: number

  // Actions
  recordCall: (event: UsageEvent) => void
  completeRun: (summary: RunSummary) => void
  resetRun: () => void
  resetSession: () => void
}

export const useUsageStore = create<UsageState>((set) => ({
  // Current run
  runTokens: 0,
  runCost: 0,
  runCacheHitRate: 0,
  runCallCount: 0,

  // Session totals
  sessionTokens: 0,
  sessionCost: 0,

  recordCall: (event: UsageEvent) => set((state) => ({
    runTokens: state.runTokens + event.promptTokens + event.completionTokens,
    runCost: state.runCost + event.cost,
    runCacheHitRate: event.cacheHitRate, // Latest rate
    runCallCount: state.runCallCount + 1
  })),

  completeRun: (summary: RunSummary) => set((state) => ({
    sessionTokens: state.sessionTokens + summary.totalTokens,
    sessionCost: state.sessionCost + summary.totalCost,
    // Keep run stats visible until next run starts
  })),

  resetRun: () => set({
    runTokens: 0,
    runCost: 0,
    runCacheHitRate: 0,
    runCallCount: 0
  }),

  resetSession: () => set({
    runTokens: 0,
    runCost: 0,
    runCacheHitRate: 0,
    runCallCount: 0,
    sessionTokens: 0,
    sessionCost: 0
  })
}))
