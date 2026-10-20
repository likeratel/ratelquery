/**
 * The query output log: one entry per executed statement (or per failed or cancelled run) with
 * what the database returned. Only SQL text and a summary are kept, never row data. Persisted
 * per connection in `query-output.json` (`query_output_load` / `query_output_save`).
 */
import { z } from "zod"
import type { ConnectionId } from "./connections"
import { ipc, type AppError } from "./ipc"
import type { QueryResult } from "./mysql"

/** What a statement returned. */
export type OutputOutcome =
  | { kind: "rows"; rowCount: number; truncated: boolean }
  | { kind: "exec"; affectedRows: number; lastInsertId: string | null }
  | { kind: "error"; message: string }
  | { kind: "cancelled" }

export interface OutputEntry {
  id: string
  connectionId: ConnectionId
  /** Query tab that ran it; the tab may be closed by now. */
  tabId: string
  /** Epoch ms when the statement finished. */
  at: number
  sql: string
  /** True when `sql` was cut to `MAX_OUTPUT_SQL_CHARS`. */
  sqlTruncated: boolean
  elapsedMs: number | null
  outcome: OutputOutcome
}

/** Entries per connection, oldest first. */
export type OutputLog = Readonly<Record<ConnectionId, readonly OutputEntry[]>>

export const EMPTY_OUTPUT_LOG: OutputLog = {}

/** Oldest entries of a connection are dropped past this many. */
export const MAX_OUTPUT_ENTRIES_PER_CONNECTION = 2000

/** Longer statements are stored cut, so a pasted dump can't bloat the file. */
export const MAX_OUTPUT_SQL_CHARS = 10_000

/** Encoded size the saved log is trimmed to (oldest first); the backend refuses 16 MiB. */
export const OUTPUT_FILE_BUDGET_BYTES = 12 * 1024 * 1024

const DAY_MS = 24 * 60 * 60 * 1000

/** Which entries the Output view lists. */
export type OutputScope = "tab" | "connection"

export interface EntryContext {
  connectionId: ConnectionId
  tabId: string
  /** When the run finished. */
  at: number
  newId: () => string
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

/**
 * The statement cut to `MAX_OUTPUT_SQL_CHARS` UTF-16 units, never between the two halves of a
 * surrogate pair: a lone surrogate isn't valid JSON for the backend, so every later save of the
 * log would fail.
 */
function clipSql(sql: string): { sql: string; sqlTruncated: boolean } {
  const trimmed = sql.trim()
  if (trimmed.length <= MAX_OUTPUT_SQL_CHARS) return { sql: trimmed, sqlTruncated: false }
  const end = isHighSurrogate(trimmed.charCodeAt(MAX_OUTPUT_SQL_CHARS - 1))
    ? MAX_OUTPUT_SQL_CHARS - 1
    : MAX_OUTPUT_SQL_CHARS
  return { sql: trimmed.slice(0, end), sqlTruncated: true }
}

function entry(
  ctx: EntryContext,
  sql: string,
  outcome: OutputOutcome,
  elapsedMs: number | null,
): OutputEntry {
  return {
    id: ctx.newId(),
    connectionId: ctx.connectionId,
    tabId: ctx.tabId,
    at: ctx.at,
    ...clipSql(sql),
    elapsedMs,
    outcome,
  }
}

function resultOutcome(result: QueryResult): OutputOutcome {
  return result.kind === "rows"
    ? { kind: "rows", rowCount: result.rowCount, truncated: result.truncated }
    : { kind: "exec", affectedRows: result.affectedRows, lastInsertId: result.lastInsertId }
}

/** One entry per statement of a finished run, in run order. */
export function entriesFromResults(
  ctx: EntryContext,
  results: readonly QueryResult[],
): OutputEntry[] {
  return results.map((r) => entry(ctx, r.statement, resultOutcome(r), r.elapsedMs))
}

/** The entry for a run that failed as a whole; `sql` is what the run sent. */
export function entryFromError(
  ctx: EntryContext,
  sql: string,
  error: AppError,
  elapsedMs: number | null,
): OutputEntry {
  return entry(ctx, sql, { kind: "error", message: error.message }, elapsedMs)
}

/** The entry for a run the user stopped. */
export function entryFromCancel(
  ctx: EntryContext,
  sql: string,
  elapsedMs: number | null,
): OutputEntry {
  return entry(ctx, sql, { kind: "cancelled" }, elapsedMs)
}

export type OutputStatus = "ok" | "error" | "cancelled"

export function entryStatus(outcome: OutputOutcome): OutputStatus {
  if (outcome.kind === "error") return "error"
  return outcome.kind === "cancelled" ? "cancelled" : "ok"
}

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`

/** The outcome as one line: `12 rows`, `3 rows affected · last insert id 7`, `Error: ...`. */
export function outcomeText(outcome: OutputOutcome): string {
  switch (outcome.kind) {
    case "rows":
      return `${plural(outcome.rowCount, "row", "rows")}${outcome.truncated ? " (more not fetched)" : ""}`
    case "exec": {
      const affected = `${plural(outcome.affectedRows, "row", "rows")} affected`
      // MySQL reports 0 when the statement inserted nothing with AUTO_INCREMENT.
      const id = outcome.lastInsertId
      return id && id !== "0" ? `${affected} · last insert id ${id}` : affected
    }
    case "error":
      return `Error: ${outcome.message}`
    case "cancelled":
      return "Cancelled"
  }
}

/** The statement on one line, whitespace collapsed, for the collapsed entry. */
export function sqlOneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim()
}

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * Local time of an entry: `HH:MM:SS` for today, `YYYY-MM-DD HH:MM` for older days (output can
 * be kept for a year).
 */
export function formatEntryTime(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  if (sameDay) return `${time}:${pad(d.getSeconds())}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}

