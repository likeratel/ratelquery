import { z } from "zod"
import type {
  ConnectionConfig,
  ConnectionId,
  DynamoConnectionConfig,
  MysqlConnectionConfig,
  MysqlTlsMode,
} from "../../lib/connections"
import { HEX_COLOR } from "./colors"

export const DEFAULT_MYSQL_PORT = 3306
export const DEFAULT_REGION = "ap-northeast-2"

export type ConnectionKind = ConnectionConfig["kind"]
export type DynamoAuthType = "profile" | "keys"

/** Raw, string-only form values for each kind. Converted to configs by `parseForm`. */
export interface MysqlDraft {
  name: string
  host: string
  port: string
  user: string
  password: string
  database: string
  color: string
  tls: MysqlTlsMode
  /** CA certificate path; only sent with the verify modes. */
  caCertPath: string
}

export const DEFAULT_TLS: MysqlTlsMode = "preferred"

export const TLS_MODES = ["preferred", "required", "verify_ca", "verify_identity"] as const

/** Modes that check the server certificate, and may take a custom CA. */
export function verifiesCertificate(mode: MysqlTlsMode): boolean {
  return mode === "verify_ca" || mode === "verify_identity"
}

export interface DynamoDraft {
  name: string
  region: string
  endpoint: string
  authType: DynamoAuthType
  profile: string
  accessKeyId: string
  secretAccessKey: string
  color: string
}

export interface ConnectionForm {
  kind: ConnectionKind
  mysql: MysqlDraft
  dynamodb: DynamoDraft
}

export interface FormContext {
  /** Connection being edited, or undefined when creating a new one. */
  original?: ConnectionConfig
  /** Whether the keyring already holds a secret for `original`. */
  hasStoredSecret: boolean
}

export type FieldErrors = Readonly<Record<string, string>>

export type ParseResult =
  { ok: true; config: ConnectionConfig; secret: string | null } | { ok: false; errors: FieldErrors }

const required = (label: string) => z.string().trim().min(1, `${label} is required`)

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))

const colorField = z
  .string()
  .trim()
  .refine((value) => value === "" || HEX_COLOR.test(value), "Pick one of the colors")
  .transform((value) => (value === "" ? undefined : value))

const portField = z
  .string()
  .trim()
  .min(1, "Port is required")
  .regex(/^\d+$/, "Port must be a number")
  .transform(Number)
  .pipe(z.number().int().min(1, "Port must be 1 to 65535").max(65535, "Port must be 1 to 65535"))

export const ENDPOINT_FULL_URL = "Use a full URL such as http://localhost:8000"
export const ENDPOINT_NO_USERINFO = "Leave user names and passwords out of the endpoint URL"
export const ENDPOINT_NO_FRAGMENT = "Remove the # part from the endpoint URL"

/** An `@` before the path: `user:pass@host` style credentials, even empty ones. */
const USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i

/**
 * Why an endpoint URL is refused, or null when it is fine (or empty). Only http(s) URLs are
 * accepted. Credentials in the URL would travel next to the AWS signature and a fragment is
 * never sent, so both are refused rather than passed on.
 */
export function endpointProblem(value: string): string | null {
  if (value === "") return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return ENDPOINT_FULL_URL
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return ENDPOINT_FULL_URL
  if (url.username !== "" || url.password !== "" || USERINFO.test(value)) {
    return ENDPOINT_NO_USERINFO
  }
  if (value.includes("#")) return ENDPOINT_NO_FRAGMENT
  return null
}

const endpointField = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const problem = endpointProblem(value)
    if (problem) ctx.addIssue({ code: "custom", message: problem })
  })
  .transform((value) => (value === "" ? undefined : value))

export const mysqlFormSchema = z.object({
  name: required("Name"),
  host: required("Host"),
  port: portField,
  user: required("User"),
  password: z.string(),
  database: optionalText,
  color: colorField,
  tls: z.enum(TLS_MODES),
  caCertPath: optionalText,
})

