import { useEffect } from 'react'
import { X } from 'lucide-react'

// Full-screen image preview (Finder-style). Rendered in-app instead of
// delegating data: URLs to window.open, which Electron hands to the OS and
// macOS rejects with "There is no application set to open the URL".
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center p-8"
      style={{ background: 'rgba(0,0,0,0.82)' }}
    >
      <img
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
      />
      <button
        onClick={onClose}
        aria-label="Close preview"
        className="absolute top-4 right-4 p-2 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors"
      >
        <X size={22} />
      </button>
    </div>
  )
}
