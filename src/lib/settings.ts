import { z } from "zod"
import { ipc } from "./ipc"

/** User preferences persisted by the backend (`settings_get` / `settings_set`). */
export type ThemePreference = "system" | "light" | "dark"

export interface QuerySettings {
  /** LIMIT appended to a SELECT that has none. */
  defaultLimit: number
  addLimitToSelect: boolean
  /** Ask before UPDATE/DELETE without WHERE, DROP, TRUNCATE, ALTER, RENAME TABLE. */
  confirmDestructive: boolean
  /** Rows kept in memory per result. */
  maxRows: number
}

export interface DynamoSettings {
  pageSize: number
}

export interface Settings {
  theme: ThemePreference
  /** Editor font size in px. */
  editorFontSize: number
  query: QuerySettings
  dynamo: DynamoSettings
}

/** Partial update: top-level fields, or some fields of one group. */
export interface SettingsPatch {
  theme?: ThemePreference
  editorFontSize?: number
  query?: Partial<QuerySettings>
  dynamo?: Partial<DynamoSettings>
}

export interface Range {
  min: number
  max: number
}

/** Accepted ranges; they mirror the backend validation in docs/ipc-contract.md. */
export const SETTING_RANGES = {
  editorFontSize: { min: 11, max: 20 },
  defaultLimit: { min: 1, max: 100_000 },
  maxRows: { min: 1, max: 100_000 },
  pageSize: { min: 1, max: 1000 },
} as const satisfies Record<string, Range>

export type NumericSetting = keyof typeof SETTING_RANGES

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  editorFontSize: 13,
  query: {
    defaultLimit: 1000,
    addLimitToSelect: true,
    confirmDestructive: true,
    maxRows: 1000,
  },
  dynamo: { pageSize: 100 },
}

export const THEME_PREFERENCES = ["system", "light", "dark"] as const

const intIn = ({ min, max }: Range) => z.number().int().min(min).max(max)

export const settingsSchema = z.object({
  theme: z.enum(THEME_PREFERENCES),
  editorFontSize: intIn(SETTING_RANGES.editorFontSize),
  query: z.object({
    defaultLimit: intIn(SETTING_RANGES.defaultLimit),
    addLimitToSelect: z.boolean(),
    confirmDestructive: z.boolean(),
    maxRows: intIn(SETTING_RANGES.maxRows),
  }),
  dynamo: z.object({ pageSize: intIn(SETTING_RANGES.pageSize) }),
})

const D = DEFAULT_SETTINGS

/** Same shape, but each invalid or missing field falls back to its default. */
const lenientSchema = z.object({
  theme: z.enum(THEME_PREFERENCES).catch(D.theme),
  editorFontSize: intIn(SETTING_RANGES.editorFontSize).catch(D.editorFontSize),
  query: z
    .object({
      defaultLimit: intIn(SETTING_RANGES.defaultLimit).catch(D.query.defaultLimit),
      addLimitToSelect: z.boolean().catch(D.query.addLimitToSelect),
      confirmDestructive: z.boolean().catch(D.query.confirmDestructive),
      maxRows: intIn(SETTING_RANGES.maxRows).catch(D.query.maxRows),
    })
    .catch(D.query),
  dynamo: z
    .object({ pageSize: intIn(SETTING_RANGES.pageSize).catch(D.dynamo.pageSize) })
    .catch(D.dynamo),
})

/** Reads settings from untrusted data (the IPC response), defaulting whatever is unusable. */
export function normalizeSettings(raw: unknown): Settings {
  const parsed = lenientSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : DEFAULT_SETTINGS
}

/** Applies a patch without touching the original. */
export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  return {
    ...base,
    ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
    ...(patch.editorFontSize !== undefined ? { editorFontSize: patch.editorFontSize } : {}),
    query: { ...base.query, ...patch.query },
    dynamo: { ...base.dynamo, ...patch.dynamo },
  }
}

export type FieldResult = { ok: true; value: number } | { ok: false; error: string }

/** Parses the text typed for a numeric setting; the error is shown under the field. */
export function parseNumericSetting(field: NumericSetting, text: string): FieldResult {
  const { min, max } = SETTING_RANGES[field]
  const message = `Enter a whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}`
  const schema = z
    .string()
    .trim()
    .regex(/^\d+$/, message)
    .transform(Number)
    .pipe(z.number().int().min(min, message).max(max, message))
  const parsed = schema.safeParse(text)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: parsed.error.issues[0]?.message ?? message }
}

export type NumericCommit =
  { kind: "commit"; value: number } | { kind: "unchanged" } | { kind: "invalid"; error: string }

/** What committing the typed text (on blur or Enter) does for a numeric setting at `current`. */
export function numericCommit(field: NumericSetting, text: string, current: number): NumericCommit {
  const parsed = parseNumericSetting(field, text)
  if (!parsed.ok) return { kind: "invalid", error: parsed.error }
  return parsed.value === current ? { kind: "unchanged" } : { kind: "commit", value: parsed.value }
}

export const settingsApi = {
  get: async () => normalizeSettings(await ipc<unknown>("settings_get")),
  /** Sends only the changed fields; the backend deep-merges them and returns the full result. */
  set: async (patch: SettingsPatch) =>
    normalizeSettings(await ipc<unknown>("settings_set", { settings: patch })),
}
