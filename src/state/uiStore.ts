import { create } from "zustand"
import type { ThemePreference } from "../lib/settings"

// The theme preference is a persisted setting (`settingsStore`); this module only applies it.
export type { ThemePreference }

interface UiState {
  sidebarCollapsed: boolean
  settingsOpen: boolean
  toggleSidebar: () => void
  openSettings: () => void
  closeSettings: () => void
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}))

const LIGHT_QUERY = "(prefers-color-scheme: light)"

export function resolveTheme(theme: ThemePreference, systemIsLight: boolean): "light" | "dark" {
  if (theme === "system") return systemIsLight ? "light" : "dark"
  return theme
}

/**
 * Applies the preference as a concrete `data-theme` so the stylesheet only needs one light
 * block. Returns a cleanup that stops following system changes.
 */
export function applyTheme(theme: ThemePreference): () => void {
  const root = document.documentElement
  const media = window.matchMedia(LIGHT_QUERY)
  const apply = () => root.setAttribute("data-theme", resolveTheme(theme, media.matches))
  apply()
  if (theme !== "system") return () => {}
  media.addEventListener("change", apply)
  return () => media.removeEventListener("change", apply)
}

export type Platform = "macos" | "windows" | "linux" | "unknown"

export function detectPlatform(userAgent: string): Platform {
  if (/mac os|macintosh/i.test(userAgent)) return "macos"
  if (/windows/i.test(userAgent)) return "windows"
  if (/linux/i.test(userAgent)) return "linux"
  return "unknown"
}

/** Lets the stylesheet reserve space for macOS traffic lights only where they exist. */
export function applyPlatformAttribute(): void {
  document.documentElement.setAttribute("data-platform", detectPlatform(navigator.userAgent))
}
