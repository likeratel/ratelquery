import { Search } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "../../components/ui"
import { useConnectionsStore } from "../../state/connectionsStore"
import {
  handleTreeFocus,
  handleTreeKeyDown,
  isDescendant,
  subscribeTreeCleanup,
  useSchemaTree,
} from "../schema"
import { ConnectionRow } from "./ConnectionRow"
import { filterConnections, SEARCH_THRESHOLD } from "./filter"

export function ConnectionList() {
  const connections = useConnectionsStore((s) => s.connections)
  const status = useConnectionsStore((s) => s.status)
  const loadError = useConnectionsStore((s) => s.loadError)
  const [query, setQuery] = useState("")
  const focused = useSchemaTree((s) => s.focused)

  useEffect(() => subscribeTreeCleanup(), [])

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

  if (connections.length === 0) {
    if (status !== "ready") return null
    return (
      <div className="sidebar__empty">
        <strong>No connections yet</strong>
        Add a MySQL server or a DynamoDB profile to start browsing.
      </div>
    )
  }

  const searchable = connections.length >= SEARCH_THRESHOLD
  const visible = searchable ? filterConnections(connections, query) : connections
  // The first row takes the tab stop while the focused node is gone (deleted or filtered out).
  const stopShown =
    focused !== null && visible.some((c) => c.id === focused || isDescendant(focused, c.id))

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
      {visible.length === 0 ? (
        <p className="conn-list__none">No connections match “{query.trim()}”.</p>
      ) : (
        <ul
          className="conn-list"
          role="tree"
          aria-label="Connections"
          onKeyDown={handleTreeKeyDown}
          onFocus={handleTreeFocus}
        >
          {visible.map((config, index) => (
            <ConnectionRow key={config.id} config={config} tabStop={index === 0 && !stopShown} />
          ))}
        </ul>
      )}
    </>
  )
}
