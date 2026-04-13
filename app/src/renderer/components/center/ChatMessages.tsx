import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useChatStore, type ChatMessage } from '../../stores/chat-store'
import { useEntityStore } from '../../stores/entity-store'
import { useToolEventsStore } from '../../stores/tool-events-store'
import { ToolUseStream } from '@shared/components/center/ToolUseStream'
import { Bookmark, BookmarkCheck, Copy, Check, Loader2 } from 'lucide-react'

const api = (window as any).api

// Stable reference to avoid re-creating array on every render
const remarkPlugins = [remarkGfm]

/** Human-readable timestamp: "10:30 AM" for today, "Yesterday 3:20 PM", "Apr 5 10:30 AM" for older */
function formatMessageTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return time

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`

  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time
  }
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + time
}

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
      className="fixed z-50 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-lg border t-border transition-colors"
      style={{
        left: pos.x,
        top: pos.y,
        transform: 'translate(-50%, -100%)',
        background: 'var(--color-bg-elevated)',
        color: saveState === 'saved' ? 'var(--color-status-success)' : 'var(--color-text-secondary)',
      }}
      title="Save selection as note"
      aria-label={saveState === 'saved' ? 'Selection saved as note' : 'Save selection as note'}
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

const MessageBubble = React.memo(function MessageBubble({ msg, isSaved }: { msg: ChatMessage; isSaved: boolean }) {
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

  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(msg.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} group`}>
      <div
        className={`relative max-w-[90%] rounded-2xl px-4 py-3 text-sm t-text ${
          !isUser ? 'assistant-bubble' : ''
        }${!isUser && isSaved ? ' border-l-2 border-[var(--color-status-success)]' : ''}`}
        style={{
          background: isUser
            ? 'var(--color-bubble-user)'
            : 'var(--color-bubble-assistant)'
        }}
        data-msg-id={msg.id}
      >
        {msg.images && msg.images.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {msg.images.map((src, i) => (
              <img
                key={i}
                src={src}
                alt=""
                loading="lazy"
                className={`rounded-lg border t-border cursor-pointer hover:opacity-90 transition-opacity ${
                  isUser ? 'max-h-48' : 'max-h-80'
                }`}
                onClick={() => window.open(src, '_blank')}
              />
            ))}
          </div>
        )}
        <div className="md-prose" style={{ color: 'var(--color-text)' }}>
          <ReactMarkdown remarkPlugins={remarkPlugins}>{msg.content}</ReactMarkdown>
        </div>

        {/* Timestamp */}
        {msg.timestamp > 0 && (
          <div className={`mt-1.5 text-[10px] t-text-muted select-none ${isUser ? 'text-right' : 'text-left'}`}>
            {formatMessageTime(msg.timestamp)}
          </div>
        )}

        {/* Action buttons for assistant messages */}
        {!isUser && (
          <div className="absolute -right-8 top-2 flex flex-col gap-1.5">
            <button
              onClick={handleSaveNote}
              disabled={saveState !== 'idle'}
              className={`transition-opacity ${
                saveState === 'saved'
                  ? 'opacity-100 t-text-success'
                  : saveState === 'saving'
                    ? 'opacity-100 t-text-muted'
                    : 'opacity-0 group-hover:opacity-100 t-text-muted hover:t-text-accent-soft'
              }`}
              title={saveState === 'saved' ? 'Saved as note' : 'Save entire message as note'}
              aria-label={saveState === 'saved' ? 'Message saved as note' : 'Save entire message as note'}
            >
              {saveState === 'saving' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : saveState === 'saved' ? (
                <BookmarkCheck size={14} />
              ) : (
                <Bookmark size={14} />
              )}
            </button>
            <button
              onClick={handleCopy}
              className={`transition-opacity ${
                copied
                  ? 'opacity-100 t-text-success'
                  : 'opacity-0 group-hover:opacity-100 t-text-muted hover:t-text-accent-soft'
              }`}
              title={copied ? 'Copied!' : 'Copy message'}
              aria-label={copied ? 'Message copied' : 'Copy message to clipboard'}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        )}
      </div>
    </div>
  )
})