const dynamoBase = {
  name: required("Name"),
  region: required("Region").regex(/^[a-z0-9-]+$/, "Use a region code such as us-east-1"),
  endpoint: endpointField,
  color: colorField,
}

export function dynamoFormSchema(requireSecret: boolean) {
  return z.discriminatedUnion("authType", [
    z.object({ ...dynamoBase, authType: z.literal("profile"), profile: required("Profile") }),
    z.object({
      ...dynamoBase,
      authType: z.literal("keys"),
      accessKeyId: required("Access key ID"),
      secretAccessKey: requireSecret ? required("Secret access key") : z.string(),
    }),
  ])
}

export function emptyForm(kind: ConnectionKind = "mysql"): ConnectionForm {
  return {
    kind,
    mysql: {
      name: "",
      host: "localhost",
      port: String(DEFAULT_MYSQL_PORT),
      user: "",
      password: "",
      database: "",
      color: "",
      tls: DEFAULT_TLS,
      caCertPath: "",
    },
    dynamodb: {
      name: "",
      region: DEFAULT_REGION,
      endpoint: "",
      authType: "profile",
      profile: "default",
      accessKeyId: "",
      secretAccessKey: "",
      color: "",
    },
  }
}

/** Builds form values from a saved config. Secrets are never prefilled. */
export function formFromConfig(config: ConnectionConfig): ConnectionForm {
  const base = emptyForm(config.kind)
  if (config.kind === "mysql") {
    return {
      ...base,
      mysql: {
        name: config.name,
        host: config.host,
        port: String(config.port),
        user: config.user,
        password: "",
        database: config.database ?? "",
        color: config.color ?? "",
        tls: config.tls ?? DEFAULT_TLS,
        caCertPath: config.caCertPath ?? "",
      },
    }
  }
  return {
    ...base,
    dynamodb: {
      ...base.dynamodb,
      name: config.name,
      region: config.region,
      endpoint: config.endpoint ?? "",
      authType: config.auth.type,
      profile: config.auth.type === "profile" ? config.auth.profile : "",
      accessKeyId: config.auth.type === "keys" ? config.auth.accessKeyId : "",
      color: config.color ?? "",
    },
  }
}

function collectErrors(error: z.ZodError): FieldErrors {
  return error.issues.reduce<Record<string, string>>((acc, issue) => {
    const key = String(issue.path[0] ?? "form")
    return key in acc ? acc : { ...acc, [key]: issue.message }
  }, {})
}

function idFor(context: FormContext, kind: ConnectionKind): ConnectionId {
  return context.original?.kind === kind ? context.original.id : ""
}

/**
 * Whether the form differs from how it opened, looking at the kind and the visible draft only
 * (the other kind's draft is hidden and never saved).
 */
export function isFormChanged(initial: ConnectionForm, current: ConnectionForm): boolean {
  if (initial.kind !== current.kind) return true
  const before: Readonly<Record<string, string>> = { ...initial[current.kind] }
  const after: Readonly<Record<string, string>> = { ...current[current.kind] }
  return Object.keys(after).some((key) => before[key] !== after[key])
}

export const MYSQL_SECRET_AGAIN = "Enter the password again for the new server"
export const DYNAMO_SECRET_AGAIN = "Enter the secret access key again for the new endpoint or key"

/**
 * A blank secret (`null`) keeps the stored one. When the edit points the connection somewhere
 * else (another host, port or user; another region, endpoint or access key ID), that stored
 * secret must not travel to the new target, and the backend rejects the request. Returns the
 * field error to show instead of sending it, or null when the request is fine.
 */
