import { QuestionPanel } from './QuestionPanel'

interface CheckpointModalProps {
  question: string
  context?: string
  quickOptions: string[]
  onQuickReply: (text: string) => void
  onSubmit: (text: string) => void
}

export function CheckpointModal({ question, context, quickOptions, onQuickReply, onSubmit }: CheckpointModalProps) {
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6">
      <div className="pointer-events-auto w-full max-w-2xl rounded-2xl border border-amber-500/40 t-bg-surface p-4 shadow-2xl">
        <QuestionPanel
          question={question}
          context={context}
          quickOptions={quickOptions}
          onQuickReply={onQuickReply}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  )
}
