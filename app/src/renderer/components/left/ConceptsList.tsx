import React, { useState, useEffect } from 'react'
import { Network } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'

const api = (window as any).api

interface ConceptEntry {
  slug: string
  title: string
}

/**
 * ConceptsList — sidebar section showing wiki concept pages.
 * Only renders when the wiki has concept pages.
 */
export function ConceptsList() {
  const [concepts, setConcepts] = useState<ConceptEntry[]>([])
  const setSlug = useUIStore((s) => s.setWikiReaderSlug)
  const activeSlug = useUIStore((s) => s.wikiReaderSlug)

  useEffect(() => {
    api.wikiListPages?.().then((result: any) => {
      if (result?.concepts) setConcepts(result.concepts)
    }).catch(() => {})
  }, [])

  if (concepts.length === 0) return null

  return (
    <div className="space-y-1">
      <p className="text-[10px] t-text-accent-soft uppercase tracking-wider font-medium flex items-center gap-1.5">
        <Network size={10} />
        Concepts
      </p>
      {concepts.map((c) => (
        <button
          key={c.slug}
          onClick={() => setSlug(c.slug)}
          className={`w-full text-left flex items-center justify-between px-1 py-0.5 rounded transition-colors ${
            activeSlug === c.slug
              ? 'bg-[var(--color-accent-soft)]/10 t-text-accent'
              : 't-text-secondary hover:t-bg-hover'
          }`}
          title={c.title}
        >
          <span className="text-[11px] truncate">{c.title}</span>
        </button>
      ))}
    </div>
  )
}