/**
 * Text to put over the editor range `from`–`to` so `sql` lands on lines of its own: a line
 * break is added before it unless it starts a line, and after it unless it ends one.
 */
export function sqlInsertion(doc: string, from: number, to: number, sql: string): string {
  const before = from > 0 && doc[from - 1] !== "\n" ? "\n" : ""
  const after = to < doc.length && doc[to] !== "\n" ? "\n" : ""
  return `${before}${sql}${after}`
}

/**
 * Adds entries (any connections) after the existing ones and keeps only the newest `cap` per
 * connection. Entries already in the log (same id) are skipped. Never mutates `log`.
 */
export function appendEntries(
  log: OutputLog,
  entries: readonly OutputEntry[],
  cap: number = MAX_OUTPUT_ENTRIES_PER_CONNECTION,
): OutputLog {
  if (entries.length === 0) return log
  const added = entries.reduce<Record<ConnectionId, OutputEntry[]>>((acc, e) => {
    const list = acc[e.connectionId] ?? []
    return { ...acc, [e.connectionId]: [...list, e] }
  }, {})
  return Object.entries(added).reduce<OutputLog>((acc, [connectionId, list]) => {
    const existing = acc[connectionId] ?? []
    const known = new Set(existing.map((e) => e.id))
    const merged = [...existing, ...list.filter((e) => !known.has(e.id))]
    return { ...acc, [connectionId]: merged.slice(Math.max(0, merged.length - cap)) }
  }, log)
}

/**
 * Drops entries older than `retentionDays` before `now`, and connections left empty. 0 days
 * keeps nothing. Returns `log` itself when nothing changed.
 */
export function pruneLog(log: OutputLog, retentionDays: number, now: number): OutputLog {
  const cutoff = now - retentionDays * DAY_MS
  let changed = false
  const next: Record<ConnectionId, readonly OutputEntry[]> = {}
  for (const [connectionId, entries] of Object.entries(log)) {
    const kept = retentionDays <= 0 ? [] : entries.filter((e) => e.at >= cutoff)
    if (kept.length !== entries.length) changed = true
    if (kept.length > 0) next[connectionId] = kept.length === entries.length ? entries : kept
    else if (entries.length === 0) changed = true
  }
  return changed ? next : log
}

/** The log without `connectionId`; `log` itself when it had no entries for it. */
export function dropConnection(log: OutputLog, connectionId: ConnectionId): OutputLog {
  if (!(connectionId in log)) return log
  const { [connectionId]: _dropped, ...rest } = log
  return rest
}

