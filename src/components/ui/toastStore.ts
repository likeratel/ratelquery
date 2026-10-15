import { create } from "zustand"

export type ToastTone = "info" | "success" | "warning" | "error"

export interface Toast {
  id: number
  tone: ToastTone
  message: string
  detail?: string
}

export const TOAST_DURATION_MS = 4500

interface ToastState {
  toasts: Toast[]
  push: (toast: Omit<Toast, "id">) => number
  dismiss: (id: number) => void
}

let nextId = 1

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    return id
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

export function showToast(toast: Omit<Toast, "id">): number {
  return useToastStore.getState().push(toast)
}
