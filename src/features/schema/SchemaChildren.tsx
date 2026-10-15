import { Copy, Database, Eye, RefreshCw, Rows3, Table2 } from "lucide-react"
import { useEffect } from "react"
import type { MenuItem } from "../../components/ui"
import type { ConnectionConfig, ConnectionId } from "../../lib/connections"
import { selectActiveTab, useTabsStore } from "../../state/tabsStore"
import { useDynamoCatalog } from "../dynamo/catalogStore"
import {
  copyName,
  loadDatabases,
  loadTables,
  openDynamoTable,
  openTable,
  refreshDynamoTables,
  refreshTable,
  selectRows,
} from "./actions"
import { AthenaDatabases } from "./AthenaTree"
import { ChildList } from "./ChildList"
import { TreeNode } from "./TreeNode"
import { childKey, connectionKey, databaseKey, type TreeChild } from "./treeState"
import { useSchemaTree } from "./treeStore"

const ICON = { size: 13, strokeWidth: 1.75, "aria-hidden": true } as const

function copyItem(name: string): MenuItem {
  return {
    id: "copy",
    label: "Copy name",
    icon: <Copy size={13} aria-hidden />,
    onSelect: () => void copyName(name),
  }
}

function refreshItem(onSelect: () => void): MenuItem {
  return { id: "refresh", label: "Refresh", icon: <RefreshCw size={13} aria-hidden />, onSelect }
}

function MysqlTableNode({
  connectionId,
  database,
  table,
}: {
  connectionId: ConnectionId
  database: string
  table: TreeChild
}) {
  const name = table.name
  const selected = useTabsStore((s) => {
    const active = selectActiveTab(s)
    return (
      active?.kind === "table" &&
      active.connectionId === connectionId &&
      active.database === database &&
      active.table === name
    )
  })
  const Icon = table.kind === "view" ? Eye : Table2
  return (
    <TreeNode
      nodeKey={childKey(databaseKey(connectionId, database), name)}
      level={3}
      label={name}
      icon={<Icon {...ICON} aria-label={table.kind === "view" ? "View" : "Table"} />}
      selected={selected}
      title={`${database}.${name}`}
      onActivate={() => openTable(connectionId, database, name)}
      menuItems={[
        {
          id: "select",
          label: "Select rows",
          icon: <Rows3 size={13} aria-hidden />,
          onSelect: () => void selectRows(connectionId, database, name),
        },
        copyItem(name),
        refreshItem(() => void refreshTable(connectionId, database, name)),
      ]}
    />
  )
}

function MysqlTables({ connectionId, database }: { connectionId: ConnectionId; database: string }) {
  const key = databaseKey(connectionId, database)
  const load = useSchemaTree((s) => s.loads[key])
  useEffect(() => {
    void loadTables(connectionId, database)
  }, [connectionId, database])
  return (
    <ChildList
      parentKey={key}
      level={3}
      items={load?.children ?? null}
      loading={!load || load.status === "loading"}
      error={load?.status === "error" ? load.error : null}
      onRetry={() => void loadTables(connectionId, database, true)}
      noun="tables"
      renderChild={(table) => (
        <MysqlTableNode
          key={table.name}
          connectionId={connectionId}
          database={database}
          table={table}
        />
      )}
    />
  )
}

function DatabaseNode({
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
        refreshItem(() => void loadTables(connectionId, database, true)),
      ]}
    >
      <MysqlTables connectionId={connectionId} database={database} />
    </TreeNode>
  )
}

function MysqlDatabases({ connectionId }: { connectionId: ConnectionId }) {
  const key = connectionKey(connectionId)
  const load = useSchemaTree((s) => s.loads[key])
  useEffect(() => {
    void loadDatabases(connectionId)
  }, [connectionId])
  return (
    <ChildList
      parentKey={key}
      level={2}
      items={load?.children ?? null}
      loading={!load || load.status === "loading"}
      error={load?.status === "error" ? load.error : null}
      onRetry={() => void loadDatabases(connectionId, true)}
      noun="databases"
      renderChild={(db) => (
        <DatabaseNode key={db.name} connectionId={connectionId} database={db.name} />
      )}
    />
  )
}

function DynamoTableNode({ connectionId, table }: { connectionId: ConnectionId; table: string }) {
  const selected = useTabsStore((s) => {
    const active = selectActiveTab(s)
    return (
      active?.kind === "dynamo" && active.connectionId === connectionId && active.table === table
    )
  })
  return (
    <TreeNode
      nodeKey={childKey(connectionKey(connectionId), table)}
      level={2}
      label={table}
      icon={<Table2 {...ICON} />}
      selected={selected}
      onActivate={() => void openDynamoTable(connectionId, table)}
      menuItems={[copyItem(table), refreshItem(() => void refreshDynamoTables(connectionId))]}
    />
  )
}

function DynamoTables({ connectionId }: { connectionId: ConnectionId }) {
  const catalog = useDynamoCatalog((s) => s.catalogs[connectionId])
  useEffect(() => {
    void useDynamoCatalog.getState().loadTables(connectionId)
  }, [connectionId])
  const tables = catalog?.tables ?? null
  return (
    <ChildList
      parentKey={connectionKey(connectionId)}
      level={2}
      items={tables ? tables.map((name) => ({ name, kind: "table" })) : null}
      loading={!catalog || catalog.loading}
      error={catalog?.error ?? null}
      onRetry={() => void refreshDynamoTables(connectionId)}
      noun="tables"
      renderChild={(table) => (
        <DynamoTableNode key={table.name} connectionId={connectionId} table={table.name} />
      )}
    />
  )
}

/**
 * What a connection shows when expanded: databases for MySQL and Athena, tables for DynamoDB.
 */
export function SchemaChildren({ config }: { config: ConnectionConfig }) {
  switch (config.kind) {
    case "mysql":
      return <MysqlDatabases connectionId={config.id} />
    case "athena":
      return <AthenaDatabases connectionId={config.id} />
    case "dynamodb":
      return <DynamoTables connectionId={config.id} />
  }
}
