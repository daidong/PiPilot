import React from 'react'
import { Folder } from 'lucide-react'
import { useSessionStore } from '../../stores/session-store'
import { useEntityStore } from '../../stores/entity-store'

export function UserProfile() {
  const projectPath = useSessionStore((s) => s.projectPath)
  const pickFolder = useSessionStore((s) => s.pickFolder)
  const refreshEntities = useEntityStore((s) => s.refreshAll)

  const handlePickFolder = async () => {
    const picked = await pickFolder()
    if (picked) {
      await refreshEntities()
    }
  }

  const displayPath = projectPath
    ? projectPath.replace(/^.*\//, '')
    : 'Click to open a project'

  return (
    <button
      onClick={handlePickFolder}
      className="no-drag flex items-center gap-2 w-full text-left text-sm t-text-secondary hover:t-text transition-colors"
    >
      <Folder size={16} className="shrink-0" />
      <span className="truncate">{displayPath}</span>
    </button>
  )
}
