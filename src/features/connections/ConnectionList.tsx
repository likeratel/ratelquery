import { Search } from "lucide-react"
import { useMemo, useState } from "react"
import { Button } from "../../components/ui"
import { layoutEntries, reconcileLayout } from "../../lib/connectionLayout"
import { useConnectionLayout } from "../../state/connectionLayoutStore"
import { useConnectionsStore } from "../../state/connectionsStore"
import { handleTreeFocus, handleTreeKeyDown, useSchemaTree } from "../schema"
import { filterConnections, SEARCH_THRESHOLD } from "./filter"
import { LayoutEntryRow } from "./FolderRow"
import { entryKey, showsNode } from "./layoutTree"
import { useDragState, useLayoutDrag } from "./useLayoutDrag"

export function ConnectionList() {
  const connections = useConnectionsStore((s) => s.connections)
  const status = useConnectionsStore((s) => s.status)
  const loadError = useConnectionsStore((s) => s.loadError)
  const savedLayout = useConnectionLayout((s) => s.layout)
  const layoutStatus = useConnectionLayout((s) => s.status)
  const [query, setQuery] = useState("")
  const focused = useSchemaTree((s) => s.focused)
  const dragging = useDragState((s) => s.dragging !== null)
  const layout = useMemo(
    () => reconcileLayout(savedLayout, connections),
    [savedLayout, connections],
  )

  const searchable = connections.length >= SEARCH_THRESHOLD
  const filtering = searchable && query.trim() !== ""
  const drag = useLayoutDrag(!filtering)

  if (status === "error" && loadError && connections.length === 0) {
    return (
      <div className="sidebar__empty" role="alert">
        <strong>{loadError.summary}</strong>
        <span className="conn-list__detail">{loadError.detail}</span>
        <Button size="sm" onClick={() => void useConnectionsStore.getState().load()}>
          Try again
        </Button>
      </div>
    )
  }

  // Wait for the saved order so the list doesn't jump from name order to it.
  if (layoutStatus === "loading") return null

  if (connections.length === 0 && layout.folders.length === 0) {
    if (status !== "ready") return null
    return (
      <div className="sidebar__empty">
        <strong>No connections yet</strong>
        Add a MySQL server or a DynamoDB profile to start browsing
      </div>
    )
  }

  const matches = filtering ? new Set(filterConnections(connections, query).map((c) => c.id)) : null
  const entries = layoutEntries(layout, connections, matches ? (c) => matches.has(c.id) : undefined)
  // The first row takes the tab stop while the focused node is gone (deleted or filtered out).
  const stopShown = focused !== null && showsNode(entries, focused, filtering)

  return (
    <>
      {searchable && (
        <label className="conn-search">
          <Search size={13} aria-hidden className="conn-search__icon" />
          <input
            className="conn-search__input"
            type="search"
            placeholder="Filter connections"
            aria-label="Filter connections"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
          />
        </label>
      )}
      {entries.length === 0 ? (
        <p className="conn-list__none">No connections match “{query.trim()}”</p>
      ) : (
        <ul
          className="conn-list"
          role="tree"
          aria-label="Connections"
          data-dragging={dragging || undefined}
          onKeyDown={handleTreeKeyDown}
          onFocus={handleTreeFocus}
          onPointerDown={drag.onPointerDown}
        >
          {entries.map((entry, index) => (
            <LayoutEntryRow
              key={entryKey(entry)}
              entry={entry}
              level={1}
              forceOpen={filtering}
              tabStop={index === 0 && !stopShown}
            />
          ))}
        </ul>
      )}
    </>
  )
}
