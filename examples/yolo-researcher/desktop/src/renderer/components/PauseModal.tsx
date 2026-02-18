interface PauseModalProps {
  turnNumber: number
  question: string
  evidencePath?: string
  replyText: string
  onReplyTextChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  submitting?: boolean
}

const QUICK_OPTIONS = [
  '继续按你的判断推进。',
  '先给我最小可行修复步骤。',
  '告诉我你还缺什么权限或参数。'
]

export default function PauseModal({
  turnNumber,
  question,
  evidencePath,
  replyText,
  onReplyTextChange,
  onSubmit,
  disabled = false,
  submitting = false
}: PauseModalProps) {
  const canSubmit = !disabled && !submitting && Boolean(replyText.trim())

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4">
      <div className="t-bg-surface t-border w-full max-w-2xl rounded-xl border p-4 shadow-2xl">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="t-text-muted text-xs font-semibold uppercase tracking-wider">
            Paused - User Input Required
          </div>
          <div className="t-text-muted text-[11px]">
            turn-{turnNumber.toString().padStart(4, '0')}
          </div>
        </div>

        <div className="t-bg-elevated t-border-subtle rounded-lg border p-3">
          <p className="t-text text-sm whitespace-pre-wrap leading-relaxed">
            {question}
          </p>
          {evidencePath && (
            <div className="t-text-muted mt-2 text-xs">
              {evidencePath}
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {QUICK_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onReplyTextChange(option)}
              disabled={disabled || submitting}
              className="t-btn-warning-ghost rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-40"
            >
              {option}
            </button>
          ))}
        </div>

        <div className="mt-3 flex gap-2">
          <textarea
            value={replyText}
            onChange={(event) => onReplyTextChange(event.target.value)}
            rows={3}
            disabled={disabled || submitting}
            className="t-input flex-1 resize-y rounded-lg border bg-transparent px-3 py-2 text-sm"
            placeholder="Provide the missing information/decision..."
          />
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="t-btn-accent self-end rounded-lg px-3 py-2 text-xs font-semibold transition-opacity disabled:opacity-40"
          >
            {submitting ? 'Sending...' : 'Send & Resume'}
          </button>
        </div>
      </div>
    </div>
  )
}
