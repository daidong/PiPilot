import React, { useState } from 'react'
import { FileText, ChevronDown, ChevronUp } from 'lucide-react'
import { useUIStore, type WorkingFile } from '../../stores/ui-store'

const api = (window as any).api
const MAX_VISIBLE = 5

export function WorkingFolder() {
  const workingFiles = useUIStore((s) => s.workingFiles)
  const [expanded, setExpanded] = useState(false)

  const visibleFiles = expanded ? workingFiles : workingFiles.slice(0, MAX_VISIBLE)
  const hiddenCount = workingFiles.length - MAX_VISIBLE

  return (
    <div>
      <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider mb-2">
        Working Folder
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
        <div className="space-y-1">
          {visibleFiles.map((f) => (
            <FileRow key={f.path} file={f} />
          ))}

          {hiddenCount > 0 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 w-full px-2 py-1.5 text-xs t-text-muted hover:t-text-secondary transition-colors"
            >
              {expanded ? (
                <>
                  <ChevronUp size={12} />
                  Show less
                </>
              ) : (
                <>
                  <ChevronDown size={12} />
                  {hiddenCount} more file{hiddenCount > 1 ? 's' : ''}
                </>
              )}
            </button>
          )}
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
      className="flex items-center gap-2 px-2 py-1.5 rounded-md t-bg-hover transition-colors text-sm w-full text-left cursor-pointer"
    >
      <FileText size={13} className="t-text-muted shrink-0" />
      <span className="t-text-secondary truncate">{file.name}</span>
    </button>
  )
}
