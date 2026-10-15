import { formatElapsed } from "../../lib/cellFormat"
import type { DynamoTab } from "../../lib/dynamoTabs"
import { useConnectionsStore } from "../../state/connectionsStore"
import { useDynamoCatalog } from "./catalogStore"

/** Status bar items for a DynamoDB tab: connection, region, table and last request time. */
export function DynamoStatus({ tab }: { tab: DynamoTab }) {
  const connection = useConnectionsStore((s) =>
    s.connections.find((c) => c.id === tab.connectionId),
  )
  const catalog = useDynamoCatalog((s) => s.catalogs[tab.connectionId])
  const state = catalog?.error
    ? "error"
    : catalog?.tables
      ? "connected"
      : catalog?.loading
        ? "connecting"
        : "disconnected"
  const title = catalog?.error?.message ?? (state === "connected" ? "Connected" : "Connecting")
  const region = connection?.kind === "dynamodb" ? connection.region : null
  const local = connection?.kind === "dynamodb" && Boolean(connection.endpoint)

  return (
    <>
      <span className="statusbar__item" title={title}>
        <span className="dot" data-state={state} />
        {connection?.name ?? "Unknown connection"}
      </span>
      {region && (
        <span
          className="statusbar__item"
          title={local && connection?.kind === "dynamodb" ? connection.endpoint : undefined}
        >
          DynamoDB {region}
          {local ? " · custom endpoint" : ""}
        </span>
      )}
      {tab.table && (
        <span className="statusbar__item">
          <span className="statusbar__label">Table</span>
          <span className="mono">{tab.table}</span>
        </span>
      )}
      {tab.lastElapsedMs !== null && (
        <span className="statusbar__item">Last request {formatElapsed(tab.lastElapsedMs)}</span>
      )}
    </>
  )
}
