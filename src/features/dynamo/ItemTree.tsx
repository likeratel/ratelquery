import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Route, Table2 } from "lucide-react"
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"
import { copyToClipboard } from "../../components/grid/clipboard"
import type { Item, KeySchema, PathSegment } from "../../lib/dynamo"
import {
  changesUnder,
  inlineEditType,
  jsonLeafType,
  type PendingAttribute,
  type PendingItemEdit,
} from "../../lib/dynamoEdits"
import { attributeTag, jsonInString, jsonStringReadOnlyReason } from "../../lib/dynamoJson"
import { formatPath, jsonAt, pathKey } from "../../lib/dynamoPath"
import {
  copyValueText,
  isExpanded,
  isTable,
  memberOf,
  tableColumns,
  treeNode,
  type TreeExpansion,
  type TreeNode,
  type TreeValue,
} from "../../lib/dynamoTree"
import { itemColumns, type KeyRole } from "../../lib/dynamoView"
import { matchesShortcut } from "../../lib/shortcuts"
import { APP_SHORTCUTS } from "../query/appShortcuts"
import {
  commitTreeEdit,
  expandTree,
  revealTreePath,
  toggleTreeNode,
  toggleTreeTable,
} from "./actions"

/** Shared by every row of one tree. */
interface TreeContext {
  tabId: string
  /** `keyId` of the item; a field commits only while this item is still the selected one. */
  itemId: string
  edit: PendingItemEdit | undefined
  /** Changes the item as loaded now no longer matches; shown, but not laid over the item. */
  conflicts: ReadonlySet<PendingAttribute>
  expansion: TreeExpansion
  /** False while changes are applied, the key schema is unknown or the item has no key. */
  editable: boolean
}

/** Where a JSON value inside a string sits: the string's path and whether it can be edited. */
interface JsonHost {
  path: readonly PathSegment[]
  /** Why the JSON is read-only, or null when its values can be edited. */
  readOnly: string | null
}

interface Place {
  path: readonly PathSegment[]
  /** Set inside JSON stored in a string. */
  host: JsonHost | null
  /** Members of SS, NS and BS have no document path, so they can't be edited. */
  inSet: boolean
  /** Key role of the top-level attribute; nothing under a key is edited in place. */
  keyRole: KeyRole
}

const depthStyle = (depth: number) => ({ "--depth": depth }) as CSSProperties

/** Text a leaf's field starts with: the value as stored, not as displayed. */
function editText(value: TreeValue): string {
  if (value.kind === "json") return String(value.value)
  const tag = attributeTag(value.value)
  return tag ? String(value.value[tag]) : ""
}

/** Whether the leaf at `place` can be edited in place. */
function canEdit(ctx: TreeContext, place: Place, value: TreeValue): boolean {
  if (!ctx.editable || place.inSet || place.keyRole !== null) return false
  if (value.kind === "json") {
    return place.host?.readOnly === null && jsonLeafType(value.value) !== null
  }
  return inlineEditType(value.value, null) !== null && treeNode(value).json === null
}

/** A leaf inside JSON differs from the string it was loaded from. */
function jsonLeafChanged(ctx: TreeContext, place: Place, value: TreeValue): boolean {
  const host = place.host
  const before = host && ctx.edit?.changes[pathKey(host.path)]?.before
  if (!host || !before || attributeTag(before) !== "S") return false
  const loaded = jsonInString(String(before.S))
  return !loaded || jsonAt(loaded.value, place.path.slice(host.path.length)) !== value.value
}

function isChanged(ctx: TreeContext, place: Place, value: TreeValue): boolean {
  if (place.host) return jsonLeafChanged(ctx, place, value)
  return Boolean(ctx.edit?.changes[pathKey(place.path)])
}

/** A conflicting change sits at `place` (or, for a JSON value, at the string holding it). */
function isConflict(ctx: TreeContext, place: Place): boolean {
  const change = ctx.edit?.changes[pathKey(place.host?.path ?? place.path)]
  return change !== undefined && ctx.conflicts.has(change)
}

function revealRow(container: HTMLElement | null, path: readonly PathSegment[]) {
  requestAnimationFrame(() => {
    const row = container?.querySelector(`[data-path="${CSS.escape(pathKey(path))}"]`)
    row?.scrollIntoView({ block: "nearest" })
  })
}

interface LeafProps {
  ctx: TreeContext
  place: Place
  value: TreeValue
  node: TreeNode
  editable: boolean
  label: string
}

