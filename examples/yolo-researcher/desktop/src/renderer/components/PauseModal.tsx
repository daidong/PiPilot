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
      <div className="w-full max-w-2xl rounded-xl border p-4 shadow-2xl" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-surface)' }}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-accent-amber)' }}>
            Paused - User Input Required
          </div>
          <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            turn-{turnNumber.toString().padStart(4, '0')}
          </div>
        </div>

        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-bg-elevated)' }}>
          <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--color-text)' }}>
            {question}
          </p>
          {evidencePath && (
            <div className="mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
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
              className="rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-40"
              style={{ borderColor: 'rgba(245,158,11,0.35)', color: 'var(--color-accent-amber)' }}
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
            className="flex-1 resize-y rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-amber-500"
            style={{ borderColor: 'var(--color-input-border)', color: 'var(--color-text)' }}
            placeholder="Provide the missing information/decision..."
          />
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="self-end rounded-lg px-3 py-2 text-xs font-semibold text-black transition-opacity disabled:opacity-40"
            style={{ background: 'var(--color-action-loop)' }}
          >
            {submitting ? 'Sending...' : 'Send & Resume'}
          </button>
        </div>
      </div>
    </div>
  )
}
