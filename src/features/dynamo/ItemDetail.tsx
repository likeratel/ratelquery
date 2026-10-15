import { Pencil, X } from "lucide-react"
import type { Item, KeySchema } from "../../lib/dynamo"
import { attributeTag } from "../../lib/dynamoJson"
import { attributeSummary, attributeToCell, itemColumns } from "../../lib/dynamoView"
import { cellTone } from "../../lib/cellFormat"

interface ItemDetailProps {
  item: Item
  schema: KeySchema | null
  onEdit: () => void
  onClose: () => void
}

/** Attribute list of the selected item: name, type and value, keys first. */
export function ItemDetail({ item, schema, onEdit, onClose }: ItemDetailProps) {
  const columns = itemColumns([item], schema).filter((c) => item[c.name])
  return (
    <aside className="dyn-side" aria-label="Item">
      <header className="dyn-side__head">
        <span className="dyn-side__title">Item</span>
        <span className="dyn-side__meta">{columns.length} attributes</span>
        <span className="dyn-side__spacer" />
        <button type="button" className="q-button q-button--ghost" onClick={onEdit}>
          <Pencil size={12} strokeWidth={2.2} />
          Edit
        </button>
        <button
          type="button"
          className="ui-icon-button"
          data-size="md"
          aria-label="Close item"
          onClick={onClose}
        >
          <X size={13} strokeWidth={2.2} />
        </button>
      </header>
      <dl className="dyn-attrs">
        {columns.map((column) => {
          const value = item[column.name]
          return (
            <div key={column.name} className="dyn-attrs__row">
              <dt className="dyn-attrs__name mono" title={column.name}>
                {column.name}
                {column.key && <span className="dyn-attrs__key">{column.key}</span>}
              </dt>
              <dd className="dyn-attrs__value">
                <span className="dyn-type">{attributeTag(value) ?? "?"}</span>
                <span className="dyn-attrs__text mono" data-tone={cellTone(attributeToCell(value))}>
                  {attributeSummary(value)}
                </span>
              </dd>
            </div>
          )
        })}
      </dl>
    </aside>
  )
}
