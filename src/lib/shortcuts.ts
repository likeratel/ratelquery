/**
 * Keyboard shortcuts matched on the physical key (`KeyboardEvent.code`), not the
 * produced character. This keeps `Cmd+Enter` or `Cmd+K` working while a Korean,
 * Japanese or other IME layout is active, which is where most desktop DB tools fail.
 */

export interface Shortcut {
  /** Physical key code, e.g. "Enter", "KeyK", "Slash". */
  code: string
  /** Platform primary modifier: Cmd on macOS, Ctrl elsewhere. */
  mod: boolean
  shift: boolean
  alt: boolean
}

export interface KeyLike {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const SINGLE_CHAR_CODES: Record<string, string> = {
  "/": "Slash",
  ",": "Comma",
  ".": "Period",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
}

/** Parses "Mod+Shift+Enter" style definitions into a Shortcut. */
export function parseShortcut(definition: string): Shortcut {
  const parts = definition.split("+").map((part) => part.trim())
  const key = parts.at(-1)
  if (!key) throw new Error(`Empty shortcut definition: "${definition}"`)
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()))
  const unknown = [...modifiers].find((m) => !["mod", "shift", "alt"].includes(m))
  if (unknown) throw new Error(`Unknown modifier "${unknown}" in "${definition}"`)
  return {
    code: keyToCode(key),
    mod: modifiers.has("mod"),
    shift: modifiers.has("shift"),
    alt: modifiers.has("alt"),
  }
}

function keyToCode(key: string): string {
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`
    if (/[0-9]/.test(key)) return `Digit${key}`
    const mapped = SINGLE_CHAR_CODES[key]
    if (mapped) return mapped
  }
  return key
}

export function isMac(platform: string = navigator.platform): boolean {
  return /mac|iphone|ipad/i.test(platform)
}

export function matchesShortcut(event: KeyLike, shortcut: Shortcut, mac = isMac()): boolean {
  const modPressed = mac ? event.metaKey : event.ctrlKey
  const otherModPressed = mac ? event.ctrlKey : event.metaKey
  return (
    event.code === shortcut.code &&
    modPressed === shortcut.mod &&
    !otherModPressed &&
    event.shiftKey === shortcut.shift &&
    event.altKey === shortcut.alt
  )
}

/** Human-readable label such as "⌘⏎" or "Ctrl+Enter". */
export function formatShortcut(shortcut: Shortcut, mac = isMac()): string {
  const keyLabel = codeToLabel(shortcut.code, mac)
  if (mac) {
    return [shortcut.alt ? "⌥" : "", shortcut.shift ? "⇧" : "", shortcut.mod ? "⌘" : "", keyLabel]
      .filter(Boolean)
      .join("")
  }
  return [
    shortcut.mod ? "Ctrl" : "",
    shortcut.alt ? "Alt" : "",
    shortcut.shift ? "Shift" : "",
    keyLabel,
  ]
    .filter(Boolean)
    .join("+")
}

function codeToLabel(code: string, mac: boolean): string {
  if (code.startsWith("Key")) return code.slice(3)
  if (code.startsWith("Digit")) return code.slice(5)
  if (code === "Enter") return mac ? "⏎" : "Enter"
  if (code === "Escape") return mac ? "⎋" : "Esc"
  const symbol = Object.entries(SINGLE_CHAR_CODES).find(([, c]) => c === code)?.[0]
  return symbol ?? code
}
