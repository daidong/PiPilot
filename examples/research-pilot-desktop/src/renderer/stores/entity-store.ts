import { create } from 'zustand'

export interface EntityItem {
  id: string
  type: 'note' | 'paper' | 'data' | 'fact'
  title: string
  pinned?: boolean
  projectCard?: boolean
  selectedForAI?: boolean
  reason?: string
  score?: number
  expiresAt?: string
  [key: string]: any
}

export interface FactItem {
  id: string
  namespace: string
  key: string
  value: any
  valueText?: string
  status: 'proposed' | 'active' | 'superseded' | 'deprecated'
  confidence: number
  provenance: { sourceType: string; sourceRef: string; traceId?: string; sessionId?: string }
  derivedFromArtifactIds?: string[]
  createdAt: string
  updatedAt: string
}

interface FocusEntry {
  refType: 'artifact' | 'fact' | 'task'
  refId: string
  reason: string
  score: number
  expiresAt: string
}

interface EntityState {
  notes: EntityItem[]
  papers: EntityItem[]
  data: EntityItem[]
  focus: EntityItem[]
  facts: FactItem[]
  // Legacy aliases (deprecated but kept for old components)
  projectCards: EntityItem[]
  workingSet: EntityItem[]
  pinned: EntityItem[]
  selected: EntityItem[]

  enrichingPapers: Set<string>
  setEnriching: (id: string) => void
  clearEnriching: (id: string) => void
  clearAllEnriching: () => void

  reset: () => void
  refreshAll: () => Promise<void>
  refreshFacts: () => Promise<void>
  promoteFact: (id: string) => Promise<void>
  demoteFact: (id: string) => Promise<void>
  toggleFocus: (id: string, options?: { reason?: string; ttl?: string }) => Promise<void>
  clearFocus: () => Promise<void>

  // Legacy aliases
  toggleProjectCard: (id: string) => Promise<void>
  toggleWorkingSet: (id: string) => Promise<void>
  togglePin: (id: string) => Promise<void>
  toggleSelect: (id: string) => Promise<void>

  renameNote: (id: string, newTitle: string) => Promise<void>
  updateEntity: (id: string, updates: { title?: string; content?: string }) => Promise<void>
  deleteEntity: (id: string) => Promise<void>
}

const api = (window as any).api

function stamp(items: any[], type: EntityItem['type']): EntityItem[] {
  return (items || []).map((i: any) => ({
    ...i,
    type,
    title: i.title || i.name || i.id
  }))
}

function sortByYear(items: EntityItem[]): EntityItem[] {
  return [...items].sort((a: any, b: any) => {
    if (!a.year && !b.year) return 0
    if (!a.year) return 1
    if (!b.year) return -1
    return b.year - a.year
  })
}

function resolveEntityById(entities: EntityItem[], refId: string): EntityItem | null {
  const exact = entities.find(item => item.id === refId)
  if (exact) return exact
  const prefix = entities.find(item => item.id.startsWith(refId) || refId.startsWith(item.id))
  return prefix ?? null
}

export const useEntityStore = create<EntityState>((set, get) => ({
  notes: [],
  papers: [],
  data: [],
  focus: [],
  facts: [],
  projectCards: [],
  workingSet: [],
  get pinned() {
    return get().focus
  },
  get selected() {
    return get().focus
  },
  enrichingPapers: new Set<string>(),

  setEnriching: (id: string) => set((state) => {
    const next = new Set(state.enrichingPapers)
    next.add(id)
    return { enrichingPapers: next }
  }),

  clearEnriching: (id: string) => set((state) => {
    const next = new Set(state.enrichingPapers)
    next.delete(id)
    return { enrichingPapers: next }
  }),

  clearAllEnriching: () => set({ enrichingPapers: new Set<string>() }),

  reset: () => set({
    notes: [],
    papers: [],
    data: [],
    focus: [],
    facts: [],
    projectCards: [],
    workingSet: [],
    enrichingPapers: new Set<string>()
  }),

  refreshAll: async () => {
    const [notesRaw, papersRaw, dataRaw, focusResult, factsRaw] = await Promise.all([
      api.listNotes(),
      api.listLiterature(),
      api.listData(),
      api.focusList(),
      api.factList()
    ])

    const notes = stamp(notesRaw, 'note')
    const papers = sortByYear(stamp(papersRaw, 'paper'))
    const data = stamp(dataRaw, 'data')
    const facts: FactItem[] = factsRaw || []
    const allArtifacts = [...notes, ...papers, ...data]
    const entries: FocusEntry[] = (focusResult?.entries || []) as FocusEntry[]

    const focus = entries
      .filter(entry => entry.refType === 'artifact')
      .map(entry => {
        const artifact = resolveEntityById(allArtifacts, entry.refId)
        if (!artifact) {
          return {
            id: entry.refId,
            type: 'data' as const,
            title: entry.refId,
            reason: entry.reason,
            score: entry.score,
            expiresAt: entry.expiresAt
          }
        }
        return {
          ...artifact,
          reason: entry.reason,
          score: entry.score,
          expiresAt: entry.expiresAt
        }
      })

    set({
      notes,
      papers,
      data,
      focus,
      facts,
      projectCards: focus,
      workingSet: focus
    })
  },

  refreshFacts: async () => {
    const factsRaw = await api.factList()
    set({ facts: factsRaw || [] })
  },

  promoteFact: async (id: string) => {
    await api.factPromote(id)
    await get().refreshFacts()
  },

  demoteFact: async (id: string) => {
    await api.factDemote(id)
    await get().refreshFacts()
  },

  toggleFocus: async (id: string, options?: { reason?: string; ttl?: string }) => {
    const inFocus = get().focus.some(item => item.id === id)
    if (inFocus) {
      await api.focusRemove(id)
    } else {
      await api.focusAdd({
        refType: 'artifact',
        refId: id,
        reason: options?.reason ?? 'manually selected for current work',
        source: 'manual',
        ttl: options?.ttl ?? '2h'
      })
    }
    await get().refreshAll()
  },

  clearFocus: async () => {
    await api.focusClear()
    await get().refreshAll()
  },

  // Legacy aliases to preserve old UI behavior.
  toggleProjectCard: async (id: string) => {
    await get().toggleFocus(id, { reason: 'promoted to focus (legacy project card)', ttl: 'today' })
  },
  toggleWorkingSet: async (id: string) => {
    await get().toggleFocus(id, { reason: 'selected for current turn', ttl: '2h' })
  },
  togglePin: async (id: string) => {
    await get().toggleProjectCard(id)
  },
  toggleSelect: async (id: string) => {
    await get().toggleWorkingSet(id)
  },

  renameNote: async (id: string, newTitle: string) => {
    await api.renameNote(id, newTitle)
    await get().refreshAll()
  },

  updateEntity: async (id: string, updates: { title?: string; content?: string }) => {
    await api.updateEntity(id, updates)
    await get().refreshAll()
  },

  deleteEntity: async (id: string) => {
    await api.deleteEntity(id)
    await get().refreshAll()
  }
}))
