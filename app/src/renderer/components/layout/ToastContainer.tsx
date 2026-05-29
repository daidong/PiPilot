import React from 'react'
import { X, Info, CheckCircle2, AlertTriangle } from 'lucide-react'
import { useToastStore, type Toast } from '../../stores/toast-store'

/**
 * Renders the active toast stack in the top-right corner.
 *
 * Mount once at app top-level (alongside other modals in App.tsx). The
 * component is cheap when idle — returns null when the store has no
 * toasts. z-index sits BELOW the modal stack (z-[70-75]) so a modal
 * always wins focus, and ABOVE the StatusBar/sidebars so toasts aren't
 * occluded by ordinary chrome.
 */
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div
      className="fixed top-12 right-4 z-[60] flex flex-col gap-2 pointer-events-none"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <ToastView key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  )
}

const variantClasses: Record<NonNullable<Toast['variant']>, string> = {
  info: 't-border-accent-soft',
  success: 'border-emerald-500/40',
  warning: 'border-amber-500/40',
}

function VariantIcon({ variant }: { variant: Toast['variant'] }) {
  if (variant === 'success') return <CheckCircle2 size={14} className="text-emerald-500 shrink-0 mt-px" />
  if (variant === 'warning') return <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-px" />
  return <Info size={14} className="t-text-accent shrink-0 mt-px" />
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const variant = toast.variant ?? 'info'
  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-auto flex items-start gap-2 w-80 px-3 py-2.5 rounded-lg border shadow-lg t-bg-surface t-text ${variantClasses[variant]}`}
    >
      <VariantIcon variant={variant} />
      <div className="flex-1 min-w-0 text-[12px] leading-snug">
        <div className="t-text">{toast.message}</div>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action!.onClick()
              onDismiss()
            }}
            className="mt-1 inline-flex items-center text-[11.5px] font-medium t-text-accent hover:opacity-80"
          >
            {toast.action.label} →
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="t-text-muted hover:t-text shrink-0 mt-px"
      >
        <X size={12} />
      </button>
    </div>
  )
}
