import { useEffect, useId, useRef, type ReactNode } from "react"
import "./ui.css"

interface DialogProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Accessible description shown under the title. */
  description?: ReactNode
}

/**
 * Centered modal built on the native <dialog> element, which gives focus trapping,
 * top-layer stacking and inert background for free. Mount it only while open.
 */
export function Dialog({ title, onClose, children, footer, description }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    if (!node.open) node.showModal()
    return () => {
      if (node.open) node.close()
      previouslyFocused?.focus?.()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className="ui-dialog"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Esc: keep React in control of the open state.
        event.preventDefault()
        onClose()
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="ui-dialog__panel">
        <header className="ui-dialog__header">
          <h2 id={titleId} className="ui-dialog__title">
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="ui-dialog__description">
              {description}
            </p>
          )}
        </header>
        <div className="ui-dialog__body">{children}</div>
        {footer && <footer className="ui-dialog__footer">{footer}</footer>}
      </div>
    </dialog>
  )
}
