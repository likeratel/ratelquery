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
}

export type QueryResult = RowsResult | ExecResult

export interface QueryOptions {
  database?: string
  maxRows?: number
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
  /** A given `secret` is used for this session only; the backend stores nothing. */
  connect: (connectionId: ConnectionId, secret?: string) =>
    ipc<MysqlSessionInfo>(
      "mysql_connect",
      secret === undefined ? { connectionId } : { connectionId, secret },
    ),
  disconnect: (connectionId: ConnectionId) => ipc<void>("mysql_disconnect", { connectionId }),
  query: (connectionId: ConnectionId, sql: string, options: QueryOptions = {}) =>
    ipc<QueryResult[]>("mysql_query", { connectionId, sql, options }),
  databases: (connectionId: ConnectionId) => ipc<string[]>("mysql_databases", { connectionId }),
  schema: (connectionId: ConnectionId, database: string) =>
    ipc<SchemaSnapshot>("mysql_schema", { connectionId, database }),
  /** Rejects with `not_found` for an unknown table. */
  tableDetails: (connectionId: ConnectionId, database: string, table: string) =>
    ipc<TableDetails>("mysql_table_details", { connectionId, database, table }),
  applyChanges: (
    connectionId: ConnectionId,
    database: string,
    table: string,
    changes: RowChange[],
  ) => ipc<ApplyChangesResult>("mysql_apply_changes", { connectionId, database, table, changes }),
  export: (connectionId: ConnectionId, sql: string, options: ExportOptions) =>
    ipc<ExportResult>("mysql_export", { connectionId, sql, options }),
  exportRows: (columns: ColumnInfo[], rows: Cell[][], options: ExportOptions) =>
    ipc<ExportResult>("export_rows", { columns, rows, options }),
}