// Minimal thinking indicator — only shown when no tools are running
// (when tools are running, the RunningToolCard spinner is the indicator).
//
// Matches the rest of the app's loader idiom: a single Loader2 + muted
// caption. The prior 3-dot bounce animation was the only use of
// `animate-bounce` in the codebase and violated the "no bounce easing"
// motion principle. aria-live="polite" lets screen readers announce the
// state change when the indicator appears without interrupting speech.
function ThinkingIndicator() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 mt-3 ml-2 text-[11px] t-text-muted"
    >
      <Loader2 size={11} className="t-text-accent-soft animate-spin shrink-0" aria-hidden />
      <span>Thinking…</span>
    </div>
  )
}

function StreamingBubble() {
  const text = useChatStore((s) => s.streamingText)
  if (!text) return null

  return (
    <div className="flex justify-start">
      <div
        className="max-w-[90%] rounded-2xl px-4 py-3 text-sm t-text assistant-bubble"
        style={{ background: 'var(--color-bubble-assistant)' }}
      >
        <div className="md-prose" style={{ color: 'var(--color-text)' }}>
          <ReactMarkdown remarkPlugins={remarkPlugins}>{text}</ReactMarkdown>
        </div>
        <span className="inline-block w-1.5 h-4 t-bg-accent-soft animate-pulse ml-0.5 align-text-bottom" />
      </div>
    </div>
  )
}

// ─── Timeline Scrubber ──────────────────────────────────────────────────────
// Right-edge rail showing user messages as ticks. Hovering reveals a preview
// card with truncated content; clicking jumps to that message. A viewport
// overlay shows the currently visible portion.

interface ScrubNode {
  msgId: string
  preview: string
  time: string
}

