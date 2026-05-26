import React, { useEffect, useState } from 'react'
import { Check, Loader2, Sparkles, Circle, XCircle } from 'lucide-react'

/**
 * Multi-stage progress strip shown while an AI merge is in flight.
 *
 * The backend (`'sharing:ai-merge'`) is single-shot and gives us no progress
 * signals. So the stages and their timings here are SYNTHETIC — they're a
 * truthful representation of "what the AI is broadly doing" but not derived
 * from real backend events. The point is to give the user a sense of motion
 * and an honest sense of how long it's taken, instead of a blank spinner.
 *
 * Cancel is also UI-only: it dismisses the progress strip and frees the file
 * row, but the upstream LLM request keeps running until the model returns
 * (and its tokens are still spent). We surface that fact in the hint text so
 * the user isn't surprised.
 */
interface Stage {
  /** Seconds from start when this stage begins. */
  at: number
  label: string
}

const STAGES: readonly Stage[] = [
  { at: 0, label: 'Sending versions to AI' },
  { at: 2, label: 'Reading common ancestor' },
  { at: 5, label: 'Reconciling differences' },
  { at: 15, label: 'Finalizing merge' },
] as const

export function AiMergeProgress({ onCancel }: { onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const start = Date.now()
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 250)
    return () => clearInterval(id)
  }, [])

  // Find the index of the currently active stage.
  let activeIndex = 0
  for (let i = STAGES.length - 1; i >= 0; i--) {
    if (elapsed >= STAGES[i].at) {
      activeIndex = i
      break
    }
  }

  return (
    <div className="border-t border-b t-border shrink-0 px-4 py-3 t-bg-base">
      <div className="flex items-center gap-3 mb-2">
        <Sparkles size={14} className="t-text-accent shrink-0" />
        <div className="text-[12px] font-medium t-text">Merging with AI</div>
        <div className="text-[11px] t-text-muted">· {elapsed}s elapsed</div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] t-text-secondary hover:t-text border t-border-subtle hover:t-bg-hover"
          title="Dismisses this progress strip and unmarks the file. The model request keeps running upstream until it returns; its tokens are still spent."
        >
          <XCircle size={11} />
          Cancel
        </button>
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        {STAGES.map((stage, i) => {
          const completed = i < activeIndex
          const active = i === activeIndex
          return (
            <React.Fragment key={stage.label}>
              {i > 0 && (
                <span
                  className={`h-px flex-1 max-w-[40px] ${
                    completed ? 't-bg-accent' : 't-bg-hover'
                  }`}
                  aria-hidden="true"
                />
              )}
              <div
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded ${
                  active ? 't-bg-hover' : ''
                }`}
              >
                <StageIcon completed={completed} active={active} />
                <span
                  className={`text-[11px] ${
                    completed
                      ? 't-text-secondary'
                      : active
                        ? 't-text'
                        : 't-text-muted'
                  }`}
                >
                  {stage.label}
                </span>
              </div>
            </React.Fragment>
          )
        })}
      </div>

      {elapsed > 20 && (
        <div className="mt-2 text-[10.5px] t-text-muted">
          Larger files can take 30 s or more. The cancel button only dismisses the UI — the model is still working in the background.
        </div>
      )}
    </div>
  )
}

function StageIcon({ completed, active }: { completed: boolean; active: boolean }) {
  if (completed) return <Check size={11} className="t-text-success shrink-0" />
  if (active) return <Loader2 size={11} className="animate-spin t-text-accent shrink-0" />
  return <Circle size={11} className="t-text-muted shrink-0" />
}