export function secretReentryError(
  config: ConnectionConfig,
  secret: string | null,
  context: FormContext,
): FieldErrors | null {
  const original = context.original
  if (secret !== null || !context.hasStoredSecret) return null
  if (config.kind === "mysql" && original?.kind === "mysql") {
    // Mirrors the backend's same-target rule: host ignores case, TLS defaults to "preferred".
    const moved =
      config.host.toLowerCase() !== original.host.toLowerCase() ||
      config.port !== original.port ||
      config.user !== original.user ||
      (config.tls ?? DEFAULT_TLS) !== (original.tls ?? DEFAULT_TLS) ||
      (config.caCertPath ?? "") !== (original.caCertPath ?? "")
    return moved ? { password: MYSQL_SECRET_AGAIN } : null
  }
  if (config.kind === "dynamodb" && original?.kind === "dynamodb") {
    // Only access keys reuse a stored secret; a profile reads credentials from the AWS config.
    if (config.auth.type !== "keys" || original.auth.type !== "keys") return null
    const moved =
      config.region !== original.region ||
      (config.endpoint ?? "") !== (original.endpoint ?? "") ||
      config.auth.accessKeyId !== original.auth.accessKeyId
    return moved ? { secretAccessKey: DYNAMO_SECRET_AGAIN } : null
  }
  return null
}

function parseMysql(draft: MysqlDraft, context: FormContext): ParseResult {
  const result = mysqlFormSchema.safeParse(draft)
  if (!result.success) return { ok: false, errors: collectErrors(result.error) }
  const { password, tls, caCertPath, ...values } = result.data
  const config: MysqlConnectionConfig = {
    kind: "mysql",
    id: idFor(context, "mysql"),
    ...values,
    // "preferred" is the backend default; leaving it out keeps older configs unchanged.
    tls: tls === DEFAULT_TLS ? undefined : tls,
    caCertPath: verifiesCertificate(tls) ? caCertPath : undefined,
  }
  // Blank password keeps whatever is stored (or stores nothing for a new connection).
  return { ok: true, config, secret: password === "" ? null : password }
}

function parseDynamo(draft: DynamoDraft, context: FormContext): ParseResult {
  const original = context.original?.kind === "dynamodb" ? context.original : undefined
  const hadKeys = original?.auth.type === "keys"
  const requireSecret = !(hadKeys && context.hasStoredSecret)
  const result = dynamoFormSchema(requireSecret).safeParse(draft)
  if (!result.success) return { ok: false, errors: collectErrors(result.error) }
  const data = result.data
  const shared = {
    kind: "dynamodb" as const,
    id: idFor(context, "dynamodb"),
    name: data.name,
    region: data.region,
    endpoint: data.endpoint,
    color: data.color,
  }
  if (data.authType === "profile") {
    const config: DynamoConnectionConfig = {
      ...shared,
      auth: { type: "profile", profile: data.profile },
    }
    // Switching away from access keys clears the stale secret from the keyring.
    return { ok: true, config, secret: hadKeys ? "" : null }
  }
  const config: DynamoConnectionConfig = {
    ...shared,
    auth: { type: "keys", accessKeyId: data.accessKeyId },
  }
  const secret = data.secretAccessKey.trim()
  return { ok: true, config, secret: secret === "" ? null : secret }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/** Validates the active kind and converts it to a config plus the secret to send over IPC. */
export function parseForm(form: ConnectionForm, context: FormContext): ParseResult {
  const result =
    form.kind === "mysql" ? parseMysql(form.mysql, context) : parseDynamo(form.dynamodb, context)
  if (!result.ok) return result
  const reentry = secretReentryError(result.config, result.secret, context)
  if (reentry) return { ok: false, errors: reentry }
  // Drop undefined optional keys so the IPC payload matches the contract exactly.
  return { ...result, config: stripUndefined(result.config) }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "[::1]", "::1"])

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return LOOPBACK_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/.test(host)
}

export const INSECURE_ENDPOINT_WARNING =
  "This endpoint uses plain HTTP, so requests and AWS signatures cross the network unencrypted. Use https:// for anything but a local DynamoDB."

/**
 * Warning for an `http://` endpoint that isn't on this machine. DynamoDB Local on localhost is
 * the expected plain-HTTP case; anything else is allowed but called out.
 */
export function insecureEndpointWarning(endpoint: string): string | null {
  const value = endpoint.trim()
  if (value === "") return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== "http:" || isLoopback(url.hostname)) return null
  return INSECURE_ENDPOINT_WARNING
}
