import type { CSSProperties } from "react"
import { ResizeHandle } from "../../components/ui"
import { itemEdit, withPendingValues } from "../../lib/dynamoEdits"
import { editorIdentity, selectedItem } from "../../lib/dynamoTabs"
import { PANEL_SPECS } from "../../lib/panelWidths"
import { selectActiveDynamoTab, useTabsStore } from "../../state/tabsStore"
import { useUiStore } from "../../state/uiStore"
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
  const tablesWidth = useUiStore((s) => s.panelWidths.dynamoTables)
  const sideWidth = useUiStore((s) => s.panelWidths.dynamoSide)
  const setPanelWidth = useUiStore((s) => s.setPanelWidth)
  if (!tab) return null
  const schema = description?.keySchema ?? null
  const item = selectedItem(tab)
  const detailItem = !tab.editor && tab.view === "table" ? item : null
  const sideOpen = Boolean(tab.editor || detailItem)
  const widths = {
    "--dyn-tables-width": `${tablesWidth}px`,
    "--dyn-side-width": `${sideWidth}px`,
  } as CSSProperties

  return (
    <div className="dyn" key={tab.id} style={widths}>
      <TablePanel tab={tab} />
      <ResizeHandle
        className="dyn-tables-resize"
        width={tablesWidth}
        spec={PANEL_SPECS.dynamoTables}
        edge="end"
        label="Resize tables list"
        onResize={(width, settled) => setPanelWidth("dynamoTables", width, settled)}
      />
      <div className="dyn-main">
        {tab.table ? (
          <>
            <QueryForm tab={tab} description={description} />
            <div className="dyn-body">
              <ItemsPanel tab={tab} schema={schema} />
              {sideOpen && (
                <ResizeHandle
                  className="dyn-side-resize"
                  width={sideWidth}
                  spec={PANEL_SPECS.dynamoSide}
                  edge="start"
                  label="Resize item panel"
                  onResize={(width, settled) => setPanelWidth("dynamoSide", width, settled)}
                />
              )}
              {tab.editor ? (
                <ItemEditor
                  key={editorIdentity(tab.editor, schema)}
                  tab={tab}
                  editor={tab.editor}
                  schema={schema}
                />
              ) : (
                detailItem && (
                  <ItemDetail
                    item={withPendingValues(detailItem, itemEdit(tab.edits, detailItem, schema))}
                    schema={schema}
                    onEdit={() => openItemEditor(tab.id, detailItem)}
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
