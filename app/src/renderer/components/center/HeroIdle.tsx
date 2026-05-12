import React from 'react'
import { ArrowRight } from 'lucide-react'
import { useImportStore } from '../../stores/import-store'

// ─── HeroIdle ─────────────────────────────────────────────────────────────
//
// Empty-state surface for the chat view. A single, visually obvious CTA
// that opens the BibTeX import wizard.
//
// Why a single button-styled CTA instead of the prior list of muted
// starter rows:
//   - The bulk-import path is the highest-value thing a first-time user
//     can do (it's the only path that requires opening a modal rather
//     than typing into the chat).
//   - The prior starters ("Understand this folder", "Start a literature
//     review on …", "Capture a research note about …") were canned chat
//     prompts and added little over just typing.
//   - The CTA needs to read as a button — the prior two-line row was
//     so visually quiet that users missed it (Captain feedback).
//
// Anti-refs still obeyed: no marketing prompt, no Sparkles icon, no
// centered hero, no 2×2 grid, no gradients, no shadows. Single
// left-aligned button with a bordered surface, accent-tinted on hover,
// and one arrow affordance.

export function HeroIdle() {
  const openImportWizard = useImportStore((s) => s.openWizard)

  return (
    <div className="w-full max-w-lg px-8">
      {/* Section label — matches FolderGate's "Recent projects" treatment */}
      <div className="pl-1 mb-2 text-[10px] uppercase tracking-wider t-text-muted font-medium">
        Start
      </div>

      <button
        type="button"
        onClick={openImportWizard}
        className="group w-full text-left flex items-center gap-4 px-5 py-4 rounded-xl border t-border t-bg-elevated hover:border-[var(--color-accent-soft)] hover:bg-[var(--color-accent-soft)]/5 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-semibold t-text leading-snug">
            Build a paper memory from existing files
          </p>
          <p className="text-[12px] t-text-muted leading-snug mt-1">
            Import a .bib export from Zotero / EndNote / Mendeley to populate the library.
          </p>
        </div>
        <ArrowRight
          size={18}
          className="shrink-0 t-text-muted group-hover:t-text-accent transition-colors"
          aria-hidden
        />
      </button>
    </div>
  )
}
