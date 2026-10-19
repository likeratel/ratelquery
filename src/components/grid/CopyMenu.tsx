import { ChevronDown, Copy } from "lucide-react"
import { useCallback, useRef, useState } from "react"
import { Button } from "../ui/Button"
import { Menu } from "../ui/Menu"
import { copyMenuItems, type CopyMenuOptions } from "./copyMenuItems"

/** "Copy ▾" toolbar button offering the same items as the grid's context menu. */
export function CopyMenu(props: CopyMenuOptions) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
  }, [])

  return (
    <div className="ui-menu-anchor" ref={rootRef}>
      <Button
        ref={triggerRef}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Copy size={12} strokeWidth={2} />
        Copy
        <ChevronDown size={12} strokeWidth={2} />
      </Button>
      {open && (
        <Menu
          label="Copy"
          className="ui-menu--dropdown grid-menu"
          triggerRef={triggerRef}
          onClose={close}
          items={copyMenuItems(props)}
        />
      )}
    </div>
  )
}
