import { invoke as tauriInvoke } from "@tauri-apps/api/core"

export type AppErrorKind =
  "invalid_input" | "not_found" | "connection" | "query" | "credential" | "io" | "unknown"

export interface AppError {
  kind: AppErrorKind
  message: string
}

export type Transport = (command: string, args?: Record<string, unknown>) => Promise<unknown>

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "invalid_input",
  "not_found",
  "connection",
  "query",
  "credential",
  "io",
])

/** Turns whatever a transport rejected with into a structured AppError. */
export function normalizeError(raw: unknown): AppError {
  if (typeof raw === "object" && raw !== null && "kind" in raw && "message" in raw) {
    const { kind, message } = raw as { kind: unknown; message: unknown }
    if (typeof kind === "string" && typeof message === "string") {
      return { kind: KNOWN_KINDS.has(kind) ? (kind as AppErrorKind) : "unknown", message }
    }
  }
  if (raw instanceof Error) return { kind: "unknown", message: raw.message }
  if (typeof raw === "string") return { kind: "unknown", message: raw }
  return { kind: "unknown", message: "Unexpected error" }
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppError).kind === "string" &&
    typeof (value as AppError).message === "string"
  )
}

let transport: Transport = (command, args) => tauriInvoke(command, args)

/** Test seam: swap the IPC transport for a fake. Returns a restore function. */
export function setTransport(next: Transport): () => void {
  const previous = transport
  transport = next
  return () => {
    transport = previous
  }
}

export async function ipc<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await transport(command, args)) as T
  } catch (raw) {
    throw normalizeError(raw)
  }
}
