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
    <section className="flex-none border-b px-4 py-3" style={{ borderColor: 'var(--color-border)' }}>
      <div className="rounded-lg border p-3 t-card-amber">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-accent-amber)' }}>
            Blocking Question
          </div>
          <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
            turn-{turnNumber.toString().padStart(4, '0')}
          </span>
        </div>

        <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--color-text)' }}>
          {question}
        </p>

        {evidencePath && (
          <div className="mt-1.5 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
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
              className="rounded-md border px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-40"
              style={{ borderColor: 'rgba(245,158,11,0.35)', color: 'var(--color-accent-amber)' }}
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
            className="flex-1 resize-y rounded-lg border bg-transparent px-3 py-2 text-xs outline-none focus:border-amber-500"
            style={{ borderColor: 'var(--color-input-border)', color: 'var(--color-text)' }}
            placeholder="Provide the missing info or decision..."
          />
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="self-end rounded-lg px-3 py-2 text-[11px] font-semibold text-black transition-opacity disabled:opacity-40"
            style={{ background: 'var(--color-action-loop)' }}
          >
            {submitting ? 'Sending...' : 'Send & Continue'}
          </button>
        </div>
      </div>
    </section>
  )
}
