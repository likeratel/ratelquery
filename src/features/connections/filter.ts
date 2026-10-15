import type { ConnectionConfig } from "../../lib/connections"
import { DEFAULT_WORKGROUP } from "./form"

/** The sidebar only shows a search box once the list is long enough to need one. */
export const SEARCH_THRESHOLD = 8

export function connectionSubtitle(config: ConnectionConfig): string {
  if (config.kind === "mysql") return `${config.host}:${config.port}`
  if (config.kind === "athena") return `${config.region} · ${config.workgroup ?? DEFAULT_WORKGROUP}`
  return config.endpoint ? `${config.region} · ${config.endpoint}` : config.region
}

export function filterConnections(
  connections: readonly ConnectionConfig[],
  query: string,
): ConnectionConfig[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...connections]
  return connections.filter((config) =>
    `${config.name} ${connectionSubtitle(config)}`.toLowerCase().includes(needle),
  )
}

export function sortByName(connections: readonly ConnectionConfig[]): ConnectionConfig[] {
  return [...connections].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  )
}

/** Returns a new list with `saved` inserted or replacing the entry with the same id. */
export function upsertConnection(
  connections: readonly ConnectionConfig[],
  saved: ConnectionConfig,
): ConnectionConfig[] {
  const exists = connections.some((c) => c.id === saved.id)
  const next = exists
    ? connections.map((c) => (c.id === saved.id ? saved : c))
    : [...connections, saved]
  return sortByName(next)
}
