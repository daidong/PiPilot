import React from 'react'
import { useImportStore } from '../../stores/import-store'

// ─── HeroIdle ─────────────────────────────────────────────────────────────
//
// Empty-state surface for the chat view. A single starter row that opens
// the BibTeX import wizard.
//
// Why only one starter (and not the prior three): the previous starters
// — "Understand this folder", "Start a literature review on …", "Capture
// a research note about …" — were essentially canned chat prompts. They
// added little over just typing into the input box, and the bulk-import
// path is the highest-value thing a first-time user can do (it's the
// only path that requires opening a modal rather than typing). Promoting
// it to be the sole rich CTA matches the Captain's "Lab Memory
// Quickstart" framing.
//
// Anti-refs obeyed: no icons, no cards, no centered hero, no Sparkles,
// no 2×2 grid, no marketing prompt. Left-aligned, two-line row, muted
// neutrals + accent-soft on hover. Same dialect as FolderGate RecentRow.

function StarterRow({ label, description, onActivate }: { label: string; description: string; onActivate: () => void }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      className="group relative w-full text-left flex flex-col gap-0.5 py-2.5 pl-4 pr-2 rounded-sm t-bg-hover transition-colors"
    >
      {/* Left accent bar on hover — same dialect as RecentRow in FolderGate
          and the wiki-row treatment in LiteratureView. */}
      <span
        aria-hidden
        className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-transparent group-hover:t-bg-accent-soft transition-colors"
      />
      <span className="text-[13px] t-text-secondary group-hover:t-text transition-colors leading-snug">
        {label}
      </span>
      <span className="text-[11px] t-text-muted leading-snug">
        {description}
      </span>
    </button>
  )
}

export function HeroIdle() {
  const openImportWizard = useImportStore((s) => s.openWizard)

  return (
    <div className="w-full max-w-lg px-8">
      {/* Section label — matches FolderGate's "Recent projects" treatment */}
      <div className="pl-4 mb-2 text-[10px] uppercase tracking-wider t-text-muted font-medium">
        Start
      </div>

      <div className="flex flex-col">
        <StarterRow
          label="Build a paper memory from existing files"
          description="Import a .bib export from Zotero / EndNote / Mendeley to populate the library."
          onActivate={openImportWizard}
        />
      </div>

      {/* Keyboard tips — deliberately minimal. Only surfaces features
          that are fully wired today: @ mentions and the send/newline
          bindings. The slash command palette is hidden until its
          backend is complete. */}
      <div className="mt-8 pl-4 flex flex-col gap-1.5 text-[10px] t-text-muted">
        <div className="flex items-center gap-2">
          <kbd className="inline-flex items-center px-1 py-0 rounded border t-border-subtle t-bg-elevated text-[9.5px] font-mono t-text-secondary leading-[1.4]">@</kbd>
          <span>mention a note, paper, or file</span>
        </div>
        <div className="flex items-center gap-2">
          <kbd className="inline-flex items-center px-1 py-0 rounded border t-border-subtle t-bg-elevated text-[9.5px] font-mono t-text-secondary leading-[1.4]">↵</kbd>
          <span>send</span>
          <span className="opacity-50" aria-hidden>·</span>
          <kbd className="inline-flex items-center px-1 py-0 rounded border t-border-subtle t-bg-elevated text-[9.5px] font-mono t-text-secondary leading-[1.4]">⇧↵</kbd>
          <span>newline</span>
        </div>
      </div>
    </div>
  )
}
