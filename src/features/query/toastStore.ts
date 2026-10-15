import { showToast, type ToastTone as UiToastTone } from "../../components/ui/toastStore"

/** Tones used by the query and DynamoDB features; "danger" maps to the shared "error" tone. */
export type ToastTone = "info" | "success" | "danger"

const TONES: Record<ToastTone, UiToastTone> = { info: "info", success: "success", danger: "error" }

/** Shorthand over the shared toaster (`components/ui`), which renders every toast in the app. */
export function toast(message: string, tone: ToastTone = "info"): number {
  return showToast({ tone: TONES[tone], message })
}
