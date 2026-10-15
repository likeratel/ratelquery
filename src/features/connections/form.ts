import { z } from "zod"
import type {
  ConnectionConfig,
  ConnectionId,
  DynamoConnectionConfig,
  MysqlConnectionConfig,
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

const endpointField = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || isHttpUrl(value),
    "Use a full URL such as http://localhost:8000",
  )
  .transform((value) => (value === "" ? undefined : value))

export const mysqlFormSchema = z.object({
  name: required("Name"),
  host: required("Host"),
  port: portField,
  user: required("User"),
  password: z.string(),
  database: optionalText,
  color: colorField,
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

function parseMysql(draft: MysqlDraft, context: FormContext): ParseResult {
  const result = mysqlFormSchema.safeParse(draft)
  if (!result.success) return { ok: false, errors: collectErrors(result.error) }
  const { password, ...values } = result.data
  const config: MysqlConnectionConfig = { kind: "mysql", id: idFor(context, "mysql"), ...values }
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
  // Drop undefined optional keys so the IPC payload matches the contract exactly.
  return result.ok ? { ...result, config: stripUndefined(result.config) } : result
}
