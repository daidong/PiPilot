import React from 'react'
import { Sparkles, FileText, BookOpen, BarChart3 } from 'lucide-react'

const suggestions = [
  { icon: FileText, label: 'Draft a research note', prompt: 'Help me draft a research note about ' },
  { icon: BookOpen, label: 'Search literature', prompt: 'Search for recent papers on ' },
  { icon: BarChart3, label: 'Analyze data', prompt: 'Analyze the data in ' },
  { icon: Sparkles, label: 'Brainstorm ideas', prompt: 'Help me brainstorm ideas for ' },
]

export function HeroIdle() {
  const handleSuggestion = (prompt: string) => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-chat-input]')
    if (input) {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set
      nativeSetter?.call(input, prompt)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
    }
  }

  return (
    <div className="flex flex-col items-center gap-8 max-w-xl px-8">
      {/* Heading — clean and minimal, no logo duplication */}
      <div className="text-center space-y-2">
        <h1
          className="t-text-secondary tracking-tight font-medium"
          style={{ fontSize: 'var(--text-xl)' }}
        >
          What would you like to do?
        </h1>
      </div>

      {/* Suggestion chips */}
      <div className="grid grid-cols-2 gap-2.5 w-full max-w-sm">
        {suggestions.map(({ icon: Icon, label, prompt }) => (
          <button
            key={label}
            onClick={() => handleSuggestion(prompt)}
            className="group flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg t-bg-surface border t-border
                       chip-hover hover:shadow-sm transition-all duration-200 text-left"
          >
            <Icon size={14} className="shrink-0 t-text-muted group-hover:t-text-accent-2 transition-colors" />
            <span className="t-text-secondary group-hover:t-text font-medium transition-colors" style={{ fontSize: 'var(--text-sm)' }}>
              {label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
