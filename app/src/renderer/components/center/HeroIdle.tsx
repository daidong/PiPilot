import React from 'react'
import { useChatStore } from '../../stores/chat-store'

// ─── HeroIdle ─────────────────────────────────────────────────────────────
//
// Empty-state surface for the chat view. Three task-level starters that
// prefill the input with natural-language prompts — not slash commands.
//
// Why natural language over slash commands: the agent's coordinator system
// prompt already tells it to ground in the workspace (glob/grep/artifact-
// search for any non-trivial request), to walk the wiki_coverage →
// wiki_search → literature-search flow for literature requests, and to use
// artifact-create for notes when the user asks to save something. Each
// starter below maps directly to one of those existing agent behaviors, so
// clicking a row triggers real work — not a palette lookup.
//
// Anti-refs obeyed: no icons, no cards, no centered hero, no Sparkles,
// no 2×2 grid, no marketing prompt. Left-aligned, two-line rows, muted
// neutrals + accent-soft on hover. Same dialect as FolderGate RecentRow.

interface Starter {
  /** Clickable headline — also the text prefilled into the chat input. */
  label: string
  /** Muted one-line description of what the agent will do. Teaches by
   *  example without promising more than the agent actually delivers. */
  description: string
}

const STARTERS: Starter[] = [
  {
    label: 'Understand this folder',
    description: 'Scan files, existing artifacts, and recent work to get oriented.',
  },
  {
    label: 'Start a literature review on …',
    description: 'Plan sub-topics, search multiple sources, score and summarize.',
  },
  {
    label: 'Capture a research note about …',
    description: 'Draft a note artifact from your description.',
  },
]

function focusInput() {
  const input = document.querySelector<HTMLTextAreaElement>('[data-chat-input]')
  if (!input) return
  input.focus()
  // Drop the caret at the end so the user can keep typing from where the
  // ellipsis used to be — the "…" at the end of a starter label is the
  // natural continuation point.
  const end = input.value.length
  try { input.setSelectionRange(end, end) } catch { /* older textarea APIs */ }
}

/** Strip a trailing ellipsis so the prefilled text invites continuation
 *  without the user having to delete the "…" first. Leading/trailing
 *  whitespace is normalized. */
function prefillFromLabel(label: string): string {
  return label.replace(/…\s*$/, '').replace(/\s+$/, '') + (label.endsWith('…') ? ' ' : '')
}

function StarterRow({ starter, onActivate }: { starter: Starter; onActivate: () => void }) {
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
        {starter.label}
      </span>
      <span className="text-[11px] t-text-muted leading-snug">
        {starter.description}
      </span>
    </button>
  )
}

export function HeroIdle() {
  const setDraftText = useChatStore((s) => s.setDraftText)

  const handleStarter = (label: string) => {
    const prefill = prefillFromLabel(label)
    setDraftText(prefill)
    // Defer focus one tick so React has committed the new draft text
    // before we place the caret.
    requestAnimationFrame(focusInput)
  }

  return (
    <div className="w-full max-w-lg px-8">
      {/* Section label — matches FolderGate's "Recent projects" treatment */}
      <div className="pl-4 mb-2 text-[10px] uppercase tracking-wider t-text-muted font-medium">
        Start
      </div>

      {/* Task starter list */}
      <div className="flex flex-col">
        {STARTERS.map((s) => (
          <StarterRow key={s.label} starter={s} onActivate={() => handleStarter(s.label)} />
        ))}
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
