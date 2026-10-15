import { useEffect, useState } from "react"
import { athenaApi } from "../../lib/athena"
import type { WorkgroupRequest } from "./athenaWorkgroups"

export type WorkgroupsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; names: readonly string[] }
  | { status: "failed" }

/** Typing a region or key fires a listing only once the input settles for this long. */
const DEBOUNCE_MS = 400

type Answer =
  { key: string; status: "ready"; names: readonly string[] } | { key: string; status: "failed" }

/**
 * Lists the workgroups for `request` (read only), again whenever its key changes. A failure only
 * switches the Workgroup field to a text input, so the error itself is not surfaced further.
 */
export function useAthenaWorkgroups(request: WorkgroupRequest | null): WorkgroupsState {
  const [answer, setAnswer] = useState<Answer | null>(null)
  const key = request?.key ?? null

  useEffect(() => {
    // The key covers everything the listing sends, so the request of this render is current.
    const current = request
    if (key === null || !current) return
    let active = true
    const timer = setTimeout(() => {
      athenaApi.workgroups(current.config, current.secret).then(
        (names) => {
          if (active) setAnswer({ key, status: "ready", names })
        },
        () => {
          if (active) setAnswer({ key, status: "failed" })
        },
      )
    }, DEBOUNCE_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [key])

  if (key === null) return { status: "idle" }
  if (!answer || answer.key !== key) return { status: "loading" }
  return answer.status === "ready" ? { status: "ready", names: answer.names } : { status: "failed" }
}
