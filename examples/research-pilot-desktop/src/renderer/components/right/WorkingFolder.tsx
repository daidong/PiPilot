import React from 'react'
import { FileText } from 'lucide-react'
import { useUIStore, type WorkingFile } from '../../stores/ui-store'

const api = (window as any).api

// Each row is ~24px (py-1 = 4px * 2 + text ~16px), show max 5
const MAX_HEIGHT = 120

export function WorkingFolder() {
  const workingFiles = useUIStore((s) => s.workingFiles)

  return (
    <div>
      <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider mb-2">
        Working Folder
        {workingFiles.length > 0 && (
          <span className="ml-1.5 text-[10px] t-text-muted font-normal">
            ({workingFiles.length})
          </span>
        )}
      </h3>

      {workingFiles.length === 0 ? (
        <div className="rounded-lg border t-border t-bg-surface px-3 py-4 text-center">
          <div className="mx-auto mb-2 w-10 h-10 rounded-lg t-bg-elevated flex items-center justify-center">
            <FileText size={18} className="t-text-muted" />
          </div>
          <p className="text-xs t-text-muted">
            View and open files created during this task.
          </p>
        </div>
      ) : (
        <div
          className="space-y-1 overflow-y-auto"
          style={{ maxHeight: MAX_HEIGHT }}
        >
          {workingFiles.map((f) => (
            <FileRow key={f.path} file={f} />
          ))}
        </div>
      )}
    </div>
  )
}

function FileRow({ file }: { file: WorkingFile }) {
  const openPreview = useUIStore((s) => s.openPreview)

  const handleClick = async () => {
    try {
      const result = await api.readFile(file.path)
      if (result.success) {
        openPreview({
          id: file.path,
          type: 'note',
          title: file.name,
          content: result.content,
          tags: [],
          pinned: false,
          selectedForAI: false,
          createdAt: new Date(file.accessedAt).toISOString(),
          updatedAt: new Date(file.accessedAt).toISOString()
        })
      }
    } catch {
      // Silently ignore read errors
    }
  }

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1.5 px-2 py-1 rounded t-bg-hover transition-colors text-xs w-full text-left cursor-pointer"
    >
      <FileText size={11} className="t-text-muted shrink-0" />
      <span className="t-text-secondary truncate">{file.name}</span>
    </button>
  )
}
