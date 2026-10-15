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
  /** What the app uses now: `saved` with the patches that are still saving applied on top. */
  settings: Settings
  /** Last value the backend confirmed; a failed save rolls back to it. */
  saved: Settings
  status: SettingsStatus
  /** Set when `settings_get` failed; the defaults stay in use. */
  loadError: string | null
  load: () => Promise<void>
  /**
   * Applies the patch at once, then sends only the patch (the backend deep-merges it into the
   * stored settings and returns the result). Returns false when the save failed and rolled back.
   */
  update: (patch: SettingsPatch) => Promise<boolean>
}

interface PendingPatch {
  seq: number
  patch: SettingsPatch
}

/**
 * Every request (load or save) takes the next sequence number when it is sent. A response
 * becomes `saved` only when it is newer than the one already there, so a slow `settings_get`
 * can't replace what a later save confirmed.
 */
let requestSeq = 0
let savedSeq = 0
let loadToken = 0
let pending: readonly PendingPatch[] = []

const withPending = (base: Settings): Settings =>
  pending.reduce((acc, entry) => mergeSettings(acc, entry.patch), base)

export const useSettingsStore = create<SettingsStore>((set, get) => {
  /** Records a backend response from request `seq` and re-applies the unsaved patches. */
  const accept = (seq: number, value: Settings) => {
    if (seq > savedSeq) {
      savedSeq = seq
      set({ saved: value, settings: withPending(value) })
    } else {
      set((state) => ({ settings: withPending(state.saved) }))
    }
  }

  const dropPending = (seq: number) => {
    pending = pending.filter((entry) => entry.seq !== seq)
  }

  return {
    settings: DEFAULT_SETTINGS,
    saved: DEFAULT_SETTINGS,
    status: "idle",
    loadError: null,

    load: async () => {
      const token = ++loadToken
      const seq = ++requestSeq
      set({ status: "loading", loadError: null })
      try {
        const settings = await settingsApi.get()
        accept(seq, settings)
        if (token === loadToken) set({ status: "ready" })
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
      const seq = ++requestSeq
      pending = [...pending, { seq, patch }]
      set({ settings: next })
      try {
        const saved = await settingsApi.set(patch)
        dropPending(seq)
        accept(seq, saved)
        return true
      } catch (raw) {
        dropPending(seq)
        const error = normalizeError(raw)
        set((state) => ({ settings: withPending(state.saved) }))
        showToast({ tone: "error", message: "Couldn't save settings", detail: error.message })
        return false
      }
    },
  }
})

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
  requestSeq = 0
  savedSeq = 0
  loadToken = 0
  pending = []
  useSettingsStore.setState({
    settings: DEFAULT_SETTINGS,
    saved: DEFAULT_SETTINGS,
    status: "idle",
    loadError: null,
  })
}
