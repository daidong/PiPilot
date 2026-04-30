/**
 * Provenance store — Audit tab state.
 *
 * Holds the current project's provenance graph (nodes + edges) loaded from
 * the main process via IPC. Phase 1: read-only. Phase 2 will add audit-run
 * orchestration and findings.
 */

import { create } from 'zustand'

const api = (window as any).api

export interface ProvenanceNode {
  id: string
  kind: 'memory-artifact' | 'workspace-file' | 'computation' | 'draft' | 'audit-report'
  ref: any
  label: string
  createdAt: string
  lastSeenAt?: string
  snapshot?: { contentHash: string; sizeBytes: number; snapshotted: boolean; oversizeSkipped: boolean }
  drift?: { observedHash: string; observedAt: string }
  toolCall?: { name: string; parametersHash: string; parametersRef: string }
  agentTurn?: { sessionId: string; turnIndex: number; model: string }
}

export interface ProvenanceEdge {
  from: string
  to: string
  role: 'input' | 'code' | 'parameter' | 'cited-by' | 'derived-from'
}

interface ProvenanceState {
  enabled: boolean | null      // null = not yet probed
  loading: boolean
  error: string | null
  nodes: ProvenanceNode[]
  edges: ProvenanceEdge[]
  selectedNodeId: string | null

  probeEnabled: () => Promise<void>
  loadGraph: () => Promise<void>
  selectNode: (id: string | null) => void
}

export const useProvenanceStore = create<ProvenanceState>((set, get) => ({
  enabled: null,
  loading: false,
  error: null,
  nodes: [],
  edges: [],
  selectedNodeId: null,

  probeEnabled: async () => {
    try {
      const r = await api?.isProvenanceEnabled?.()
      set({ enabled: !!r?.enabled })
    } catch {
      set({ enabled: false })
    }
  },

  loadGraph: async () => {
    if (get().enabled === null) await get().probeEnabled()
    if (!get().enabled) {
      set({ nodes: [], edges: [], error: null })
      return
    }
    set({ loading: true, error: null })
    try {
      const r = await api?.provenanceGetGraph?.()
      if (r?.success) {
        set({ nodes: r.nodes ?? [], edges: r.edges ?? [], loading: false })
      } else {
        set({ error: r?.error ?? 'Failed to load provenance graph', loading: false })
      }
    } catch (err: any) {
      set({ error: err?.message ?? 'Failed to load provenance graph', loading: false })
    }
  },

  selectNode: (id) => set({ selectedNodeId: id })
}))
