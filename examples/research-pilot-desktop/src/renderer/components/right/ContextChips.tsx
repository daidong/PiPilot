import React, { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'

interface SessionSummaryView {
  sessionId: string
  turnRange: [number, number]
  summary: string
  topicsDiscussed: string[]
  openQuestions: string[]
  createdAt: string
}

export function ContextChips() {
  const [summary, setSummary] = useState<SessionSummaryView | null>(null)

  useEffect(() => {
    ;(async () => {
      const api = (window as any).api
      const result = await api.sessionSummaryGet()
      setSummary(result?.summary || null)
    })()
  }, [])

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider mb-2 flex items-center gap-1">
          <FileText size={10} /> Session Summary
        </h3>
        {!summary ? (
          <p className="text-xs t-text-muted">No session summary yet</p>
        ) : (
          <div className="rounded-lg border t-border t-bg-surface p-2 text-xs space-y-2">
            <p className="t-text-secondary">{summary.summary}</p>
            {summary.topicsDiscussed.length > 0 && (
              <div>
                <p className="text-[10px] t-text-muted mb-1">Topics:</p>
                <div className="flex flex-wrap gap-1">
                  {summary.topicsDiscussed.map((topic, i) => (
                    <span key={i} className="px-1.5 py-0.5 rounded-full t-bg-elevated text-[10px] t-text-secondary">{topic}</span>
                  ))}
                </div>
              </div>
            )}
            {summary.openQuestions.length > 0 && (
              <div>
                <p className="text-[10px] t-text-muted mb-1">Open questions:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {summary.openQuestions.map((q, i) => (
                    <li key={i} className="text-[10px] t-text-secondary">{q}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-[9px] t-text-muted">
              Turns {summary.turnRange[0]}-{summary.turnRange[1]}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
