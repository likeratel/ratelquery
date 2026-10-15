import type { ConnectionId, DynamoAuth } from "../../lib/connections"
import { AWS_CREDENTIAL_HINT, AWS_KEYS_CREDENTIAL_HINT } from "../../lib/errorHints"
import type { AppError, AppErrorKind } from "../../lib/ipc"
import { useConnectionsStore } from "../../state/connectionsStore"

const HINTS: Record<AppErrorKind, string> = {
  query: "DynamoDB rejected the request. Check the expression, placeholders and key values.",
  connection: "DynamoDB couldn't be reached. Check the region, endpoint and network, then retry.",
  credential: AWS_CREDENTIAL_HINT,
  invalid_input: "Fix the highlighted input and run again.",
  not_found: "The table or connection no longer exists.",
  io: "A local file or system operation failed.",
  ssh: "An SSH tunnel failed.",
  ssh_host_key: "An SSH host key wasn't trusted.",
  unknown: "Something unexpected happened.",
}

/** Guidance under a DynamoDB error, chosen by `kind` and the connection's auth type only. */
export function dynamoErrorHint(kind: AppErrorKind, authType?: DynamoAuth["type"]): string {
  if (kind === "credential" && authType === "keys") return AWS_KEYS_CREDENTIAL_HINT
  return HINTS[kind]
}

/** Auth type of a DynamoDB connection, for choosing the error hint. */
export function useDynamoAuthType(connectionId: ConnectionId): DynamoAuth["type"] | undefined {
  return useConnectionsStore((s) => {
    const config = s.connections.find((c) => c.id === connectionId)
    return config?.kind === "dynamodb" ? config.auth.type : undefined
  })
}

export function DynamoErrorPanel({
  error,
  connectionId,
}: {
  error: AppError
  connectionId: ConnectionId
}) {
  const authType = useDynamoAuthType(connectionId)
  return (
    <div className="result-error" role="alert">
      <pre className="result-error__message">{error.message}</pre>
      <p className="result-error__hint">{dynamoErrorHint(error.kind, authType)}</p>
    </div>
  )
}
