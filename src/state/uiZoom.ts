import { stepZoom, type ZoomAction } from "../lib/zoom"
import { applyUiZoom, useSettingsStore } from "./settingsStore"
import { CLOSE_SAVE_TIMEOUT_MS, onWindowClose, withTimeout } from "./workspaceSync"

/**
 * Zoom steps apply at once but save once, this long after the last, so a held or repeated key
 * costs one write.
 */
export const ZOOM_SAVE_DELAY_MS = 300

/** The level on screen but not saved yet, which the next step starts from. */
let unsaved: number | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function dropUnsaved(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
  unsaved = null
}

function saveUnsaved(): Promise<void> {
  const level = unsaved
  dropUnsaved()
  const { settings, update } = useSettingsStore.getState()
  if (level === null || level === settings.uiZoom) return Promise.resolve()
  return update({ uiZoom: level }).then(() => undefined)
}

/** The level on screen: a step waiting to be saved, else the setting. */
export function shownUiZoom(): number {
  return unsaved ?? useSettingsStore.getState().settings.uiZoom
}

/**
 * Zooms by `action` from the level on screen and saves once the steps pause. Returns the new
 * level, or null while the saved level hasn't loaded (stepping would start from the default).
 */
export function stepUiZoom(action: ZoomAction): number | null {
  if (useSettingsStore.getState().status !== "ready") return null
  const current = shownUiZoom()
  const next = stepZoom(current, action)
  if (next === current) return next
  unsaved = next
  applyUiZoom(next)
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveUnsaved(), ZOOM_SAVE_DELAY_MS)
  return next
}

/**
 * Picks a level outright (the Settings picker) and saves it now. A step still waiting is
 * dropped: saved later, it would undo this choice.
 */
export function setUiZoom(level: number): Promise<boolean> {
  dropUnsaved()
  return useSettingsStore.getState().update({ uiZoom: level })
}

/** Saves a step still waiting now instead of after the pause. */
export function flushUiZoom(): Promise<void> {
  return saveTimer === null ? Promise.resolve() : saveUnsaved()
}

/**
 * Mounted once by the shell. Applies the saved level once settings load and whenever it changes,
 * except while a newer step waits to be saved (an earlier save failing and rolling back mustn't
 * flash the older level), and saves a waiting step before the window closes. It follows the
 * store synchronously, so `--ui-zoom` is set before anything rendered from the same change paints.
 */
export function startUiZoomSync(onClose = onWindowClose): () => void {
  const follow = (
    state: ReturnType<typeof useSettingsStore.getState>,
    prev?: ReturnType<typeof useSettingsStore.getState>,
  ) => {
    if (state.status !== "ready" || unsaved !== null) return
    if (prev?.status === "ready" && prev.settings.uiZoom === state.settings.uiZoom) return
    applyUiZoom(state.settings.uiZoom)
  }
  follow(useSettingsStore.getState())
  const offSettings = useSettingsStore.subscribe(follow)
  const offClose = onClose(() => withTimeout(flushUiZoom(), CLOSE_SAVE_TIMEOUT_MS))
  return () => {
    offSettings()
    offClose()
  }
}

/** Test seam: drops a waiting step and its timer. */
export function resetUiZoom(): void {
  dropUnsaved()
}
