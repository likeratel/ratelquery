import { ipc } from "./ipc"

export type ConnectionId = string

export interface MysqlConnectionConfig {
  kind: "mysql"
  id: ConnectionId
  name: string
  host: string
  port: number
  user: string
  database?: string
  color?: string
}

export type DynamoAuth =
  { type: "profile"; profile: string } | { type: "keys"; accessKeyId: string }

export interface DynamoConnectionConfig {
  kind: "dynamodb"
  id: ConnectionId
  name: string
  region: string
  endpoint?: string
  auth: DynamoAuth
  color?: string
}

export type ConnectionConfig = MysqlConnectionConfig | DynamoConnectionConfig

export interface ConnectionTestResult {
  ok: true
  serverVersion?: string
  latencyMs: number
}

export const connectionsApi = {
  list: () => ipc<ConnectionConfig[]>("connections_list"),
  save: (config: ConnectionConfig, secret: string | null) =>
    ipc<ConnectionConfig>("connections_save", { config, secret }),
  delete: (id: ConnectionId) => ipc<void>("connections_delete", { id }),
  hasSecret: (id: ConnectionId) => ipc<boolean>("connections_has_secret", { id }),
  test: (config: ConnectionConfig, secret: string | null) =>
    ipc<ConnectionTestResult>("connections_test", { config, secret }),
}
