/**
 * Widths of the resizable side panels, clamped to a per-panel range and remembered across
 * launches in `localStorage`. Storage can be missing or throw (private mode, quota), so every
 * access is guarded and a bad stored value falls back to the panel's default.
 */

export type PanelId = "sidebar" | "dynamoTables" | "dynamoSide"

export interface PanelSpec {
  readonly defaultWidth: number
  readonly min: number
  readonly max: number
}

export const PANEL_SPECS: Readonly<Record<PanelId, PanelSpec>> = {
  sidebar: { defaultWidth: 264, min: 180, max: 480 },
  dynamoTables: { defaultWidth: 220, min: 160, max: 400 },
  dynamoSide: { defaultWidth: 400, min: 280, max: 800 },
}

export type PanelWidths = Readonly<Record<PanelId, number>>

const PANEL_IDS = Object.keys(PANEL_SPECS) as PanelId[]

const STORAGE_PREFIX = "ratelquery.panelWidth."

/** The subset of `Storage` the helpers use, so tests can pass a fake. */
export interface WidthStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function clampWidth(spec: PanelSpec, width: number): number {
  if (!Number.isFinite(width)) return spec.defaultWidth
  return Math.round(Math.min(spec.max, Math.max(spec.min, width)))
}

/** A stored value is used only when it is a plain finite number; anything else is the default. */
export function parseStoredWidth(spec: PanelSpec, raw: string | null): number {
  if (raw === null || !/^\s*-?\d+(\.\d+)?\s*$/.test(raw)) return spec.defaultWidth
  return clampWidth(spec, Number(raw))
}

export function defaultPanelWidths(): PanelWidths {
  return Object.fromEntries(PANEL_IDS.map((id) => [id, PANEL_SPECS[id].defaultWidth])) as Record<
    PanelId,
    number
  >
}

function browserStorage(): WidthStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

export function loadPanelWidths(storage: WidthStorage | null = browserStorage()): PanelWidths {
  const entries = PANEL_IDS.map((id) => {
    const spec = PANEL_SPECS[id]
    try {
      return [id, parseStoredWidth(spec, storage?.getItem(STORAGE_PREFIX + id) ?? null)]
    } catch {
      return [id, spec.defaultWidth]
    }
  })
  return Object.fromEntries(entries) as Record<PanelId, number>
}

/** Best effort: a failed write only means the width isn't remembered next launch. */
export function savePanelWidth(
  id: PanelId,
  width: number,
  storage: WidthStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_PREFIX + id, String(width))
  } catch {
    // Storage full or unavailable; the in-memory width still applies.
  }
}

/**
 * Width after dragging a handle by `deltaX` pixels. A handle on the panel's right edge ("end")
 * grows the panel when dragged right; one on its left edge ("start") grows it when dragged left.
 */
export function dragWidth(
  spec: PanelSpec,
  startWidth: number,
  deltaX: number,
  edge: "start" | "end",
): number {
  return clampWidth(spec, startWidth + (edge === "end" ? deltaX : -deltaX))
}
