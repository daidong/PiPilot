import { create } from 'zustand'

export interface EntityItem {
  id: string
  type: 'note' | 'doc' | 'todo' | 'mail' | 'calendar' | 'fact'
  title: string
  focusSource?: 'explicit' | 'continuity' | 'retrieval' | 'index'
  focusReason?: string
  focusScore?: number
  focusRequestedShape?: string
  status?: 'pending' | 'completed'
  completedAt?: string
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
  docs: EntityItem[]
  todos: EntityItem[]
  mail: EntityItem[]
  calendar: EntityItem[]
  focus: EntityItem[]
  runtimeFocus: EntityItem[]
  facts: FactItem[]

  reset: () => void
  refreshAll: () => Promise<void>
  refreshFacts: () => Promise<void>
  setRuntimeFocus: (items: EntityItem[]) => void
  promoteFact: (id: string) => Promise<void>
  demoteFact: (id: string) => Promise<void>
  toggleFocus: (id: string, options?: { reason?: string; ttl?: string }) => Promise<void>
  clearFocus: () => Promise<void>

  toggleTodoComplete: (id: string) => Promise<void>
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

function resolveEntityById(entities: EntityItem[], refId: string): EntityItem | null {
  const exact = entities.find(item => item.id === refId)
  if (exact) return exact
  const prefix = entities.find(item => item.id.startsWith(refId) || refId.startsWith(item.id))
  return prefix ?? null
}

export const useEntityStore = create<EntityState>((set, get) => ({
  notes: [],
  docs: [],
  todos: [],
  mail: [],
  calendar: [],
  focus: [],
  runtimeFocus: [],
  facts: [],

  reset: () => set({
    notes: [],
    docs: [],
    todos: [],
    mail: [],
    calendar: [],
    focus: [],
    runtimeFocus: [],
    facts: []
  }),

  refreshAll: async () => {
    try {
      const [
        notesRaw,
        docsRaw,
        todosRaw,
        mailRaw,
        calendarRaw,
        focusResult,
        factsRaw
      ] = await Promise.all([
        api.listNotes(),
        api.listDocs(),
        api.listTodos(),
        api.listMail?.() ?? [],
        api.listCalendar?.() ?? [],
        api.focusList?.() ?? { entries: [] },
        api.factList?.() ?? []
      ])

      const notes = stamp(notesRaw, 'note')
      const docs = stamp(docsRaw, 'doc')
      const todos = stamp(todosRaw, 'todo')
      const mail = stamp(mailRaw, 'mail')
      const calendar = stamp(calendarRaw, 'calendar')
      const facts: FactItem[] = factsRaw || []
      const allArtifacts = [...notes, ...docs, ...todos, ...mail, ...calendar]
      const entries: FocusEntry[] = (focusResult?.entries || []) as FocusEntry[]

      const focus = entries
        .filter(entry => entry.refType === 'artifact')
        .map(entry => {
          const artifact = resolveEntityById(allArtifacts, entry.refId)
          if (!artifact) {
            return {
              id: entry.refId,
              type: 'doc' as const,
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

      const runtimeFocus = get().runtimeFocus
      set({
        notes,
        docs,
        todos,
        mail,
        calendar,
        focus,
        facts,
        runtimeFocus
      })
    } catch (err) {
      console.warn('[entity-store] refreshAll failed:', err)
    }
  },

  refreshFacts: async () => {
    const factsRaw = await api.factList?.()
    set({ facts: factsRaw || [] })
  },

  setRuntimeFocus: (items: EntityItem[]) => {
    set({ runtimeFocus: items || [] })
  },

  promoteFact: async (id: string) => {
    await api.factPromote?.(id)
    await get().refreshFacts()
  },

  demoteFact: async (id: string) => {
    await api.factDemote?.(id)
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
    await api.focusClear?.()
    await get().refreshAll()
  },

  toggleTodoComplete: async (id: string) => {
    await api.toggleTodoComplete(id)
    const todosRaw = await api.listTodos()
    set({ todos: stamp(todosRaw, 'todo') })
  },

  deleteEntity: async (id: string) => {
    await api.deleteEntity(id)
    await get().refreshAll()
  }
}))
