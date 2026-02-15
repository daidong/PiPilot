import { FolderOpen } from 'lucide-react'

export function FolderGate({ onPick }: { onPick: () => Promise<void> }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center px-8 t-text">
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-50" />
      <div className="max-w-xl text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl t-bg-surface border t-border">
          <FolderOpen className="h-9 w-9 t-accent-teal" />
        </div>
        <h1 className="mb-2 text-3xl font-semibold" style={{ fontFamily: "'Playfair Display', serif" }}>YOLO Researcher</h1>
        <p className="mb-8 text-sm t-text-secondary">
          Select a project folder to start autonomous YOLO turns with structured checkpoints.
        </p>
        <button
          className="rounded-xl bg-teal-500 px-6 py-3 text-sm font-medium text-white hover:bg-teal-400 transition-colors no-drag"
          onClick={onPick}
        >
          Open Project Folder
        </button>
      </div>
    </div>
  )
}