/** Only the connections `keep` accepts. */
export function keepConnections(log: OutputLog, keep: (id: ConnectionId) => boolean): OutputLog {
  const ids = Object.keys(log)
  if (ids.every(keep)) return log
  return Object.fromEntries(ids.filter(keep).map((id) => [id, log[id]]))
}

/** Entries the Output view lists, newest first. */
export function visibleEntries(
  log: OutputLog,
  params: { connectionId: ConnectionId; tabId: string; scope: OutputScope },
): OutputEntry[] {
  const entries = log[params.connectionId] ?? []
  const filtered =
    params.scope === "tab" ? entries.filter((e) => e.tabId === params.tabId) : entries
  return [...filtered].reverse()
}

const encoder = new TextEncoder()

/**
 * Keeps the newest entries (across connections) whose encoded size fits `budgetBytes`, so the
 * saved file stays under the backend limit. Returns `log` itself when everything fits.
 */
export function fitToBudget(
  log: OutputLog,
  budgetBytes: number = OUTPUT_FILE_BUDGET_BYTES,
): OutputLog {
  const all = Object.values(log).flat()
  const sizes = new Map(all.map((e) => [e, encoder.encode(JSON.stringify(e)).length + 1]))
  const total = all.reduce((sum, e) => sum + (sizes.get(e) ?? 0), 0)
  if (total <= budgetBytes) return log
  const newestFirst = [...all].sort((a, b) => b.at - a.at)
  const kept = new Set<OutputEntry>()
  let used = 0
  for (const e of newestFirst) {
    const size = sizes.get(e) ?? 0
    if (used + size > budgetBytes) break
    used += size
    kept.add(e)
  }
  return Object.fromEntries(
    Object.entries(log)
      .map(([id, entries]) => [id, entries.filter((e) => kept.has(e))] as const)
      .filter(([, entries]) => entries.length > 0),
  )
}

/** `query-output.json` as sent to and read from the backend. */
export interface OutputFile {
  version: 1
  connections: OutputLog
}

const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rows"),
    rowCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal("exec"),
    affectedRows: z.number().int().nonnegative(),
    lastInsertId: z.string().nullable(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  z.object({ kind: z.literal("cancelled") }),
])

const entrySchema = z.object({
  id: z.string().min(1),
  connectionId: z.string().min(1),
  tabId: z.string().min(1),
  at: z.number(),
  sql: z.string().max(MAX_OUTPUT_SQL_CHARS),
  sqlTruncated: z.boolean(),
  elapsedMs: z.number().nonnegative().nullable(),
  outcome: outcomeSchema,
})

/**
 * Reads the IPC response, which is not trusted: anything but a version 1 file is the empty log;
 * entries that don't parse, sit under another connection or repeat an id are dropped, and each
 * connection is put back in time order.
 */
export function normalizeOutputLog(raw: unknown): OutputLog {
  const shape = z
    .object({ version: z.literal(1), connections: z.record(z.string(), z.unknown()) })
    .safeParse(raw)
  if (!shape.success) return EMPTY_OUTPUT_LOG
  const log: Record<ConnectionId, readonly OutputEntry[]> = {}
  for (const [connectionId, list] of Object.entries(shape.data.connections)) {
    if (!Array.isArray(list)) continue
    const seen = new Set<string>()
    const entries = list.flatMap((item): OutputEntry[] => {
      const parsed = entrySchema.safeParse(item)
      if (!parsed.success || parsed.data.connectionId !== connectionId) return []
      if (seen.has(parsed.data.id)) return []
      seen.add(parsed.data.id)
      return [parsed.data]
    })
    if (entries.length > 0) log[connectionId] = [...entries].sort((a, b) => a.at - b.at)
  }
  return log
}

export function serializeOutputLog(log: OutputLog): OutputFile {
  return { version: 1, connections: log }
}

export const queryOutputApi = {
  /** The empty log when nothing was saved or the file was unusable. */
  load: async () => normalizeOutputLog(await ipc<unknown>("query_output_load")),
  /** Null removes the file (output kept for the session only). */
  save: (file: OutputFile | null) => ipc<void>("query_output_save", { output: file }),
}
