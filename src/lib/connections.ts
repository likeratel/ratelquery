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
  /** TLS requirement; defaults to "preferred" (use TLS when the server offers it). */
  tls?: MysqlTlsMode
  /** PEM file with the CA to trust for "verify_ca" / "verify_identity". */
  caCertPath?: string
  /** Reach the server through an SSH bastion; `host`/`port` are then as seen from the bastion. */
  ssh?: SshConfig
}

export type SshAuth = { type: "agent" } | { type: "key"; keyPath: string } | { type: "password" }

export interface SshConfig {
  host: string
  port: number
  user: string
  auth: SshAuth
}

export type MysqlTlsMode = "preferred" | "required" | "verify_ca" | "verify_identity"

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

/** A profile from the shared AWS config / credentials files. Never carries secret values. */
export interface AwsProfile {
  name: string
  /** `region` of the config section; null when unset (an SSO session's region is not used). */
  region: string | null
  source: "config" | "credentials" | "both"
  /** Uses AWS IAM Identity Center (`sso_start_url` or `sso_session`). */
  sso: boolean
}

/** Which stored secret of a connection: the database password or the SSH password/passphrase. */
export type SecretSlot = "db" | "ssh"

/**
 * Secret arguments for save and test. `null` keeps the stored value and `""` clears it; the SSH
 * secret is left out of the payload when not given, which the backend treats as `null`.
 */
const secretArgs = (secret: string | null, sshSecret: string | null | undefined) =>
  sshSecret === undefined ? { secret } : { secret, sshSecret }

export const connectionsApi = {
  list: () => ipc<ConnectionConfig[]>("connections_list"),
  save: (config: ConnectionConfig, secret: string | null, sshSecret?: string | null) =>
    ipc<ConnectionConfig>("connections_save", { config, ...secretArgs(secret, sshSecret) }),
  delete: (id: ConnectionId) => ipc<void>("connections_delete", { id }),
  /** Whether a secret is stored for the connection; `which` defaults to the database password. */
  hasSecret: (id: ConnectionId, which?: SecretSlot) =>
    ipc<boolean>("connections_has_secret", which === undefined ? { id } : { id, which }),
  test: (config: ConnectionConfig, secret: string | null, sshSecret?: string | null) =>
    ipc<ConnectionTestResult>("connections_test", { config, ...secretArgs(secret, sshSecret) }),
  /** Profiles in `~/.aws/config` and `~/.aws/credentials` (or the files the AWS env vars name). */
  awsProfiles: () => ipc<AwsProfile[]>("aws_profiles"),
}
