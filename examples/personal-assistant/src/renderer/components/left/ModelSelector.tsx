import { ModelSelector as SharedModelSelector } from '@shared/components/left/ModelSelector'
import { useUIStore } from '../../stores/ui-store'

export function ModelSelector() {
  const selectedModel = useUIStore((s) => s.selectedModel)
  const setModel = useUIStore((s) => s.setModel)

  return (
    <SharedModelSelector
      selectedModel={selectedModel}
      onSelectModel={setModel}
    />
  )
}
