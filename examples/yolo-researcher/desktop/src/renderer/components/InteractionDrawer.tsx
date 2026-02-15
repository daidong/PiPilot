import { useState, useRef, useEffect } from 'react'
import { X, ChevronDown, ChevronUp, Send, Loader2, AlertTriangle, MessageCircle } from 'lucide-react'
import type { InteractionContext, InteractionAction, DrawerChatMessage } from '@/lib/types'

interface InteractionDrawerProps {
  open: boolean
  interaction: InteractionContext | null
  chatHistory: DrawerChatMessage[]
  chatLoading: boolean
  onClose: () => void
  onSendChat: (message: string) => void
  onAction: (actionId: string, text?: string) => void
}

function UrgencyBadge({ urgency }: { urgency: 'blocking' | 'advisory' }) {
  if (urgency === 'blocking') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium t-accent-amber">
        <AlertTriangle size={10} /> Blocking
      </span>
    )
  }
  return (
    <span className="rounded-md border border-teal-500/30 bg-teal-500/10 px-2 py-0.5 text-[10px] font-medium t-accent-teal">
      Advisory
    </span>
  )
}

function ContextSection({ label, content, collapsible }: { label: string; content: string; collapsible?: boolean }) {
  const [expanded, setExpanded] = useState(!collapsible)

  if (collapsible) {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 overflow-hidden">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-amber-500/5 transition-colors"
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider t-accent-amber">{label}</span>
          {expanded ? <ChevronUp size={12} className="t-text-secondary" /> : <ChevronDown size={12} className="t-text-secondary" />}
        </button>
        {expanded && (
          <div className="px-3 pb-2.5 text-[11px] t-text-secondary whitespace-pre-line leading-relaxed">
            {content}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider t-accent-amber mb-1">{label}</div>
      <div className="text-[11px] t-text-secondary whitespace-pre-line leading-relaxed">{content}</div>
    </div>
  )
}

function ChatBubble({ message }: { message: DrawerChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-[11px] leading-relaxed ${
          isUser
            ? 'bg-teal-500/20 border border-teal-500/30 t-text'
            : 'bg-neutral-500/10 border border-neutral-500/20 t-text-secondary'
        }`}
      >
        <div className="whitespace-pre-line">{message.content}</div>
        <div className={`mt-1 text-[9px] ${isUser ? 'text-teal-400/60' : 'text-neutral-400/60'}`}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  )
}

function ActionButton({ action, onClick }: { action: InteractionAction; onClick: () => void }) {
  const base = 'rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors'
  const variants: Record<string, string> = {
    primary: `${base} bg-teal-500 text-white hover:bg-teal-400`,
    secondary: `${base} border t-border t-text hover:bg-neutral-500/10`,
    danger: `${base} bg-rose-500/20 border border-rose-500/40 t-accent-rose hover:bg-rose-500/30`,
    ghost: `${base} t-text-secondary hover:bg-neutral-500/10`,
  }
  return (
    <button onClick={onClick} className={variants[action.variant] ?? variants.secondary}>
      {action.label}
    </button>
  )
}

export function InteractionDrawer({
  open,
  interaction,
  chatHistory,
  chatLoading,
  onClose,
  onSendChat,
  onAction,
}: InteractionDrawerProps) {
  const [chatInput, setChatInput] = useState('')
  const [textInput, setTextInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [chatHistory, chatLoading])

  // Reset input when interaction changes
  useEffect(() => {
    setChatInput('')
    setTextInput('')
  }, [interaction?.interactionId])

  function handleSendChat() {
    const text = chatInput.trim()
    if (!text) return
    onSendChat(text)
    setChatInput('')
  }

  function handleAction(action: InteractionAction) {
    if (action.id === 'submit_text') {
      const text = textInput.trim()
      if (!text) return
      onAction(action.id, text)
      setTextInput('')
    } else if (action.id === 'quick_reply') {
      onAction(action.id, action.label)
    } else {
      onAction(action.id, textInput.trim() || undefined)
    }
  }

  // Inline answer/input policy:
  // - Required response: question/checkpoint/gate blocker
  // - Optional note: experiment/fulltext/resource/failure actions
  const inlineInputRequired = interaction?.kind === 'checkpoint_decision'
    || interaction?.kind === 'gate_blocker'
    || interaction?.kind === 'general_question'
  const inlineInputOptional = interaction?.kind === 'experiment_request'
    || interaction?.kind === 'fulltext_upload'
    || interaction?.kind === 'resource_extension'
    || interaction?.kind === 'failure_recovery'
  const showInlineInput = Boolean(inlineInputRequired || inlineInputOptional)
  const inlinePlaceholder = inlineInputRequired
    ? 'Type your response...'
    : 'Optional note for this action...'
  const hasSubmitTextAction = Boolean(interaction?.actions.some((a) => a.id === 'submit_text'))

  return (
    <div
      className={`fixed top-0 right-0 h-full w-[420px] z-30 flex flex-col t-bg-surface border-l t-border shadow-2xl transition-transform duration-300 ease-in-out ${
        open && interaction ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      {interaction && (
        <>
          {/* Header */}
          <div className="shrink-0 flex items-center justify-between gap-2 border-b t-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{interaction.title}</div>
              <div className="mt-0.5">
                <UrgencyBadge urgency={interaction.urgency} />
              </div>
            </div>
            <button
              onClick={onClose}
              className="shrink-0 rounded-md border t-border p-1.5 t-text-secondary t-hoverable"
              aria-label="Close drawer"
            >
              <X size={14} />
            </button>
          </div>

          {/* Scrollable body: context sections + chat */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {/* Context sections */}
            {interaction.sections.map((section, i) => (
              <ContextSection key={i} label={section.label} content={section.content} collapsible={section.collapsible} />
            ))}

            {/* Chat divider */}
            {chatHistory.length > 0 && (
              <div className="flex items-center gap-2 pt-2">
                <div className="flex-1 border-t t-border" />
                <span className="text-[10px] t-text-secondary flex items-center gap-1">
                  <MessageCircle size={10} /> Conversation
                </span>
                <div className="flex-1 border-t t-border" />
              </div>
            )}

            {/* Chat messages */}
            {chatHistory.map((msg) => (
              <ChatBubble key={msg.id} message={msg} />
            ))}

            {/* Loading indicator */}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-xl bg-neutral-500/10 border border-neutral-500/20 px-3 py-2 text-[11px] t-text-secondary">
                  <Loader2 size={12} className="animate-spin" /> Thinking...
                </div>
              </div>
            )}
          </div>

          {/* Sticky bottom: chat input + quick replies + actions */}
          <div className="shrink-0 border-t t-border px-4 py-3 space-y-2">
            {/* Chat input */}
            <div className="flex gap-2">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendChat()}
                placeholder="Ask about this decision..."
                className="flex-1 rounded-lg border t-border bg-transparent px-3 py-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-teal-500/40"
                disabled={chatLoading}
              />
              <button
                onClick={handleSendChat}
                disabled={!chatInput.trim() || chatLoading}
                className="rounded-lg bg-teal-500/20 border border-teal-500/30 px-2.5 py-2 text-teal-400 disabled:opacity-40 hover:bg-teal-500/30 transition-colors"
              >
                <Send size={12} />
              </button>
            </div>

            {/* Quick replies */}
            {interaction.quickReplies && interaction.quickReplies.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {interaction.quickReplies.map((reply) => (
                  <button
                    key={reply}
                    onClick={() => onAction('quick_reply', reply)}
                    className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1 text-[10px] font-medium t-accent-amber hover:bg-amber-500/15 transition-colors"
                  >
                    {reply}
                  </button>
                ))}
              </div>
            )}

            {/* Inline answer / optional note */}
            {showInlineInput && (
              <div className="flex gap-2">
                <input
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && hasSubmitTextAction && textInput.trim()) {
                      onAction('submit_text', textInput.trim())
                      setTextInput('')
                    }
                  }}
                  placeholder={inlinePlaceholder}
                  className="flex-1 rounded-lg border border-amber-500/30 bg-transparent px-3 py-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                />
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2 pt-1">
              {interaction.actions
                .filter((a) => a.id !== 'quick_reply' && a.id !== 'submit_text')
                .map((action) => (
                  <ActionButton key={action.id} action={action} onClick={() => handleAction(action)} />
                ))}
              {showInlineInput && hasSubmitTextAction && (
                <ActionButton
                  action={{ id: 'submit_text', label: inlineInputRequired ? 'Send Reply' : 'Send Note', variant: 'primary' }}
                  onClick={() => {
                    if (!textInput.trim()) return
                    onAction('submit_text', textInput.trim())
                    setTextInput('')
                  }}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