/** A leaf's value; double-click, Enter or F2 edits it in place when it can be edited. */
function LeafValue({ ctx, place, value, node, editable, label }: LeafProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set once Enter or Esc closed the field, so the blur that follows doesn't commit again.
  const closed = useRef(false)
  const readOnly = node.json ? jsonStringReadOnlyReason(node.json) : null

  const close = () => {
    closed.current = true
    setDraft(null)
    setError(null)
  }

  /** Stages the typed value; false (with the error shown) when it isn't valid. */
  const commit = (text: string): boolean => {
    if (closed.current) return true
    const host = place.host
    const failure = host
      ? commitTreeEdit(ctx.tabId, ctx.itemId, host.path, place.path.slice(host.path.length), text)
      : commitTreeEdit(ctx.tabId, ctx.itemId, place.path, [], text)
    if (failure) setError(failure)
    else close()
    return failure === null
  }

  if (draft !== null) {
    return (
      <span className="dyn-tree__edit">
        <input
          className="dyn-tree__input mono"
          aria-label={`Edit ${label}`}
          aria-invalid={error !== null}
          value={draft}
          autoFocus
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.code === "Enter" || event.code === "NumpadEnter") {
              event.preventDefault()
              commit(draft)
            } else if (matchesShortcut(event, APP_SHORTCUTS.apply)) {
              // The value joins the panel's review; one that isn't valid keeps the field open
              // with its error, and nothing is reviewed or applied.
              if (!commit(draft)) {
                event.preventDefault()
                event.stopPropagation()
              }
            } else if (event.code === "Escape") {
              event.preventDefault()
              event.stopPropagation()
              close()
            }
          }}
          onBlur={() => commit(draft)}
        />
        {error && (
          <span className="dyn-tree__error" role="alert">
            {error}
          </span>
        )}
      </span>
    )
  }

  const startEdit = () => {
    closed.current = false
    setDraft(editText(value))
  }
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (["Enter", "NumpadEnter", "F2"].includes(event.code)) {
      event.preventDefault()
      startEdit()
    }
  }
  return (
    <span
      className="dyn-tree__value mono"
      data-tone={node.tone}
      data-editable={editable || undefined}
      tabIndex={editable ? 0 : undefined}
      title={readOnly ?? (editable ? "Double-click to edit" : undefined)}
      onDoubleClick={editable ? startEdit : undefined}
      onKeyDown={editable ? onKeyDown : undefined}
    >
      {node.text}
    </span>
  )
}

interface RowProps {
  ctx: TreeContext
  place: Place
  label: string
  value: TreeValue
  depth: number
}

/** One value, its type and the controls for it, then its members while it is open. */
function TreeRow({ ctx, place, label, value, depth }: RowProps) {
  const node = treeNode(value)
  const holdsJson = node.json !== null
  const children = node.children
  const open = children !== null && isExpanded(ctx.expansion, place.path, holdsJson)
  const columns = children ? tableColumns(children) : null
  const asTable = columns !== null && isTable(ctx.expansion, place.path)
  const tag = attributeTag(value.kind === "wire" ? value.value : {})
  const editable = !children && canEdit(ctx, place, value)
  const changedInside = !place.host && changesUnder(ctx.edit, place.path).length > 0
  const changed = children ? changedInside && !open : isChanged(ctx, place, value)
  const host: JsonHost | null = holdsJson
    ? { path: place.path, readOnly: node.json ? jsonStringReadOnlyReason(node.json) : null }
    : place.host
  const childPlace = (segment: PathSegment): Place => ({
    path: [...place.path, segment],
    host,
    inSet: place.inSet || tag === "SS" || tag === "NS" || tag === "BS",
    keyRole: place.keyRole,
  })

  return (
    <>
      <div
        className="dyn-tree__row"
        style={depthStyle(depth)}
        data-path={pathKey(place.path)}
        data-changed={changed || undefined}
        data-conflict={(!children && isConflict(ctx, place)) || undefined}
      >
        {children ? (
          <button
            type="button"
            className="dyn-tree__toggle"
            aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
            aria-expanded={open}
            onClick={() => toggleTreeNode(ctx.tabId, place.path, holdsJson)}
          >
            <ChevronRight size={13} strokeWidth={2} aria-hidden />
          </button>
        ) : (
          <span className="dyn-tree__toggle" />
        )}
        <span className="dyn-tree__name mono" title={formatPath(place.path)}>
          {label}
          {depth === 0 && place.keyRole && <span className="dyn-attrs__key">{place.keyRole}</span>}
        </span>
        <span className="dyn-type">{node.tag}</span>
        {holdsJson && (
          <span
            className="dyn-type dyn-tree__json"
            title={host?.readOnly ? `Read-only: ${host.readOnly}` : "JSON stored in a string"}
          >
            JSON
          </span>
        )}
        {children ? (
          <span className="dyn-tree__value dyn-tree__count">{node.text}</span>
        ) : (
          <LeafValue
            ctx={ctx}
            place={place}
            value={value}
            node={node}
            editable={editable}
            label={label}
          />
        )}
        <span className="dyn-tree__actions">
          {columns && (
            <button
              type="button"
              className="ui-icon-button"
              aria-label={asTable ? `Show ${label} as a tree` : `Show ${label} as a table`}
              aria-pressed={asTable}
              title={asTable ? "Show as tree" : "Show as table"}
              onClick={() => {
                toggleTreeTable(ctx.tabId, place.path)
                if (!open) toggleTreeNode(ctx.tabId, place.path, holdsJson)
              }}
            >
              <Table2 size={12} strokeWidth={2} />
            </button>
          )}
          <button
            type="button"
            className="ui-icon-button"
            aria-label={`Copy path of ${label}`}
            title="Copy path"
            onClick={() => copyToClipboard(formatPath(place.path))}
          >
            <Route size={12} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="ui-icon-button"
            aria-label={`Copy value of ${label}`}
            title="Copy value"
            onClick={() => copyToClipboard(copyValueText(value))}
          >
            <Copy size={12} strokeWidth={2} />
          </button>
        </span>
      </div>
      {open && children && asTable && columns ? (
        <ObjectTable
          ctx={ctx}
          place={place}
          columns={columns}
          items={children}
          childPlace={childPlace}
          depth={depth + 1}
        />
      ) : (
        open &&
        children?.map((child) => (
          <TreeRow
            key={String(child.segment)}
            ctx={ctx}
            place={childPlace(child.segment)}
            label={typeof child.segment === "number" ? `[${child.segment}]` : child.segment}
            value={child.value}
            depth={depth + 1}
          />
        ))
      )}
    </>
  )
}

