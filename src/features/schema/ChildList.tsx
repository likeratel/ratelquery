import { CircleAlert, LoaderCircle, Search } from "lucide-react"
import type { ReactNode } from "react"
import type { AppError } from "../../lib/ipc"
import { useTreeTabIndex } from "./treeKeyboard"
import { depthStyle } from "./TreeNode"
import { childKey, filterChildren, TABLE_FILTER_THRESHOLD, type TreeChild } from "./treeState"
import { useSchemaTree } from "./treeStore"

/** Key of a parent's status row; never a real child name, so a reload moves focus off it. */
const statusKey = (parentKey: string) => childKey(parentKey, "\u0001status")

function TreeStatus({
  parentKey,
  level,
  tone,
  message,
  onRetry,
}: {
  parentKey: string
  level: number
  tone: "loading" | "error" | "empty"
  message: string
  onRetry?: () => void
}) {
  const key = statusKey(parentKey)
  const tabIndex = useTreeTabIndex(key)
  return (
    <li
      role="treeitem"
      className="tree-item tree-status"
      data-tone={tone}
      aria-level={level}
      aria-disabled={tone === "error" ? undefined : true}
      aria-label={message}
      data-tree-key={key}
      tabIndex={tabIndex}
    >
      <div className="tree-line">
        <div className="tree-row" style={depthStyle(level)}>
          <span className="tree-row__twisty" aria-hidden />
          {tone === "loading" && (
            <LoaderCircle size={13} className="tree-spin tree-status__icon" aria-hidden />
          )}
          {tone === "error" && <CircleAlert size={13} className="tree-status__icon" aria-hidden />}
          <span className="tree-row__name" title={message}>
            {message}
          </span>
          {onRetry && (
            <button
              type="button"
              className="tree-status__retry"
              tabIndex={-1}
              data-tree-action=""
              onClick={onRetry}
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

function TreeFilter({
  parentKey,
  level,
  noun,
}: {
  parentKey: string
  level: number
  noun: string
}) {
  const value = useSchemaTree((s) => s.filters[parentKey] ?? "")
  return (
    <li role="none" className="tree-filter" style={depthStyle(level)}>
      <label className="tree-filter__box">
        <Search size={12} aria-hidden className="tree-filter__icon" />
        <input
          className="tree-filter__input"
          type="search"
          placeholder={`Filter ${noun}`}
          aria-label={`Filter ${noun}`}
          value={value}
          tabIndex={-1}
          data-tree-filter=""
          spellCheck={false}
          onChange={(event) => useSchemaTree.getState().setFilter(parentKey, event.target.value)}
        />
      </label>
    </li>
  )
}

interface ChildListProps {
  parentKey: string
  /** aria-level of the children. */
  level: number
  /** Null until the first load answers. */
  items: readonly TreeChild[] | null
  loading: boolean
  error: AppError | null
  onRetry: () => void
  /** Plural noun for the empty and filter copy, e.g. "tables". */
  noun: string
  renderChild: (child: TreeChild) => ReactNode
}

/** Loading, error and empty lines, an optional filter, then the children of one node. */
export function ChildList({
  parentKey,
  level,
  items,
  loading,
  error,
  onRetry,
  noun,
  renderChild,
}: ChildListProps) {
  const query = useSchemaTree((s) => s.filters[parentKey] ?? "")
  const all = items ?? []
  const filterable = all.length >= TABLE_FILTER_THRESHOLD
  const visible = filterable ? filterChildren(all, query) : all
  const status = (tone: "loading" | "error" | "empty", message: string, retry?: () => void) => (
    <TreeStatus parentKey={parentKey} level={level} tone={tone} message={message} onRetry={retry} />
  )

  if (error) return status("error", error.message, onRetry)
  if (!items) return loading ? status("loading", "Loading…") : null
  if (all.length === 0) return status("empty", `No ${noun}`)
  return (
    <>
      {filterable && <TreeFilter parentKey={parentKey} level={level} noun={noun} />}
      {visible.length === 0 && status("empty", `No ${noun} match “${query.trim()}”`)}
      {visible.map(renderChild)}
    </>
  )
}
