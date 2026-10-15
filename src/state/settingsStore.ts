import { isTauri } from "@tauri-apps/api/core"
import { create } from "zustand"
import { showToast } from "../components/ui/toastStore"
import { normalizeError } from "../lib/ipc"
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  settingsApi,
  settingsSchema,
  type Settings,
  type SettingsPatch,
} from "../lib/settings"

export type SettingsStatus = "idle" | "loading" | "ready"

interface SettingsStore {
  /** What the app uses now; includes optimistic changes that are still saving. */
  settings: Settings
  /** Last value the backend confirmed; a failed save rolls back to it. */
  saved: Settings
  status: SettingsStatus
  /** Set when `settings_get` failed; the defaults stay in use. */
  loadError: string | null
  load: () => Promise<void>
  /** Applies the patch at once, then saves. Returns false when the save failed and rolled back. */
  update: (patch: SettingsPatch) => Promise<boolean>
}

let loadToken = 0
let updateToken = 0

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  saved: DEFAULT_SETTINGS,
  status: "idle",
  loadError: null,

  load: async () => {
    const token = ++loadToken
    const updatesBefore = updateToken
    set({ status: "loading", loadError: null })
    try {
      const settings = await settingsApi.get()
      // A change made while loading wins over the stored value.
      if (token !== loadToken || updateToken !== updatesBefore) {
        set({ status: "ready" })
        return
      }
      set({ settings, saved: settings, status: "ready" })
    } catch (raw) {
      if (token !== loadToken) return
      const error = normalizeError(raw)
      set({ status: "ready", loadError: error.message })
      // Outside the desktop shell (plain `vite dev`) there is no backend; defaults are expected.
      if (isTauri()) {
        showToast({ tone: "error", message: "Couldn't load settings", detail: error.message })
      }
    }
  },

  update: async (patch) => {
    const next = mergeSettings(get().settings, patch)
    const checked = settingsSchema.safeParse(next)
    if (!checked.success) {
      showToast({
        tone: "error",
        message: "Setting out of range",
        detail: checked.error.issues[0]?.message,
      })
      return false
    }
    const token = ++updateToken
    set({ settings: next })
    try {
      const saved = await settingsApi.set(next)
      set(token === updateToken ? { saved, settings: saved } : { saved })
      return true
    } catch (raw) {
      const error = normalizeError(raw)
      set((state) => ({ settings: state.saved }))
      showToast({ tone: "error", message: "Couldn't save settings", detail: error.message })
      return false
    }
  },
}))

/** Current settings outside React (run paths, request builders). */
export function currentSettings(): Settings {
  return useSettingsStore.getState().settings
}

/** Mirrors the editor font size into the CSS variable both code editors read. */
export function applyEditorFontSize(px: number): void {
  document.documentElement.style.setProperty("--editor-font-size", `${px}px`)
}

/** Test seam: back to defaults and a fresh token state. */
export function resetSettingsStore(): void {
  loadToken = 0
  updateToken = 0
  useSettingsStore.setState({
    settings: DEFAULT_SETTINGS,
    saved: DEFAULT_SETTINGS,
    status: "idle",
    loadError: null,
  })
}
