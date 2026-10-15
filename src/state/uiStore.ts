import { create } from "zustand"

export type ThemePreference = "system" | "dark" | "light"

interface UiState {
  theme: ThemePreference
  sidebarCollapsed: boolean
  setTheme: (theme: ThemePreference) => void
  toggleSidebar: () => void
}

export const useUiStore = create<UiState>((set) => ({
  theme: "system",
  sidebarCollapsed: false,
  setTheme: (theme) => set({ theme }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}))

export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement
  if (theme === "system") root.removeAttribute("data-theme")
  else root.setAttribute("data-theme", theme)
}
