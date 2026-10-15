import { X } from "lucide-react"
import { useEffect } from "react"
import { TOAST_DURATION_MS, useToastStore, type Toast } from "./toastStore"
import "./ui.css"

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss)

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [toast.id, dismiss])

  return (
    <div
      className="ui-toast"
      data-tone={toast.tone}
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <div className="ui-toast__text">
        <span>{toast.message}</span>
        {toast.detail && <span className="ui-toast__detail">{toast.detail}</span>}
      </div>
      <button
        type="button"
        className="ui-icon-button"
        aria-label="Dismiss"
        onClick={() => dismiss(toast.id)}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

/** Renders queued toasts in the bottom-right corner. Mount once. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="ui-toaster" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
