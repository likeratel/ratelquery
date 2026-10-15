import { editorIdentity, selectedItem } from "../../lib/dynamoTabs"
import { selectActiveDynamoTab, useTabsStore } from "../../state/tabsStore"
import { openItemEditor, selectRow } from "./actions"
import { useDynamoCatalog } from "./catalogStore"
import { ItemDetail } from "./ItemDetail"
import { ItemEditor } from "./ItemEditor"
import { ItemsPanel } from "./ItemsPanel"
import { QueryForm } from "./QueryForm"
import { TablePanel } from "./TablePanel"
import "../query/query.css"
import "./dynamo.css"

/** The active DynamoDB tab: tables on the left, request form above the items, item side panel. */
export function DynamoWorkspace() {
  const tab = useTabsStore(selectActiveDynamoTab)
  const description = useDynamoCatalog((s) =>
    tab?.table ? (s.catalogs[tab.connectionId]?.descriptions[tab.table] ?? null) : null,
  )
  if (!tab) return null
  const schema = description?.keySchema ?? null
  const item = selectedItem(tab)

  return (
    <div className="dyn" key={tab.id}>
      <TablePanel tab={tab} />
      <div className="dyn-main">
        {tab.table ? (
          <>
            <QueryForm tab={tab} description={description} />
            <div className="dyn-body">
              <ItemsPanel tab={tab} schema={schema} />
              {tab.editor ? (
                <ItemEditor
                  key={editorIdentity(tab.editor, schema)}
                  tab={tab}
                  editor={tab.editor}
                  schema={schema}
                />
              ) : (
                item &&
                tab.view === "table" && (
                  <ItemDetail
                    item={item}
                    schema={schema}
                    onEdit={() => openItemEditor(tab.id, item)}
                    onClose={() => selectRow(tab.id, null)}
                  />
                )
              )}
            </div>
          </>
        ) : (
          <div className="results__empty">Choose a table to browse its items</div>
        )}
      </div>
    </div>
  )
}
