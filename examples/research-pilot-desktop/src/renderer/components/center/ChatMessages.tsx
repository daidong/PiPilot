import React, { useRef, useEffect, useCallback, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useChatStore, type ChatMessage } from '../../stores/chat-store'
import { useEntityStore } from '../../stores/entity-store'
import { useActivityStore } from '../../stores/activity-store'
import { Bookmark, BookmarkCheck, Loader2 } from 'lucide-react'

const api = (window as any).api

// Floating tooltip that appears when user selects text inside an assistant bubble
function SelectionBookmark() {
  const refreshAll = useEntityStore((s) => s.refreshAll)
  const markSaved = useChatStore((s) => s.markSaved)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [selectedText, setSelectedText] = useState('')
  const [selectedMsgId, setSelectedMsgId] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const tooltipRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        return
      }

      const text = sel.toString().trim()
      const anchorNode = sel.anchorNode
      const el = anchorNode instanceof HTMLElement ? anchorNode : anchorNode?.parentElement
      const bubble = el?.closest('.assistant-bubble')
      if (!bubble) {
        setPos(null)
        setSelectedText('')
        setSelectedMsgId(null)
        return
      }

      // Extract message ID from data attribute
      const msgId = bubble.getAttribute('data-msg-id')
      setSelectedMsgId(msgId)

      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      setPos({ x: rect.left + rect.width / 2, y: rect.top - 8 })
      setSelectedText(text)
      setSaveState('idle')
    }

    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node)) {
        setTimeout(() => {
          const sel = window.getSelection()
          if (!sel || sel.isCollapsed) {
            setPos(null)
            setSelectedText('')
            setSelectedMsgId(null)
          }
        }, 100)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  const handleSave = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (saveState !== 'idle' || !selectedText) return
    setSaveState('saving')
    try {
      const first = selectedText.split(/[.!?\n]/)[0].trim()
      const title = first.length > 60 ? first.slice(0, 57) + '…' : first || 'Untitled selection'
      const created = await api.artifactCreate({
        type: 'note',
        title,
        content: selectedText,
        provenance: {
          source: 'user',
          extractedFrom: 'user-input',
          messageId: selectedMsgId || undefined
        }
      })
      if (!created?.success) {
        throw new Error(created?.error || 'Failed to save note')
      }
      setSaveState('saved')
      if (selectedMsgId) markSaved(selectedMsgId)
      await refreshAll()
      setTimeout(() => {
        setPos(null)
        setSelectedText('')
        setSelectedMsgId(null)
        window.getSelection()?.removeAllRanges()
      }, 1200)
    } catch {
      setSaveState('idle')
    }
  }

  if (!pos || !selectedText) return null

  return (
    <button
      ref={tooltipRef}
      onMouseDown={handleSave}
      className="fixed z-[100] flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-lg border t-border transition-colors"
      style={{
        left: pos.x,
        top: pos.y,
        transform: 'translate(-50%, -100%)',
        background: 'var(--color-bg-elevated)',
        color: saveState === 'saved' ? '#22c55e' : 'var(--color-text-secondary)',
      }}
      title="Save selection as note"
    >
      {saveState === 'saving' ? (
        <Loader2 size={12} className="animate-spin" />
      ) : saveState === 'saved' ? (
        <BookmarkCheck size={12} />
      ) : (
        <Bookmark size={12} />
      )}
      {saveState === 'saved' ? 'Saved' : 'Save as note'}
    </button>
  )
}

