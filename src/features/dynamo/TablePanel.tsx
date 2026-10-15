import { RefreshCw, Table2 } from "lucide-react"
import { useEffect, useState } from "react"
import type { IndexDescription, KeySchema, TableDescription } from "../../lib/dynamo"
import type { DynamoTab } from "../../lib/dynamoTabs"
import { chooseTable } from "./actions"
import { useDynamoCatalog } from "./catalogStore"
import { dynamoErrorHint, useDynamoAuthType } from "./errors"

function KeyLine({ role, name, type }: { role: string; name: string; type: string }) {
  return (
    <div className="dyn-info__row">
      <span className="dyn-info__label">{role}</span>
      <span className="dyn-info__value mono">{name}</span>
      <span className="dyn-type">{type}</span>
    </div>
  )
}

function keysText(schema: KeySchema): string {
  return schema.range ? `${schema.hash.name}, ${schema.range.name}` : schema.hash.name
}

function IndexLine({ index }: { index: IndexDescription }) {
  return (
    <li className="dyn-info__index" title={`Projection: ${index.projection.replace("_", " ")}`}>
      <span className="dyn-info__value mono">{index.name}</span>
      <span className="dyn-type">{index.kind.toUpperCase()}</span>
      <span className="dyn-info__keys mono">{keysText(index.keySchema)}</span>
    </li>
  )
}

function TableInfo({ description }: { description: TableDescription }) {
  const { keySchema, indexes, itemCount } = description
  return (
    <div className="dyn-info">
      <KeyLine role="Partition" name={keySchema.hash.name} type={keySchema.hash.type} />
      {keySchema.range && (
        <KeyLine role="Sort" name={keySchema.range.name} type={keySchema.range.type} />
      )}
      {itemCount !== null && (
        <div className="dyn-info__row" title="Approximate, updated by DynamoDB every few hours">
          <span className="dyn-info__label">Items</span>
          <span className="dyn-info__value">≈ {itemCount.toLocaleString()}</span>
        </div>
      )}
      {description.status !== "ACTIVE" && (
        <div className="dyn-info__row">
          <span className="dyn-info__label">Status</span>
          <span className="dyn-info__value">{description.status.toLowerCase()}</span>
        </div>
      )}
      {indexes.length > 0 && (
        <>
          <div className="dyn-info__heading">Indexes</div>
          <ul className="dyn-info__indexes">
            {indexes.map((index) => (
              <IndexLine key={index.name} index={index} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** The tab's table list with a filter, and the selected table's keys and indexes. */
export function TablePanel({ tab }: { tab: DynamoTab }) {
  const catalog = useDynamoCatalog((s) => s.catalogs[tab.connectionId])
  const loadTables = useDynamoCatalog((s) => s.loadTables)
  const describe = useDynamoCatalog((s) => s.describe)
  const [filter, setFilter] = useState("")
  const authType = useDynamoAuthType(tab.connectionId)

  useEffect(() => {
    void loadTables(tab.connectionId)
  }, [loadTables, tab.connectionId])

  const tables = catalog?.tables ?? []
  const needle = filter.trim().toLowerCase()
  const visible = needle ? tables.filter((t) => t.toLowerCase().includes(needle)) : tables
  const description = tab.table ? catalog?.descriptions[tab.table] : undefined
  const describeError = tab.table ? catalog?.describeErrors[tab.table] : undefined
  const describing = tab.table ? Boolean(catalog?.describing[tab.table]) : false

  return (
    <aside className="dyn-tables" aria-label="Tables">
      <div className="dyn-tables__head">
        <span className="dyn-tables__title">Tables</span>
        {catalog?.tables && <span className="dyn-tables__count">{tables.length}</span>}
        <span className="dyn-tables__spacer" />
        <button
          type="button"
          className="ui-icon-button"
          data-size="md"
          aria-label="Refresh"
          title="Refresh"
          disabled={catalog?.loading}
          onClick={() => {
            void loadTables(tab.connectionId, true)
            if (tab.table) void describe(tab.connectionId, tab.table, true)
          }}
        >
          <RefreshCw size={13} strokeWidth={2} />
        </button>
      </div>
      <input
        className="dyn-input dyn-tables__search"
        placeholder="Filter tables"
        aria-label="Filter tables"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      <div className="dyn-tables__body">
        {catalog?.error ? (
          <div className="dyn-tables__state dyn-tables__state--error" role="alert">
            <p>{catalog.error.message}</p>
            <p className="dyn-tables__hint">{dynamoErrorHint(catalog.error.kind, authType)}</p>
          </div>
        ) : !catalog?.tables ? (
          <p className="dyn-tables__state">Loading tables…</p>
        ) : visible.length === 0 ? (
          <p className="dyn-tables__state">
            {tables.length === 0
              ? "No tables in this region"
              : `No tables match “${filter.trim()}”`}
          </p>
        ) : (
          <ul className="dyn-tables__list" role="listbox" aria-label="Tables">
            {visible.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={name === tab.table}
                  className="dyn-tables__item"
                  title={name}
                  onClick={() => void chooseTable(tab.id, name)}
                >
                  <Table2 size={13} strokeWidth={1.75} className="dyn-tables__icon" />
                  <span className="dyn-tables__name">{name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {tab.table && (
        <div className="dyn-tables__detail">
          {description ? (
            <TableInfo description={description} />
          ) : describeError ? (
            <p className="dyn-tables__state dyn-tables__state--error">{describeError.message}</p>
          ) : (
            <p className="dyn-tables__state">{describing ? "Loading keys…" : ""}</p>
          )}
        </div>
      )}
    </aside>
  )
}