interface TableProps {
  ctx: TreeContext
  place: Place
  columns: readonly string[]
  items: readonly { segment: PathSegment; value: TreeValue }[]
  childPlace: (segment: PathSegment) => Place
  depth: number
}

/** A list of maps as rows and the union of their keys as columns. */
function ObjectTable({ ctx, place, columns, items, childPlace, depth }: TableProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const cell = (row: Place, column: string, value: TreeValue | undefined): ReactNode => {
    if (!value) return <span className="dyn-tree__missing">–</span>
    const cellPlace: Place = { ...row, path: [...row.path, column] }
    const node = treeNode(value)
    if (node.children) {
      return (
        <button
          type="button"
          className="dyn-tree__follow mono"
          title="Show in the tree"
          onClick={() => {
            revealTreePath(ctx.tabId, place.path, cellPlace.path)
            revealRow(wrapRef.current?.closest(".dyn-tree") ?? null, cellPlace.path)
          }}
        >
          {node.tag} · {node.text}
        </button>
      )
    }
    return (
      <LeafValue
        ctx={ctx}
        place={cellPlace}
        value={value}
        node={node}
        editable={canEdit(ctx, cellPlace, value)}
        label={formatPath(cellPlace.path)}
      />
    )
  }
  return (
    <div className="dyn-tree__table-wrap" style={depthStyle(depth)} ref={wrapRef}>
      <table className="dyn-tree__table">
        <thead>
          <tr>
            <th scope="col">#</th>
            {columns.map((column) => (
              <th key={column} scope="col" className="mono">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map(({ segment, value }) => {
            const row = childPlace(segment)
            return (
              <tr key={String(segment)} data-path={pathKey(row.path)}>
                <th scope="row" className="mono">
                  {segment}
                </th>
                {columns.map((column) => {
                  const member = memberOf(value, column)
                  const changed =
                    member !== undefined &&
                    !treeNode(member).children &&
                    isChanged(ctx, { ...row, path: [...row.path, column] }, member)
                  return (
                    <td key={column} data-changed={changed || undefined}>
                      {cell(row, column, member)}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

interface ItemTreeProps {
  tabId: string
  itemId: string
  /** The item with its pending values applied. */
  item: Item
  schema: KeySchema | null
  edit: PendingItemEdit | undefined
  conflicts: ReadonlySet<PendingAttribute>
  expansion: TreeExpansion
  editable: boolean
}

/** The selected item as a tree: attributes (keys first) that open into their members. */
export function ItemTree(props: ItemTreeProps) {
  const { tabId, itemId, item, schema, edit, conflicts, expansion, editable } = props
  const columns = itemColumns([item], schema).filter((c) => item[c.name])
  const ctx: TreeContext = { tabId, itemId, edit, conflicts, expansion, editable }
  return (
    <>
      <div className="dyn-tree__bar">
        <button
          type="button"
          className="q-button q-button--ghost"
          onClick={() => expandTree(tabId, true)}
        >
          <ChevronsUpDown size={12} strokeWidth={2.2} />
          Expand all
        </button>
        <button
          type="button"
          className="q-button q-button--ghost"
          onClick={() => expandTree(tabId, false)}
        >
          <ChevronsDownUp size={12} strokeWidth={2.2} />
          Collapse all
        </button>
      </div>
      <div className="dyn-tree">
        {columns.map((column) => (
          <TreeRow
            key={column.name}
            ctx={ctx}
            place={{ path: [column.name], host: null, inSet: false, keyRole: column.key }}
            label={column.name}
            value={{ kind: "wire", value: item[column.name] }}
            depth={0}
          />
        ))}
      </div>
    </>
  )
}
