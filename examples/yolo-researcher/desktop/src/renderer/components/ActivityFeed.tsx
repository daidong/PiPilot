import { useRef, useEffect, useCallback } from 'react'
import { Bot, Wrench, MessageSquare, Play, CheckCircle } from 'lucide-react'
import type { ActivityItem } from '@/lib/types'

interface ActivityFeedProps {
  items: ActivityItem[]
}

const ICON_MAP: Record<string, typeof Bot> = {
  planner_start: Play,
  planner_end: CheckCircle,
  coordinator_start: Play,
  coordinator_end: CheckCircle,
  tool_call: Wrench,
  tool_result: Wrench,
  llm_text: MessageSquare,
}

const KIND_LABEL: Record<string, string> = {
  planner_start: 'Planner thinking...',
  planner_end: 'Plan ready',
  coordinator_start: 'Coordinator executing...',
  coordinator_end: 'Execution complete',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  llm_text: 'LLM output',
}

function LlmPreview({ text }: { text: string }) {
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <pre
      ref={preRef}
      className="mt-0.5 max-h-[10lh] overflow-y-auto whitespace-pre-wrap break-words t-text-muted font-[inherit]"
    >
      {text}
    </pre>
  )
}

export function ActivityFeed({ items }: ActivityFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [items[0]?.id])

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border t-border t-bg-surface p-3 text-xs t-text-muted">
        No activity yet. Events will appear here when agents start working.
      </div>
    )
  }

  return (
    <div className="rounded-2xl border t-border t-bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <Bot size={14} className="t-accent-teal" />
        <span className="text-[11px] font-medium">Live Activity</span>
        <span className="text-[11px] t-text-muted">{items.length} events</span>
      </div>
      <div ref={scrollRef} className="max-h-[320px] overflow-y-auto space-y-1">
        {items.map((item) => {
          const Icon = ICON_MAP[item.kind] ?? Bot
          const isActive = item.kind === 'planner_start' || item.kind === 'coordinator_start'
          return (
            <div key={item.id} className={`flex items-start gap-2 rounded-lg px-2 py-1 text-[11px] ${
              isActive ? 't-bg-elevated' : ''
            }`}>
              <Icon size={12} className={`mt-0.5 shrink-0 ${isActive ? 't-accent-teal animate-pulse' : 't-text-muted'}`} />
              <div className="min-w-0 flex-1">
                <span className="font-medium">{KIND_LABEL[item.kind] ?? item.kind}</span>
                {item.tool && <span className="ml-1 t-text-secondary">&middot; {item.tool}</span>}
                {item.preview && item.kind === 'llm_text' ? (
                  <LlmPreview text={item.preview} />
                ) : item.preview ? (
                  <div className="mt-0.5 truncate t-text-muted">{item.preview}</div>
                ) : null}
              </div>
              <span className="shrink-0 t-text-muted">
                {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
