import React from 'react'
import { useChatStore } from '../../stores/chat-store'

// ─── HeroIdle ─────────────────────────────────────────────────────────────
//
// Empty-state surface for the chat view. Not a welcome hero: a quiet
// command-palette preview. Four real slash commands that already exist in
// ChatInput's SLASH_COMMANDS list, rendered as a left-aligned text list
// with keyboard-affordance chips on the right. Clicking a row pre-fills
// the input with the command and focuses it — the user learns the palette
// by using it.
//
// Anti-refs obeyed: no icons, no cards, no centered hero, no Sparkles,
// no generic "What would you like to do?" prompt.

interface Starter {
  label: string
  command: string      // what gets written into the input
  display: string      // what's shown in the kbd chip on the right
}

const STARTERS: Starter[] = [
  { label: 'Capture a research note',  command: '/note ',    display: '/note'    },
  { label: 'Search notes & papers',    command: '/search ',  display: '/search'  },
  { label: 'Browse literature',        command: '/papers',   display: '/papers'  },
  { label: 'See all commands',         command: '/help',     display: '/help'    },
]

function focusInput() {
  const input = document.querySelector<HTMLTextAreaElement>('[data-chat-input]')
  input?.focus()
}

function StarterRow({ starter, onActivate }: { starter: Starter; onActivate: () => void }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      className="group relative w-full text-left flex items-center gap-6 py-1.5 pl-4 pr-2 rounded-sm t-bg-hover transition-colors"
    >
      {/* Left accent bar on hover — same dialect as RecentRow in FolderGate
          and the Wiki-row treatment in LiteratureView */}
      <span
        aria-hidden
        className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-transparent group-hover:t-bg-accent-soft transition-colors"
      />
      <span className="flex-1 truncate text-[13px] t-text-secondary group-hover:t-text transition-colors">
        {starter.label}
      </span>
      <kbd className="shrink-0 inline-flex items-center px-1.5 py-0 rounded border t-border-subtle t-bg-elevated text-[10px] font-mono t-text-muted leading-[1.5] group-hover:t-text-accent-soft transition-colors">
        {starter.display}
      </kbd>
    </button>
  )
}

export function HeroIdle() {
  const setDraftText = useChatStore((s) => s.setDraftText)

  const handleStarter = (command: string) => {
    setDraftText(command)
    // Defer focus one tick so the state update has committed before the
    // caret is placed at the end of the new text.
    requestAnimationFrame(focusInput)
  }

  return (
    <div className="w-full max-w-md px-8">
      {/* Section label — matches FolderGate's "Recent projects" treatment */}
      <div className="pl-4 mb-2 text-[10px] uppercase tracking-wider t-text-muted font-medium">
        Start
      </div>

      {/* Command list */}
      <div className="flex flex-col">
        {STARTERS.map((s) => (
          <StarterRow key={s.command} starter={s} onActivate={() => handleStarter(s.command)} />
        ))}
      </div>

      {/* Keyboard hint line */}
      <div className="mt-8 pl-4 flex flex-col gap-1 text-[10px] t-text-muted">
        <div className="flex items-center gap-2">
          <kbd className="inline-flex items-center px-1 py-0 rounded border t-border-subtle t-bg-elevated text-[9.5px] font-mono t-text-secondary leading-[1.4]">/</kbd>
          <span>or</span>
          <kbd className="inline-flex items-center px-1 py-0 rounded border t-border-subtle t-bg-elevated text-[9.5px] font-mono t-text-secondary leading-[1.4]">⌘K</kbd>
          <span>command palette</span>
        </div>
        <div className="flex items-center gap-2">
          <kbd className="inline-flex items-center px-1 py-0 rounded border t-border-subtle t-bg-elevated text-[9.5px] font-mono t-text-secondary leading-[1.4]">@</kbd>
          <span>mention notes, papers, or files</span>
        </div>
        <div className="flex items-center gap-2">
          <kbd className="inline-flex items-center px-1 py-0 rounded border t-border-subtle t-bg-elevated text-[9.5px] font-mono t-text-secondary leading-[1.4]">↵</kbd>
          <span>send</span>
          <span className="t-text-muted opacity-50">·</span>
          <kbd className="inline-flex items-center px-1 py-0 rounded border t-border-subtle t-bg-elevated text-[9.5px] font-mono t-text-secondary leading-[1.4]">⇧↵</kbd>
          <span>newline</span>
        </div>
      </div>
    </div>
  )
}
