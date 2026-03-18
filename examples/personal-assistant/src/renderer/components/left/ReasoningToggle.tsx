import { ReasoningToggle as SharedReasoningToggle } from '@shared/components/left/ReasoningToggle'
import { useUIStore } from '../../stores/ui-store'

export function ReasoningToggle() {
  const selectedModel = useUIStore((s) => s.selectedModel)
  const reasoningEffort = useUIStore((s) => s.reasoningEffort)
  const setReasoningEffort = useUIStore((s) => s.setReasoningEffort)

  return (
    <SharedReasoningToggle
      selectedModel={selectedModel}
      reasoningEffort={reasoningEffort}
      onChangeEffort={setReasoningEffort}
    />
  )
}
