/** Anything that can tell whether a node sits inside it, like a DOM element. */
interface Container {
  contains: (node: Node | null) => boolean
}

/**
 * Whether a pointer press on `target` should close a menu. Presses inside the menu don't, and
 * neither do presses on its trigger: the trigger's own click toggles the menu, so closing here
 * as well would reopen it straight away.
 */
export function closesMenu(
  target: EventTarget | null,
  menu: Container | null,
  trigger: Container | null = null,
): boolean {
  const node = target as Node | null
  if (menu?.contains(node)) return false
  if (trigger?.contains(node)) return false
  return true
}
