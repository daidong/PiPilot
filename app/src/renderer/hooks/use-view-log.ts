/**
 * useViewLog — emit telemetry view-log events from any renderer surface (P2.4).
 *
 * The view log captures passive observations: artifact opens, summary scrolls,
 * memory peeks. Layer 3 reads this alongside the trace to classify what the
 * user did between turns (spec §8.4).
 *
 * Returns a `recordView(target, op, durationMs?)` function — fire-and-forget.
 * Caller may also use `recordTimedView(target)` to bracket an interaction:
 * call once on enter, once on leave, the hook computes durationMs.
 *
 * Errors swallowed: telemetry must never break the UI. When telemetry is
 * disabled at the project level, the IPC handler returns
 * `{ success: false, reason: 'tracing-disabled' }` and we silently drop.
 */

import { useCallback, useRef } from 'react'

const api = (typeof window !== 'undefined' ? (window as any).api : undefined) as
  | {
      telemetryViewLog?: (payload: {
        viewId: string
        target: { kind: 'artifact' | 'memory' | 'trace' | 'session-summary'; id: string }
        op: 'view' | 'hover' | 'scroll' | 'dismiss'
        durationMs?: number
        turnId?: string
      }) => Promise<{ success: boolean; reason?: string; error?: string }>
    }
  | undefined

export interface ViewTarget {
  kind: 'artifact' | 'memory' | 'trace' | 'session-summary'
  id: string
}

export type ViewOp = 'view' | 'hover' | 'scroll' | 'dismiss'

function newViewId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function useViewLog() {
  // Track the last enter timestamp keyed by `${kind}:${id}` so leave events
  // can compute durationMs locally without the caller bookkeeping it.
  const enterTimes = useRef<Map<string, number>>(new Map())

  const recordView = useCallback(
    async (target: ViewTarget, op: ViewOp = 'view', durationMs?: number, turnId?: string) => {
      if (!api?.telemetryViewLog) return
      try {
        await api.telemetryViewLog({
          viewId: newViewId(),
          target,
          op,
          durationMs,
          turnId
        })
      } catch {
        // Telemetry must never break UI — drop silently.
      }
    },
    []
  )

  /**
   * Bracket a sustained interaction. Call `enter()` when the user opens / focuses
   * the surface; call the returned `leave()` when they navigate away.
   * The hook computes durationMs and emits `view` (default) on leave.
   */
  const recordTimedView = useCallback(
    (target: ViewTarget, op: ViewOp = 'view') => {
      const key = `${target.kind}:${target.id}`
      enterTimes.current.set(key, performance.now())
      return () => {
        const start = enterTimes.current.get(key)
        if (start === undefined) return
        enterTimes.current.delete(key)
        const durationMs = Math.round(performance.now() - start)
        void recordView(target, op, durationMs)
      }
    },
    [recordView]
  )

  return { recordView, recordTimedView }
}
