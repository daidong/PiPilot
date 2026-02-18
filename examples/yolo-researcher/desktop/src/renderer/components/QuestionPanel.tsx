interface QuestionPanelProps {
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
  '请先说明你还缺什么关键信息。',
  '请先给我一个最小验证步骤。'
]

export default function QuestionPanel({
  turnNumber,
  question,
  evidencePath,
  replyText,
  onReplyTextChange,
  onSubmit,
  disabled = false,
  submitting = false
}: QuestionPanelProps) {
  const canSubmit = !disabled && !submitting && Boolean(replyText.trim())

  return (
    <section className="t-border flex-none border-b px-4 py-3">
      <div className="t-bg-elevated t-border-subtle rounded-lg border p-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="t-text-muted text-[11px] font-semibold uppercase tracking-wider">
            Blocking Question
          </div>
          <span className="t-text-muted text-[10px]">
            turn-{turnNumber.toString().padStart(4, '0')}
          </span>
        </div>

        <p className="t-text text-xs leading-relaxed whitespace-pre-wrap">
          {question}
        </p>

        {evidencePath && (
          <div className="t-text-muted mt-1.5 text-[10px]">
            {evidencePath}
          </div>
        )}

        <div className="mt-2 flex flex-wrap gap-1.5">
          {QUICK_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onReplyTextChange(option)}
              disabled={disabled || submitting}
              className="t-btn-warning-ghost rounded-md border px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-40"
            >
              {option}
            </button>
          ))}
        </div>

        <div className="mt-2 flex gap-2">
          <textarea
            value={replyText}
            onChange={(event) => onReplyTextChange(event.target.value)}
            rows={2}
            disabled={disabled || submitting}
            className="t-input flex-1 resize-y rounded-lg border bg-transparent px-3 py-2 text-xs"
            placeholder="Provide the missing info or decision..."
          />
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="t-btn-accent self-end rounded-lg px-3 py-2 text-[11px] font-semibold transition-opacity disabled:opacity-40"
          >
            {submitting ? 'Sending...' : 'Send & Continue'}
          </button>
        </div>
      </div>
    </section>
  )
}
