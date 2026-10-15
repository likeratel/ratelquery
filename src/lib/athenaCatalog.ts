/**
 * Pure state transitions for one Athena connection's catalog: its databases, the schema
 * snapshots loaded so far and the database new statements run in. The store applies them.
 */
import type { AppError } from "./ipc"
import type { SchemaSnapshot } from "./mysql"

export interface AthenaCatalog {
  /** Database names from `athena_databases`; null until the first list arrives. */
  databases: readonly string[] | null
  /** Schema snapshots keyed by database name. */
  schemas: Readonly<Record<string, SchemaSnapshot>>
  /** Database new tabs and completion use when a tab has none of its own. */
  currentDatabase: string | null
  /** True while the database list is being fetched. */
  loading: boolean
  /** Databases whose schema is being fetched right now. */
  schemaLoading: Readonly<Record<string, boolean>>
  lastError: AppError | null
}

export function emptyAthenaCatalog(currentDatabase: string | null = null): AthenaCatalog {
  return {
    databases: null,
    schemas: {},
    currentDatabase,
    loading: false,
    schemaLoading: {},
    lastError: null,
  }
}

const withoutKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))

export function startDatabases(catalog: AthenaCatalog): AthenaCatalog {
  return { ...catalog, loading: true, lastError: null }
}

export function finishDatabases(
  catalog: AthenaCatalog,
  databases: readonly string[],
): AthenaCatalog {
  return { ...catalog, loading: false, databases: [...databases] }
}

/** Keeps the previous list (if any) next to the error. */
export function failDatabases(catalog: AthenaCatalog, error: AppError): AthenaCatalog {
  return { ...catalog, loading: false, lastError: error }
}

export function startSchema(catalog: AthenaCatalog, database: string): AthenaCatalog {
  return { ...catalog, schemaLoading: { ...catalog.schemaLoading, [database]: true } }
}

/** Stores the snapshot under the requested name, whatever casing the response uses. */
export function finishSchema(
  catalog: AthenaCatalog,
  database: string,
  snapshot: SchemaSnapshot,
): AthenaCatalog {
  return {
    ...catalog,
    schemaLoading: withoutKey(catalog.schemaLoading, database),
    schemas: { ...catalog.schemas, [database]: snapshot },
  }
}

/** A failed refresh keeps the cached snapshot of `database`. */
export function failSchema(
  catalog: AthenaCatalog,
  database: string,
  error: AppError,
): AthenaCatalog {
  return {
    ...catalog,
    schemaLoading: withoutKey(catalog.schemaLoading, database),
    lastError: error,
  }
}

export function setCurrentDatabase(catalog: AthenaCatalog, database: string | null): AthenaCatalog {
  return catalog.currentDatabase === database ? catalog : { ...catalog, currentDatabase: database }
}

/** True while the schema of `database` is being fetched. */
export function isAthenaSchemaLoading(
  catalog: AthenaCatalog | undefined,
  database: string | null,
): boolean {
  return Boolean(database && catalog?.schemaLoading[database])
}
