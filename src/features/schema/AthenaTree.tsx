import { Copy, Database, Eye, RefreshCw, Table2, TextCursorInput } from "lucide-react"
import { useEffect } from "react"
import type { MenuItem } from "../../components/ui"
import type { ConnectionId } from "../../lib/connections"
import { copyName } from "./actions"
import { loadAthenaDatabases, loadAthenaTables, queryAthenaTable } from "./athenaActions"
import { ChildList } from "./ChildList"
import { TreeNode } from "./TreeNode"
import { childKey, connectionKey, databaseKey, type TreeChild } from "./treeState"
import { useSchemaTree } from "./treeStore"

const ICON = { size: 13, strokeWidth: 1.75, "aria-hidden": true } as const

const copyItem = (name: string): MenuItem => ({
  id: "copy",
  label: "Copy name",
  icon: <Copy size={13} aria-hidden />,
  onSelect: () => void copyName(name),
})

const refreshItem = (onSelect: () => void): MenuItem => ({
  id: "refresh",
  label: "Refresh",
  icon: <RefreshCw size={13} aria-hidden />,
  onSelect,
})

function AthenaTableNode(props: {
  connectionId: ConnectionId
  database: string
  table: TreeChild
}) {
  const { connectionId, database, table } = props
  const name = table.name
  const Icon = table.kind === "view" ? Eye : Table2
  const query = () => queryAthenaTable(connectionId, database, name)
  return (
    <TreeNode
      nodeKey={childKey(databaseKey(connectionId, database), name)}
      level={3}
      label={name}
      icon={<Icon {...ICON} aria-label={table.kind === "view" ? "View" : "Table"} />}
      title={`${database}.${name}`}
      onActivate={query}
      menuItems={[
        {
          id: "query",
          label: "Query rows",
          icon: <TextCursorInput size={13} aria-hidden />,
          onSelect: query,
        },
        copyItem(name),
        refreshItem(() => void loadAthenaTables(connectionId, database, true)),
      ]}
    />
  )
}

function AthenaTables({
  connectionId,
  database,
}: {
  connectionId: ConnectionId
  database: string
}) {
  const key = databaseKey(connectionId, database)
  const load = useSchemaTree((s) => s.loads[key])
  useEffect(() => {
    void loadAthenaTables(connectionId, database)
  }, [connectionId, database])
  return (
    <ChildList
      parentKey={key}
      level={3}
      items={load?.children ?? null}
      loading={!load || load.status === "loading"}
      error={load?.status === "error" ? load.error : null}
      onRetry={() => void loadAthenaTables(connectionId, database, true)}
      noun="tables"
      renderChild={(table) => (
        <AthenaTableNode
          key={table.name}
          connectionId={connectionId}
          database={database}
          table={table}
        />
      )}
    />
  )
}

function AthenaDatabaseNode({
  connectionId,
  database,
}: {
  connectionId: ConnectionId
  database: string
}) {
  const key = databaseKey(connectionId, database)
  const expanded = useSchemaTree((s) => Boolean(s.expanded[key]))
  return (
    <TreeNode
      nodeKey={key}
      level={2}
      label={database}
      icon={<Database {...ICON} />}
      expanded={expanded}
      onToggle={() => useSchemaTree.getState().toggle(key)}
      menuItems={[
        copyItem(database),
        refreshItem(() => void loadAthenaTables(connectionId, database, true)),
      ]}
    >
      <AthenaTables connectionId={connectionId} database={database} />
    </TreeNode>
  )
}

/** An expanded Athena connection: its databases, then their tables and views. */
export function AthenaDatabases({ connectionId }: { connectionId: ConnectionId }) {
  const key = connectionKey(connectionId)
  const load = useSchemaTree((s) => s.loads[key])
  useEffect(() => {
    void loadAthenaDatabases(connectionId)
  }, [connectionId])
  return (
    <ChildList
      parentKey={key}
      level={2}
      items={load?.children ?? null}
      loading={!load || load.status === "loading"}
      error={load?.status === "error" ? load.error : null}
      onRetry={() => void loadAthenaDatabases(connectionId, true)}
      noun="databases"
      renderChild={(db) => (
        <AthenaDatabaseNode key={db.name} connectionId={connectionId} database={db.name} />
      )}
    />
  )
}
