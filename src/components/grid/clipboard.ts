import { showToast } from "../ui/toastStore"

/** Writes text to the clipboard, reporting failures as a toast. */
export function copyToClipboard(text: string): void {
  if (!navigator.clipboard) {
    showToast({ tone: "error", message: "The clipboard isn't available here" })
    return
  }
  navigator.clipboard.writeText(text).catch((error: unknown) => {
    showToast({
      tone: "error",
      message: "Couldn't copy to the clipboard",
      detail: error instanceof Error ? error.message : undefined,
    })
  })
}
