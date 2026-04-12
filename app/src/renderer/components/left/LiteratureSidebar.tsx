import React, { useMemo } from 'react'
import {
  Search,
  Zap,
  GitBranch,
  RefreshCw,
  BarChart3,
} from 'lucide-react'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'
import { useUIStore } from '../../stores/ui-store'
import { useChatStore } from '../../stores/chat-store'
import { ConceptsList } from './ConceptsList'

function QuickAction({
  icon: Icon,
  label,
  description,
  onClick,
  disabled
}: {
  icon: React.ElementType
  label: string
  description: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left flex items-start gap-2.5 px-3 py-2 rounded-lg transition-colors hover:bg-[var(--color-accent-soft)]/8 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <div className="shrink-0 mt-0.5 w-6 h-6 rounded-md flex items-center justify-center bg-[var(--color-accent-soft)]/10">
        <Icon size={13} className="t-text-accent" />
      </div>
      <div className="min-w-0">
        <p className="text-xs t-text font-medium">{label}</p>
        <p className="text-[10px] t-text-muted leading-tight mt-0.5">{description}</p>
      </div>
    </button>
  )
}

function GapAlerts({ papers }: { papers: EntityItem[] }) {
  const gaps = useMemo(() => {
    const topicScores = new Map<string, { total: number; count: number }>()
    for (const p of papers) {
      const topic = (p.subTopic as string) || ''
      if (!topic) continue
      const score = (p.relevanceScore as number) || 0
      const existing = topicScores.get(topic) || { total: 0, count: 0 }
      existing.total += score
      existing.count += 1
      topicScores.set(topic, existing)
    }

    const weak: string[] = []
    for (const [topic, { total, count }] of topicScores) {
      const avg = total / count
      if (avg < 6 || count < 2) {
        weak.push(topic)
      }
    }
    return weak.slice(0, 5)
  }, [papers])

  if (gaps.length === 0) return null

  return (
    <div className="space-y-1">
      <p className="text-[10px] t-text-muted uppercase tracking-wider font-medium">Coverage Gaps</p>
      {gaps.map((topic) => (
        <div key={topic} className="flex items-center gap-1.5 px-1">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
          <span className="text-[11px] t-text-secondary truncate">{topic}</span>
        </div>
      ))}
    </div>
  )
}

const CORE_FIELDS = ['title', 'authors', 'year', 'venue', 'abstract', 'doi', 'citationCount'] as const

function countCoreFields(paper: EntityItem): number {
  let count = 0
  for (const field of CORE_FIELDS) {
    const val = (paper as any)[field]
    if (val !== undefined && val !== null && val !== '') {
      if (Array.isArray(val) && val.length === 0) continue
      count++
    }
  }
  return count
}

export function LiteratureSidebar() {
  const papers = useEntityStore((s) => s.papers)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const setCenterView = useUIStore((s) => s.setCenterView)

  const allPapersEnriched = useMemo(
    () => papers.length > 0 && papers.every((p) => countCoreFields(p) >= 5),
    [papers]
  )

  const sendToChat = (text: string) => {
    setCenterView('chat')
    // Small delay to let view switch render, then focus and prefill
    setTimeout(() => {
      const inputEl = document.querySelector<HTMLTextAreaElement>('[data-chat-input]')
      if (inputEl) {
        inputEl.value = text
        inputEl.focus()
        inputEl.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }, 100)
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Quick Actions */}
      <div className="px-2 pt-2 pb-2 space-y-0.5">
        <p className="text-[10px] t-text-accent-soft uppercase tracking-wider px-3 pb-1 font-medium">
          Quick Actions
        </p>
        <QuickAction
          icon={Search}
          label="Deep Search"
          description="Comprehensive multi-source literature search"
          onClick={() => sendToChat('Please do a deep literature search on ')}
          disabled={isStreaming}
        />
        <QuickAction
          icon={Zap}
          label="Quick Update"
          description="Fill gaps in existing coverage"
          onClick={() => sendToChat('Please do a quick literature update to fill gaps in ')}
          disabled={isStreaming}
        />
        <QuickAction
          icon={GitBranch}
          label="Citation Chain"
          description="Explore references & citations of a paper"
          onClick={() => sendToChat('Please trace the citation chain for ')}
          disabled={isStreaming}
        />
        <QuickAction
          icon={RefreshCw}
          label="Enrich All"
          description={allPapersEnriched ? "All papers already have complete metadata" : "Batch-update metadata for all papers"}
          onClick={async () => {
            const api = (window as any).api
            await api.enrichAllPapers(papers.map((p: any) => p.id))
          }}
          disabled={isStreaming || papers.length === 0 || allPapersEnriched}
        />
      </div>

      {/* Divider */}
      <div className="mx-3 border-t t-border" />

      {/* Concepts & Gaps */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        <ConceptsList />
        <GapAlerts papers={papers} />

        {papers.length === 0 && (
          <div className="text-center py-6">
            <BarChart3 size={24} className="mx-auto mb-2 t-text-muted opacity-30" />
            <p className="text-xs t-text-muted">
              No papers yet. Use Quick Actions to start searching.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
