import React from 'react'
import { Sparkles, FileText, BookOpen, BarChart3 } from 'lucide-react'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'

const suggestions = [
  { icon: FileText, label: 'Draft a research note', prompt: 'Help me draft a research note about ' },
  { icon: BookOpen, label: 'Search literature', prompt: 'Search for recent papers on ' },
  { icon: BarChart3, label: 'Analyze data', prompt: 'Analyze the data in ' },
  { icon: Sparkles, label: 'Brainstorm ideas', prompt: 'Help me brainstorm ideas for ' },
]

export function HeroIdle() {
  const sendMessage = useChatStore((s) => s.sendMessage)

  const handleSuggestion = (prompt: string) => {
    // Put the prompt text in the input rather than sending directly
    const input = document.querySelector<HTMLTextAreaElement>('[data-chat-input]')
    if (input) {
      // Use native setter to trigger React's onChange
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set
      nativeSetter?.call(input, prompt)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
    }
  }

  return (
    <div className="flex flex-col items-center gap-10 max-w-2xl px-8">
      {/* Branded mark */}
      <div className="relative">
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)',
            boxShadow: '0 8px 32px rgba(99, 102, 241, 0.25)',
          }}
        >
          <span className="text-white text-2xl font-bold tracking-tight" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
            P
          </span>
        </div>
        {/* Subtle glow ring */}
        <div
          className="absolute -inset-2 rounded-3xl opacity-20 blur-xl -z-10"
          style={{ background: 'linear-gradient(135deg, #3b82f6, #6366f1)' }}
        />
      </div>

      {/* Heading */}
      <div className="text-center space-y-3">
        <h1
          className="text-3xl font-semibold t-text tracking-tight"
          style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
        >
          What would you like to do?
        </h1>
        <p className="text-sm t-text-secondary leading-relaxed max-w-md mx-auto">
          Research, write, analyze, or explore — your AI copilot is ready.
        </p>
      </div>

      {/* Suggestion chips */}
      <div className="grid grid-cols-2 gap-3 w-full max-w-md">
        {suggestions.map(({ icon: Icon, label, prompt }) => (
          <button
            key={label}
            onClick={() => handleSuggestion(prompt)}
            className="group flex items-center gap-3 px-4 py-3 rounded-xl t-bg-surface border t-border
                       hover:border-indigo-400/50 hover:shadow-sm transition-all duration-200 text-left"
          >
            <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center
                            t-bg-base group-hover:bg-indigo-50 dark:group-hover:bg-indigo-950/30 transition-colors">
              <Icon size={16} className="t-text-muted group-hover:text-indigo-500 transition-colors" />
            </div>
            <span className="text-[13px] t-text-secondary group-hover:t-text font-medium transition-colors">
              {label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
