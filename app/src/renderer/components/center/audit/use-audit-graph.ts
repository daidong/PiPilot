/**
 * Audit graph loader.
 *
 * Fetches the projected provenance graph from the main process via IPC.
 * Re-runs when the user manually refreshes; we do NOT subscribe to live
 * telemetry events here. The graph is a snapshot taken when the user
 * opened the tab (or hit refresh) — fine for audit, since the goal is
 * to inspect what *did* happen, not what's happening now.
 */

import { useCallback, useEffect, useState } from 'react'
import type { AuditGraph } from '../../../../../../lib/audit-graph/index'

const api = (window as any).api

type Presence = {
  present: boolean
  reason?: 'no-root' | 'no-traces-dir' | 'no-span-files' | 'no-spans'
  spanFileCount: number
}

export interface AuditGraphState {
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  presence: Presence | null
  graph: AuditGraph | null
  error: string | null
  reload: () => void
}

export function useAuditGraph(active: boolean): AuditGraphState {
  const [status, setStatus] = useState<AuditGraphState['status']>('idle')
  const [presence, setPresence] = useState<Presence | null>(null)
  const [graph, setGraph] = useState<AuditGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setStatus('loading')
    setError(null)
    ;(async () => {
      try {
        const res = await api?.auditGetGraph?.()
        if (cancelled) return
        if (!res) {
          setStatus('error')
          setError('IPC unavailable')
          return
        }
        setPresence(res.presence)
        if (!res.presence?.present || !res.graph) {
          setGraph(null)
          setStatus('empty')
        } else {
          setGraph(res.graph)
          setStatus('ready')
        }
      } catch (e) {
        if (!cancelled) {
          setStatus('error')
          setError(String(e))
        }
      }
    })()
    return () => { cancelled = true }
  }, [active, nonce])

  return { status, presence, graph, error, reload }
}