function MessageBubble({ msg, isSaved }: { msg: ChatMessage; isSaved: boolean }) {
  const isUser = msg.role === 'user'
  const refreshAll = useEntityStore((s) => s.refreshAll)
  const markSaved = useChatStore((s) => s.markSaved)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>(
    isSaved ? 'saved' : 'idle'
  )

  // Sync external isSaved prop
  useEffect(() => {
    if (isSaved && saveState === 'idle') setSaveState('saved')
  }, [isSaved])

  const handleSaveNote = async () => {
    if (saveState !== 'idle') return
    setSaveState('saving')
    try {
      const first = msg.content.replace(/^#+\s*/, '').split(/[.!?\n]/)[0].trim()
      const title = first.length > 60 ? first.slice(0, 57) + '…' : first || 'Untitled note'
      const created = await api.artifactCreate({
        type: 'note',
        title,
        content: msg.content,
        provenance: {
          source: 'user',
          extractedFrom: 'user-input',
          messageId: msg.id
        }
      })
      if (!created?.success) {
        throw new Error(created?.error || 'Failed to save note')
      }
      setSaveState('saved')
      markSaved(msg.id)
      await refreshAll()
    } catch {
      setSaveState('idle')
    }
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} group`}>
      <div
        className={`relative max-w-[80%] rounded-2xl px-4 py-3 text-sm t-text ${
          !isUser ? 'assistant-bubble' : ''
        }${!isUser && isSaved ? ' border-l-2 border-green-500' : ''}`}
        style={{
          background: isUser
            ? 'var(--color-bubble-user)'
            : 'var(--color-bubble-assistant)'
        }}
        data-msg-id={msg.id}
      >
        <div className="md-prose" style={{ color: 'var(--color-text)' }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        </div>

        {!isUser && (
          <button
            onClick={handleSaveNote}
            disabled={saveState !== 'idle'}
            className={`absolute -right-8 top-2 transition-opacity ${
              saveState === 'saved'
                ? 'opacity-100 text-green-500'
                : saveState === 'saving'
                  ? 'opacity-100 t-text-muted'
                  : 'opacity-0 group-hover:opacity-100 t-text-muted hover:text-teal-400'
            }`}
            title={saveState === 'saved' ? 'Saved as note' : 'Save entire message as note'}
          >
            {saveState === 'saving' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : saveState === 'saved' ? (
              <BookmarkCheck size={14} />
            ) : (
              <Bookmark size={14} />
            )}
          </button>
        )}
      </div>
    </div>
  )
}

// Animated dots for thinking state
function ThinkingDots() {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  )
}

function ThinkingBubble() {
  const events = useActivityStore((s) => s.events)
  const latest = [...events].reverse().find(e => e.type === 'tool-call') || events[events.length - 1]
  const activity = latest?.summary || ''

  return (
    <div className="flex items-center gap-3">
      <div
        className="rounded-2xl px-4 py-3 text-sm t-text-secondary shrink-0"
        style={{ background: 'var(--color-bubble-assistant)' }}
      >
        <div className="flex items-center gap-2">
          <ThinkingDots />
          <span className="text-xs">Thinking</span>
        </div>
      </div>
      {activity && (
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <div className="flex-1 h-px border-t t-border" />
          <span className="text-xs t-text-muted whitespace-nowrap truncate max-w-[60%] animate-pulse">{activity}</span>
          <div className="flex-1 h-px border-t t-border" />
        </div>
      )}
    </div>
  )
}

function StreamingBubble() {
  const text = useChatStore((s) => s.streamingText)
  if (!text) return null

  return (
    <div className="flex justify-start">
      <div
        className="max-w-[80%] rounded-2xl px-4 py-3 text-sm t-text assistant-bubble"
        style={{ background: 'var(--color-bubble-assistant)' }}
      >
        <div className="md-prose" style={{ color: 'var(--color-text)' }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
        <span className="inline-block w-1.5 h-4 bg-teal-400 animate-pulse ml-0.5 align-text-bottom" />
      </div>
    </div>
  )
}

export function ChatMessages() {
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const streamingText = useChatStore((s) => s.streamingText)
  const savedMessageIds = useChatStore((s) => s.savedMessageIds)
  const hasMore = useChatStore((s) => s.hasMore)
  const isLoadingHistory = useChatStore((s) => s.isLoadingHistory)
  const loadHistory = useChatStore((s) => s.loadHistory)
  const scrollToMessageId = useChatStore((s) => s.scrollToMessageId)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const isInitialMount = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return

    // Lazy scroll: load older messages when scrolled to top
    if (el.scrollTop < 50 && hasMore && !isLoadingHistory) {
      const prevHeight = el.scrollHeight
      loadHistory().then(() => {
        // Restore scroll position after prepending
        requestAnimationFrame(() => {
          if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop =
              scrollContainerRef.current.scrollHeight - prevHeight
          }
        })
      })
    }

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setAutoScroll(distanceFromBottom < 60)
  }, [hasMore, isLoadingHistory, loadHistory])

  useEffect(() => {
    setAutoScroll(true)
  }, [messages.length])

  useEffect(() => {
    if (autoScroll) {
      // On initial mount, scroll instantly without animation
      if (isInitialMount.current) {
        isInitialMount.current = false
        bottomRef.current?.scrollIntoView({ behavior: 'instant' })
      } else {
        // After initial mount, use smooth scrolling for new messages
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }, [messages, streamingText, autoScroll])

  // Scroll to a specific message when requested (e.g. from provenance click)
  useEffect(() => {
    if (!scrollToMessageId || !scrollContainerRef.current) return
    const el = scrollContainerRef.current.querySelector(`[data-msg-id="${scrollToMessageId}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // Brief highlight flash
      el.classList.add('ring-2', 'ring-teal-400')
      setTimeout(() => el.classList.remove('ring-2', 'ring-teal-400'), 1500)
    }
  }, [scrollToMessageId])

  return (
    <>
      <SelectionBookmark />
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="space-y-4 overflow-y-auto h-full"
      >
        {isLoadingHistory && (
          <div className="flex justify-center py-2">
            <Loader2 size={16} className="animate-spin t-text-muted" />
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            isSaved={savedMessageIds.has(msg.id)}
          />
        ))}
        {isStreaming && (streamingText ? <StreamingBubble /> : <ThinkingBubble />)}
        <div ref={bottomRef} />
      </div>
    </>
  )
}
