import { useState } from 'react'
import { Bot, Send } from 'lucide-react'

interface QuestionPanelProps {
  question: string
  context?: string
  quickOptions: string[]
  onQuickReply: (text: string) => void
  onSubmit: (text: string) => void
}

export function QuestionPanel({ question, context, quickOptions, onQuickReply, onSubmit }: QuestionPanelProps) {
  const [replyText, setReplyText] = useState('')

  function handleSubmit() {
    const text = replyText.trim()
    if (!text) return
    onSubmit(text)
    setReplyText('')
  }

  return (
    <>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium t-accent-amber">
        <Bot size={14} /> Question
      </div>
      <p className="text-sm whitespace-pre-line">{question}</p>
      {context && (
        <p className="mt-2 text-xs t-text-secondary">{context}</p>
      )}

      {quickOptions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {quickOptions.map((option) => (
            <button
              key={option}
              onClick={() => onQuickReply(option)}
              className="rounded-lg border border-amber-500/40 px-2.5 py-1.5 text-xs font-medium t-accent-amber hover:bg-amber-500/10"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          className="flex-1 rounded-lg border t-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
          placeholder="Type your response..."
        />
        <button onClick={handleSubmit} className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-medium text-black">
          <Send size={12} className="inline mr-1" /> Send
        </button>
      </div>
    </>
  )
}