function buildScrubNodes(messages: ChatMessage[]): ScrubNode[] {
  return messages
    .filter(m => m.role === 'user')
    .map(msg => ({
      msgId: msg.id,
      preview: msg.content.replace(/^#+\s*/gm, '').slice(0, 100),
      time: msg.timestamp > 0 ? formatMessageTime(msg.timestamp) : '',
    }))
}

function ChatTimeline({ messages, scrollContainerRef }: { messages: ChatMessage[]; scrollContainerRef: React.RefObject<HTMLDivElement> }) {
  const requestScrollTo = useChatStore((s) => s.requestScrollTo)
  const nodes = useMemo(() => buildScrubNodes(messages), [messages])
  // positions: 0-1 ratio of each message within the scrollable content
  const positionsRef = useRef<number[]>([])
  const [, forceUpdate] = useState(0)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [hoverY, setHoverY] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 1 })
  const railRef = useRef<HTMLDivElement>(null)
  const railHRef = useRef(0)

  const RAIL_PAD = 8

  // Compute positions using getBoundingClientRect (immune to offsetParent issues)
  const computePositions = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || nodes.length === 0) return
    const scrollH = container.scrollHeight
    if (scrollH <= 0) return
    const containerRect = container.getBoundingClientRect()
    const scrollTop = container.scrollTop

    const pos = nodes.map(node => {
      const el = container.querySelector(`[data-msg-id="${node.msgId}"]`)
      if (!el) return 0
      const elRect = el.getBoundingClientRect()
      // Absolute position within the scrollable content
      const absTop = elRect.top - containerRect.top + scrollTop
      return Math.min(Math.max(absTop / scrollH, 0), 1)
    })
    positionsRef.current = pos
    forceUpdate(n => n + 1)
  }, [nodes, scrollContainerRef])

  // Recompute on layout changes
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || nodes.length === 0) { positionsRef.current = []; return }
    // Delay first computation to ensure DOM is fully laid out
    const raf = requestAnimationFrame(() => computePositions())
    const observer = new ResizeObserver(() => computePositions())
    observer.observe(container)
    return () => { cancelAnimationFrame(raf); observer.disconnect() }
  }, [nodes, messages, scrollContainerRef, computePositions])

  // Track rail height via ResizeObserver
  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const obs = new ResizeObserver(([e]) => {
      railHRef.current = e.contentRect.height
      forceUpdate(n => n + 1)
    })
    obs.observe(rail)
    return () => obs.disconnect()
  }, [])

  // Track viewport overlay
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      if (scrollHeight <= 0) return
      setViewport({
        top: scrollTop / scrollHeight,
        height: Math.min(clientHeight / scrollHeight, 1),
      })
    }
    update()
    container.addEventListener('scroll', update, { passive: true })
    const obs = new ResizeObserver(update)
    obs.observe(container)
    return () => { container.removeEventListener('scroll', update); obs.disconnect() }
  }, [scrollContainerRef, messages])

  // Convert 0-1 ratio → pixel top within the rail
  const toY = (ratio: number) => {
    const usable = railHRef.current - RAIL_PAD * 2
    return usable > 0 ? RAIL_PAD + ratio * usable : 0
  }

  // Scrub: find nearest node to cursor Y
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rail = railRef.current
    const positions = positionsRef.current
    if (!rail || positions.length === 0) return
    const rect = rail.getBoundingClientRect()
    const y = e.clientY - rect.top
    setHoverY(y)

    const usable = railHRef.current - RAIL_PAD * 2
    if (usable <= 0) return
    const ratio = Math.max(0, Math.min(1, (y - RAIL_PAD) / usable))

    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < positions.length; i++) {
      const d = Math.abs(positions[i] - ratio)
      if (d < bestDist) { bestDist = d; best = i }
    }
    setHoveredIdx(best)
  }, [])

  const handleMouseLeave = useCallback(() => setHoveredIdx(null), [])

  const handleClick = useCallback(() => {
    if (hoveredIdx !== null && nodes[hoveredIdx]) {
      requestScrollTo(nodes[hoveredIdx].msgId)
    }
  }, [hoveredIdx, nodes, requestScrollTo])

  const positions = positionsRef.current
  const railH = railHRef.current
  // Ready when we have enough messages, positions are computed, and rail has measured its height
  const ready = nodes.length >= 3 && positions.length === nodes.length && railH > 0

  const hovered = hoveredIdx !== null ? nodes[hoveredIdx] : null

  // Always render the rail container so ResizeObserver can measure it.
  // Only render content (ticks, viewport, preview) when ready.
  return (
    <div className="absolute right-0 top-0 bottom-0 w-[48px] select-none" style={{ zIndex: 10 }}>
      <div
        ref={railRef}
        className="absolute inset-0 cursor-pointer"
        role="navigation"
        aria-label="Message timeline"
        onMouseMove={ready ? handleMouseMove : undefined}
        onMouseLeave={ready ? handleMouseLeave : undefined}
        onClick={ready ? handleClick : undefined}
      >
        {ready && (
          <>
            {/* Track line */}
            <div
              className="absolute left-[23px] w-px"
              style={{ top: RAIL_PAD, bottom: RAIL_PAD, background: 'var(--color-border)', opacity: 0.25 }}
            />

            {/* Viewport overlay */}
            <div
              className="absolute left-[18px] w-[11px] rounded-full"
              style={{
                top: toY(viewport.top),
                height: Math.max(12, viewport.height * (railH - RAIL_PAD * 2)),
                background: 'var(--color-accent-soft)',
                opacity: 0.15,
              }}
            />

            {/* Message ticks */}
            {nodes.map((node, i) => {
              const isActive = hoveredIdx === i
              return (
                <div
                  key={node.msgId}
                  className="absolute"
                  style={{
                    top: toY(positions[i]),
                    left: 17,
                    width: isActive ? 16 : 8,
                    height: isActive ? 3 : 2,
                    borderRadius: 1,
                    background: 'var(--color-accent-soft)',
                    opacity: isActive ? 1 : 0.35,
                    transition: 'width 80ms, height 80ms, opacity 80ms',
                  }}
                />
              )
            })}

            {/* Scrub cursor */}
            {hoveredIdx !== null && (
              <div
                className="absolute pointer-events-none"
                style={{ top: hoverY, left: 6, right: 6, height: 1, background: 'var(--color-accent-soft)', opacity: 0.6 }}
              />
            )}
          </>
        )}
      </div>

      {/* Preview card */}
      {ready && hovered && hoveredIdx !== null && (
        <div
          className="absolute right-[52px] pointer-events-none"
          style={{ top: Math.max(8, Math.min(hoverY - 28, railH - 80)), zIndex: 50 }}
        >
          <div
            className="w-56 rounded-lg border shadow-lg overflow-hidden"
            style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}
          >
            <div className="h-[3px]" style={{ background: 'var(--color-accent-soft)' }} />
            <div className="px-3 py-2">
              {hovered.time && (
                <span className="text-[9px] t-text-muted block mb-1">{hovered.time}</span>
              )}
              <p className="text-[11px] t-text leading-relaxed line-clamp-3">
                {hovered.preview || '(empty)'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function ChatMessages() {
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const streamingText = useChatStore((s) => s.streamingText)
  const savedMessageIds = useChatStore((s) => s.savedMessageIds)
  const turnToolEvents = useChatStore((s) => s.turnToolEvents)
  const hasMore = useChatStore((s) => s.hasMore)
  const isLoadingHistory = useChatStore((s) => s.isLoadingHistory)
  const loadHistory = useChatStore((s) => s.loadHistory)
  const scrollToMessageId = useChatStore((s) => s.scrollToMessageId)
  const toolEventsCount = useToolEventsStore((s) => s.currentRunEvents.length)
  const hasRunningTools = useToolEventsStore((s) => s.currentRunEvents.some(e => e.status === 'running'))
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
        // After initial mount, use smooth scrolling for new messages and tool events
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }, [messages, streamingText, toolEventsCount, autoScroll])

  // Scroll to a specific message when requested (e.g. from provenance click)
  useEffect(() => {
    if (!scrollToMessageId || !scrollContainerRef.current) return
    const el = scrollContainerRef.current.querySelector(`[data-msg-id="${scrollToMessageId}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // Brief highlight flash
      el.classList.add('ring-2', 'ring-[var(--color-accent-soft)]')
      setTimeout(() => el.classList.remove('ring-2', 'ring-[var(--color-accent-soft)]'), 1500)
    }
  }, [scrollToMessageId])

  return (
    <div className="relative h-full">
      <SelectionBookmark />
      <ChatTimeline messages={messages} scrollContainerRef={scrollContainerRef} />
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="overflow-y-auto h-full pr-[48px]"
          style={{ scrollbarWidth: 'none' }}
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
      >
        {isLoadingHistory && (
          <div className="flex justify-center py-2">
            <Loader2 size={16} className="animate-spin t-text-muted" />
          </div>
        )}
        {messages.map((msg, i) => {
          // System messages render as a divider line
          if (msg.role === 'system') {
            return (
              <div key={msg.id} className="flex items-center gap-3 my-5 px-2">
                <div className="flex-1 h-px t-bg-elevated" />
                <span className="text-[11px] t-text-muted shrink-0">{msg.content}</span>
                <div className="flex-1 h-px t-bg-elevated" />
              </div>
            )
          }

          const prev = messages[i - 1]
          // Tighter spacing within same-role runs (e.g. multi-part assistant),
          // generous space when the speaker changes (new exchange)
          const gap = prev && prev.role !== msg.role ? 'mt-5' : 'mt-3'
          // Get historical tool events for this assistant message
          const toolEvents = msg.role === 'assistant' ? turnToolEvents.get(msg.id) : undefined
          return (
            <div key={msg.id} className={i === 0 ? '' : gap}>
              {toolEvents && toolEvents.length > 0 && (
                <ToolUseStream events={toolEvents} />
              )}
              <MessageBubble
                msg={msg}
                isSaved={savedMessageIds.has(msg.id)}
              />
            </div>
          )
        })}
        {isStreaming && (
          <div className="mt-5">
            <ToolUseStream />
            {streamingText ? (
              <StreamingBubble />
            ) : !hasRunningTools ? (
              /* Show thinking dots only when no tools are running —
                 running tool cards already have spinners as progress indicator */
              <ThinkingIndicator />
            ) : null}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
