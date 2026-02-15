import { useState, useRef, useCallback } from 'react'
import { Send } from 'lucide-react'

interface ChatInputProps {
  onSend: (text: string, priority?: 'urgent' | 'normal') => void
  disabled?: boolean
  placeholder?: string
}

export function ChatInput({ onSend, disabled, placeholder }: ChatInputProps) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed, 'normal')
    setText('')
    inputRef.current?.focus()
  }, [text, onSend])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  return (
    <div className="flex items-center gap-2 rounded-2xl border t-border t-bg-surface px-3 py-2">
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder ?? 'Send a message to the research agent...'}
        className="flex-1 bg-transparent text-xs outline-none placeholder:t-text-muted disabled:opacity-50"
      />
      <button
        onClick={handleSend}
        disabled={disabled || !text.trim()}
        className="shrink-0 rounded-lg bg-teal-500 p-1.5 text-white disabled:opacity-40 hover:bg-teal-400 transition-colors"
        aria-label="Send message"
      >
        <Send size={12} />
      </button>
    </div>
  )
}
