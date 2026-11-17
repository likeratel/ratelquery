import type { ConnectionId } from "./connections"
import { ipc } from "./ipc"

export type MysqlSessionState =
  "connecting" | "connected" | "reconnecting" | "disconnected" | "error"

export interface MysqlStateEvent {
  connectionId: ConnectionId
  state: MysqlSessionState
  message?: string
}

export interface MysqlSessionInfo {
  serverVersion: string
  currentDatabase: string | null
}

export interface ColumnInfo {
  name: string
  typeName: string
  table: string | null
  nullable: boolean
}

export type Cell =
  | { t: "null" }
  | { t: "str"; v: string }
  | { t: "int"; v: string }
  | { t: "float"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "decimal"; v: string }
  | { t: "date"; v: string }
  | { t: "time"; v: string }
  | { t: "datetime"; v: string }
  | { t: "json"; v: string }
  | { t: "bytes"; v: string }

export interface RowsResult {
  kind: "rows"
  columns: ColumnInfo[]
  rows: Cell[][]
  rowCount: number
  truncated: boolean
  elapsedMs: number
  reconnected: boolean
  statement: string
}

export interface ExecResult {
  kind: "exec"
  affectedRows: number
  lastInsertId: string | null
  elapsedMs: number
  reconnected: boolean
  statement: string
  /** A DELETE backed up to the trash: how many rows the entry holds. */
  trashedRows?: number
  /** A DELETE backed up to the trash: the entry id (absent when it deleted no rows). */
  trashId?: string
}

export type QueryResult = RowsResult | ExecResult

/**
 * Last item of a `mysql_query` response when the DELETE at `statementIndex` (whole script)
 * couldn't be backed up: it and later statements did not run.
 */
export interface BackupStoppedResult {
  kind: "backup_stopped"
  statementIndex: number
  reason: string
  statement: string
  elapsedMs: number
  /** Continues the script on the same connection (`QueryOptions.resumeToken`) for 5 minutes. */
  resumeToken: string | null
}

export type QueryResponseItem = QueryResult | BackupStoppedResult

export interface QueryOptions {
  database?: string
  maxRows?: number
  /** Run from this statement of the script (backend split order); needs `resumeToken`. */
  startAt?: number
  /** The `resumeToken` of the `backup_stopped` result this run continues. */
  resumeToken?: string
  /** Statement indexes (whole script) whose DELETE runs without a trash backup. */
  deleteBackup?: { skip: number[] }
}

/** `mysql_delete_plan` entry for a statement that deletes rows. */
export interface DeletePlanEntry {
  index: number
  backup: "ok" | "unsupported"
  reason: string | null
  statement: string
}

export interface SchemaColumn {
  name: string
  typeName: string
  nullable: boolean
  isPrimary: boolean
  isAutoIncrement: boolean
  defaultValue: string | null
  /** COLUMN_COMMENT; only `mysql_table_details` fills it. */
  comment?: string
}

export interface SchemaTable {
  name: string
  kind: "table" | "view"
  columns: SchemaColumn[]
}

export interface SchemaSnapshot {
  database: string
  tables: SchemaTable[]
  fetchedAt: string
}

export interface IndexInfo {
  name: string
  unique: boolean
  /** In sequence order. */
  columns: string[]
  /** "BTREE", "FULLTEXT", ... */
  type: string
}

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  referencedTable: string
  referencedColumns: string[]
  onUpdate: string
  onDelete: string
}

export interface TableDetails {
  database: string
  table: string
  kind: "table" | "view"
  engine: string | null
  /** information_schema.TABLES.TABLE_ROWS; an estimate for InnoDB. */
  rowEstimate: number | null
  dataLength: number | null
  collation: string | null
  comment: string
  columns: SchemaColumn[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
  /** SHOW CREATE TABLE / VIEW. */
  ddl: string
}

export type RowChange =
  | { type: "update"; key: Record<string, Cell>; set: Record<string, Cell> }
  | { type: "delete"; key: Record<string, Cell> }
  | { type: "insert"; values: Record<string, Cell> }

export interface ApplyChangesOptions {
  /** Don't save the deleted rows to the trash first. Default false. */
  skipBackup?: boolean
}

export interface ChangePreview {
  /** The statements `applyChanges` would run, values written as MySQL literals. */
  statements: string[]
  /** Set when the session's character set may make the literals read differently than shown. */
  warning: string | null
}

export interface ApplyChangesResult {
  affectedRows: number
  elapsedMs: number
}

export type ExportFormat = "csv" | "json" | "sql"

export interface ExportOptions {
  format: ExportFormat
  path: string
  tableName?: string
  includeHeader?: boolean
  /** Schema to run a full export in; defaults to the session database. */
  database?: string
}

export interface ExportResult {
  rows: number
  bytes: number
  elapsedMs: number
}

export const mysqlApi = {
  /**
   * A given `secret` (database password) or `sshSecret` (SSH password or key passphrase) is used
   * for this session only; the backend stores nothing.
   */
  connect: (connectionId: ConnectionId, secret?: string, sshSecret?: string) =>
    ipc<MysqlSessionInfo>("mysql_connect", {
      connectionId,
      ...(secret === undefined ? {} : { secret }),
      ...(sshSecret === undefined ? {} : { sshSecret }),
    }),
  disconnect: (connectionId: ConnectionId) => ipc<void>("mysql_disconnect", { connectionId }),
  query: (connectionId: ConnectionId, sql: string, options: QueryOptions = {}) =>
    ipc<QueryResponseItem[]>("mysql_query", { connectionId, sql, options }),
  /** Which statements of `sql` delete rows, and whether each can be backed up. Runs nothing. */
  deletePlan: (sql: string) => ipc<DeletePlanEntry[]>("mysql_delete_plan", { sql }),
  /** Frees the connection a stopped run kept for continuing (the user didn't continue). */
  releaseResume: (connectionId: ConnectionId, token: string) =>
    ipc<void>("mysql_release_resume", { connectionId, token }),
  databases: (connectionId: ConnectionId) => ipc<string[]>("mysql_databases", { connectionId }),
  schema: (connectionId: ConnectionId, database: string) =>
    ipc<SchemaSnapshot>("mysql_schema", { connectionId, database }),
  /** Rejects with `not_found` for an unknown table. */
  tableDetails: (connectionId: ConnectionId, database: string, table: string) =>
    ipc<TableDetails>("mysql_table_details", { connectionId, database, table }),
  /**
   * Rows deleted by `changes` are saved to the trash in the same transaction unless
   * `skipBackup`; when that fails the call rejects with `backup_failed` and nothing changes.
   */
  applyChanges: (
    connectionId: ConnectionId,
    database: string,
    table: string,
    changes: RowChange[],
    options: ApplyChangesOptions = {},
  ) =>
    ipc<ApplyChangesResult>("mysql_apply_changes", {
      connectionId,
      database,
      table,
      changes,
      ...(options.skipBackup === undefined ? {} : { skipBackup: options.skipBackup }),
    }),
  /** The statements `applyChanges` would run, values written as literals. Runs nothing. */
  previewChanges: (
    connectionId: ConnectionId,
    database: string,
    table: string,
    changes: RowChange[],
  ) => ipc<ChangePreview>("mysql_preview_changes", { connectionId, database, table, changes }),
  export: (connectionId: ConnectionId, sql: string, options: ExportOptions) =>
    ipc<ExportResult>("mysql_export", { connectionId, sql, options }),
  exportRows: (columns: ColumnInfo[], rows: Cell[][], options: ExportOptions) =>
    ipc<ExportResult>("export_rows", { columns, rows, options }),
}
