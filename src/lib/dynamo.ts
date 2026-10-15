import type { ConnectionId } from "./connections"
import { ipc } from "./ipc"
import type { ExportResult } from "./mysql"

/** One attribute in the DynamoDB JSON wire format, e.g. `{ S: "a" }` or `{ M: {...} }`. */
export type AttributeValue = Record<string, unknown>
export type Item = Record<string, AttributeValue>

export type KeyType = "S" | "N" | "B"

export interface KeyAttribute {
  name: string
  type: KeyType
}

export interface KeySchema {
  hash: KeyAttribute
  range: KeyAttribute | null
}

export interface IndexDescription {
  name: string
  kind: "gsi" | "lsi"
  keySchema: KeySchema
  projection: "all" | "keys_only" | "include"
}

export interface TableDescription {
  name: string
  status: string
  keySchema: KeySchema
  indexes: IndexDescription[]
  itemCount: number | null
  sizeBytes: number | null
  billingMode: string | null
}

export type RangeCondition =
  | { op: "eq" | "lt" | "le" | "gt" | "ge" | "begins_with"; value: AttributeValue }
  | { op: "between"; from: AttributeValue; to: AttributeValue }

export interface QueryRequest {
  table: string
  index?: string
  hash: AttributeValue
  range?: RangeCondition
  filter?: string
  names?: Record<string, string>
  values?: Record<string, AttributeValue>
  limit?: number
  startKey?: Item
  scanForward?: boolean
}

export interface ScanRequest {
  table: string
  index?: string
  filter?: string
  names?: Record<string, string>
  values?: Record<string, AttributeValue>
  limit?: number
  startKey?: Item
}

export interface Page {
  items: Item[]
  lastKey: Item | null
  count: number
  scannedCount: number
  elapsedMs: number
}

export type PutExpectation = "exists" | "not_exists" | "any"

export type DynamoExportRequest = { scan: ScanRequest } | { query: QueryRequest }

export interface DynamoExportOptions {
  format: "json" | "jsonl" | "csv"
  path: string
}

export const dynamoApi = {
  listTables: (connectionId: ConnectionId) => ipc<string[]>("dynamo_list_tables", { connectionId }),
  describeTable: (connectionId: ConnectionId, table: string) =>
    ipc<TableDescription>("dynamo_describe_table", { connectionId, table }),
  query: (connectionId: ConnectionId, request: QueryRequest) =>
    ipc<Page>("dynamo_query", { connectionId, request }),
  scan: (connectionId: ConnectionId, request: ScanRequest) =>
    ipc<Page>("dynamo_scan", { connectionId, request }),
  getItem: (connectionId: ConnectionId, table: string, key: Item) =>
    ipc<Item | null>("dynamo_get_item", { connectionId, table, key }),
  putItem: (connectionId: ConnectionId, table: string, item: Item, expect: PutExpectation) =>
    ipc<void>("dynamo_put_item", { connectionId, table, item, expect }),
  deleteItem: (connectionId: ConnectionId, table: string, key: Item) =>
    ipc<void>("dynamo_delete_item", { connectionId, table, key }),
  export: (
    connectionId: ConnectionId,
    request: DynamoExportRequest,
    options: DynamoExportOptions,
  ) => ipc<ExportResult>("dynamo_export", { connectionId, request, options }),
}
