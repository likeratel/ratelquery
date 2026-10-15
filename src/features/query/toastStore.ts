import { create } from "zustand"

export type ToastTone = "info" | "success" | "danger"

export interface Toast {
  id: number
  message: string
  tone: ToastTone
}

const TOAST_MS = 3500

interface ToastState {
  toasts: readonly Toast[]
  push: (message: string, tone?: ToastTone) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, tone = "info") => {
    const id = nextId++
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }] }))
    setTimeout(() => get().dismiss(id), TOAST_MS)
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

export const toast = (message: string, tone?: ToastTone) =>
  useToastStore.getState().push(message, tone)
