import React, { useState, useRef, useEffect } from 'react'
import { FileText, ChevronDown, Folder, Code, Terminal } from 'lucide-react'
import { useUIStore, type WorkingFile } from '../../stores/ui-store'
import { useEntityStore } from '../../stores/entity-store'

const api = (window as any).api

type EditorApp = 'finder' | 'zed' | 'cursor' | 'vscode'

interface EditorOption {
  id: EditorApp
  label: string
  icon: React.ReactNode
}

const EDITOR_OPTIONS: EditorOption[] = [
  { id: 'finder', label: 'Finder', icon: <Folder size={12} /> },
  { id: 'zed', label: 'Zed', icon: <Code size={12} /> },
  { id: 'cursor', label: 'Cursor', icon: <Terminal size={12} /> },
  { id: 'vscode', label: 'VS Code', icon: <Code size={12} /> },
]

const EXTERNAL_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
  'pdf',
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'
])

// Each row is ~24px (py-1 = 4px * 2 + text ~16px), show max 5
const MAX_HEIGHT = 120

export function WorkingFolder() {
  const workingFiles = useUIStore((s) => s.workingFiles)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [dropdownOpen])

  const handleOpenWith = async (app: EditorApp) => {
    setDropdownOpen(false)
    const result = await api.openFolderWith(app)
    if (!result.success) {
      console.error(`Failed to open with ${app}:`, result.error)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold t-text-muted uppercase tracking-wider">
          Working Folder
          {workingFiles.length > 0 && (
            <span className="ml-1.5 text-[10px] t-text-muted font-normal">
              ({workingFiles.length})
            </span>
          )}
        </h3>

        {/* Open with dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] t-text-muted t-bg-hover transition-colors"
            title="Open folder with..."
          >
            <Folder size={10} />
            <ChevronDown size={10} />
          </button>

          {dropdownOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 min-w-[100px] rounded-md border t-border t-bg-surface shadow-lg py-1">
              {EDITOR_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => handleOpenWith(opt.id)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs t-text-secondary t-bg-hover text-left"
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

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
  // Look up the real data entity by filePath so we use its actual UUID
  const dataEntity = useEntityStore((s) =>
    [...s.notes, ...s.docs].find((d) => d.filePath === file.path)
  )

  const handleClick = async () => {
    const ext = (file.name.split('.').pop() || '').toLowerCase()

    // Binary files: open directly in system default app
    if (EXTERNAL_EXTS.has(ext)) {
      api.openFile(file.path)
      return
    }

    // If a registered data entity exists, use its real id so pin/select works
    if (dataEntity) {
      openPreview({
        ...dataEntity,
        type: 'doc',
        title: dataEntity.title || dataEntity.name || file.name,
        filePath: file.path
      })
      return
    }

    // Fallback for files not yet registered as entities
    openPreview({
      id: file.path,
      type: 'doc',
      title: file.name,
      filePath: file.path,
      tags: [],
      createdAt: new Date(file.accessedAt).toISOString(),
      updatedAt: new Date(file.accessedAt).toISOString()
    })
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
