import { Copy } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "../../components/ui"
import type { ForeignKeyInfo, IndexInfo, SchemaColumn, TableDetails } from "../../lib/mysql"
import { copyText } from "./actions"
import { columnExtra, columnKey } from "./details"

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string
  count?: number
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="table-ws__section" aria-label={title}>
      <header className="table-ws__section-head">
        <h2 className="table-ws__section-title">{title}</h2>
        {count !== undefined && <span className="table-ws__count">{count}</span>}
        <span className="table-ws__spacer" />
        {action}
      </header>
      {children}
    </section>
  )
}

const Faint = ({ children }: { children: ReactNode }) => (
  <span className="table-ws__faint">{children}</span>
)

function ColumnRow({ column, indexes }: { column: SchemaColumn; indexes: readonly IndexInfo[] }) {
  const key = columnKey(column, indexes)
  return (
    <tr>
      <td className="mono">{column.name}</td>
      <td className="mono table-ws__type">{column.typeName}</td>
      <td>{column.nullable ? "Yes" : "No"}</td>
      <td>{key ? <span className="table-ws__key">{key}</span> : null}</td>
      <td className="mono">
        {column.defaultValue === null ? <Faint>None</Faint> : column.defaultValue}
      </td>
      <td className="mono">{columnExtra(column)}</td>
      <td className="table-ws__comment-cell">{column.comment}</td>
    </tr>
  )
}

function ColumnsTable({ details }: { details: TableDetails }) {
  return (
    <Section title="Columns" count={details.columns.length}>
      <table className="schema-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>Key</th>
            <th>Default</th>
            <th>Extra</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {details.columns.map((column) => (
            <ColumnRow key={column.name} column={column} indexes={details.indexes} />
          ))}
        </tbody>
      </table>
    </Section>
  )
}

function IndexesTable({ indexes }: { indexes: readonly IndexInfo[] }) {
  return (
    <Section title="Indexes" count={indexes.length}>
      {indexes.length === 0 ? (
        <p className="table-ws__none">No indexes</p>
      ) : (
        <table className="schema-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Unique</th>
              <th>Columns</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {indexes.map((index) => (
              <tr key={index.name}>
                <td className="mono">{index.name}</td>
                <td>{index.unique ? "Yes" : "No"}</td>
                <td className="mono">{index.columns.join(", ")}</td>
                <td>{index.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

function ForeignKeysTable({ foreignKeys }: { foreignKeys: readonly ForeignKeyInfo[] }) {
  return (
    <Section title="Foreign keys" count={foreignKeys.length}>
      {foreignKeys.length === 0 ? (
        <p className="table-ws__none">No foreign keys</p>
      ) : (
        <table className="schema-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Columns</th>
              <th>References</th>
              <th>On update</th>
              <th>On delete</th>
            </tr>
          </thead>
          <tbody>
            {foreignKeys.map((fk) => (
              <tr key={fk.name}>
                <td className="mono">{fk.name}</td>
                <td className="mono">{fk.columns.join(", ")}</td>
                <td className="mono">
                  {fk.referencedTable} ({fk.referencedColumns.join(", ")})
                </td>
                <td>{fk.onUpdate}</td>
                <td>{fk.onDelete}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

function DdlBlock({ ddl }: { ddl: string }) {
  return (
    <Section
      title="DDL"
      action={
        <Button size="sm" variant="ghost" onClick={() => void copyDdl(ddl)}>
          <Copy size={13} aria-hidden />
          Copy
        </Button>
      }
    >
      <pre className="table-ws__ddl mono">{ddl}</pre>
    </Section>
  )
}

const copyDdl = (ddl: string) => copyText(ddl, "Copied DDL")

export function TableSections({ details }: { details: TableDetails }) {
  return (
    <>
      <ColumnsTable details={details} />
      <IndexesTable indexes={details.indexes} />
      <ForeignKeysTable foreignKeys={details.foreignKeys} />
      <DdlBlock ddl={details.ddl} />
    </>
  )
}
