/** Where a key pressed on a tab in the tab bar leads: focus another tab, or activate one. */
export interface TabKeyTarget {
  id: string
  activate: boolean
}

const STEPS: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1 }

/**
 * Tab list keys (WAI-ARIA tabs, manual activation): Left / Right move focus and wrap, Home /
 * End jump to the ends, Enter and Space activate the focused tab. Matches `KeyboardEvent.code`.
 */
export function tabKeyTarget(
  ids: readonly string[],
  focusedId: string | null,
  code: string,
): TabKeyTarget | null {
  const index = focusedId === null ? -1 : ids.indexOf(focusedId)
  if (index === -1 || ids.length === 0) return null
  if (code === "Enter" || code === "NumpadEnter" || code === "Space") {
    return { id: ids[index], activate: true }
  }
  if (code === "Home") return { id: ids[0], activate: false }
  if (code === "End") return { id: ids[ids.length - 1], activate: false }
  const step = STEPS[code]
  if (!step) return null
  return { id: ids[(index + step + ids.length) % ids.length], activate: false }
}
