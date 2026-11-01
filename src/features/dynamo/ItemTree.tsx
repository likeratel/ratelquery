import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Route,
  Search,
  Table2,
} from "lucide-react"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"
import { copyToClipboard } from "../../components/grid/clipboard"
import type { Item, KeySchema, PathSegment } from "../../lib/dynamo"
import { changesUnder, type PendingAttribute, type PendingItemEdit } from "../../lib/dynamoEdits"
import { jsonStringReadOnlyReason } from "../../lib/dynamoJson"
import { formatPath, pathKey } from "../../lib/dynamoPath"
import {
  filterShows,
  filterTableRows,
  visibleRanges,
  type FindHit,
  type FindRange,
} from "../../lib/dynamoSearch"
import type { FindChoices } from "../../lib/dynamoTabs"
import {
  copyValueText,
  EXPAND_LIMIT,
  isExpanded,
  isTable,
  memberOf,
  tableColumns,
  treeNode,
  type TreeExpansion,
  type TreeNode,
  type TreeValue,
} from "../../lib/dynamoTree"
import {
  canEdit,
  editText,
  isChanged,
  isConflict,
  loadedJson,
  memberPlace,
  membersHost,
  shownLength,
  startsTreeEdit,
  treeFieldKey,
  type Place,
  type TreeEditView,
} from "../../lib/dynamoTreeView"
import { itemColumns } from "../../lib/dynamoView"
import { formatShortcut, matchesShortcut } from "../../lib/shortcuts"
import { APP_SHORTCUTS } from "../query/appShortcuts"
import { commitTreeEdit } from "./actions"
import { FindBar } from "./FindBar"
import { requestFind } from "./findStore"
import { DYNAMO_SHORTCUTS } from "./shortcuts"
import { useTreeFind, type TreeFind } from "./useTreeFind"

/** Shared by every row of one tree. */
interface TreeContext extends TreeEditView {
  tabId: string
  /** `keyId` of the item; a field commits only while this item is still the selected one. */
  itemId: string
  expansion: TreeExpansion
  find: TreeFind | null
  /** Expansion changes; during a search they last only as long as the search. */
  toggle: (path: readonly PathSegment[], holdsJson: boolean) => void
  toggleTable: (path: readonly PathSegment[]) => void
  /** Leaves the table of the list at `path` for the tree, opened down to `target`. */
  reveal: (path: readonly PathSegment[], target: readonly PathSegment[]) => void
  /** Marks the leaf at `path` as the one whose field is open, kept in view by filter mode. */
  setEditing: (path: readonly PathSegment[]) => void
  /** Lets go of the open-field mark if the leaf at `path` still holds it. */
  releaseEditing: (path: readonly PathSegment[]) => void
}

/** The hit at `path`, if the search found one there. */
function hitAt(ctx: TreeContext, path: readonly PathSegment[]): FindHit | undefined {
  const at = ctx.find?.positions.get(pathKey(path))
  return at === undefined ? undefined : ctx.find?.hits[at]
}

interface MarkedProps {
  text: string
  ranges: readonly FindRange[] | undefined
  /** Characters of `text` that are the value; a shortened value ends in `…` past them. */
  limit?: number
}

/** `text` with the found substrings marked, and a count of the matches cut off with it. */
function Marked({ text, ranges, limit = text.length }: MarkedProps) {
  if (!ranges || ranges.length === 0) return <>{text}</>
  const { shown, hidden } = visibleRanges(ranges, limit)
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of shown) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(
      <mark key={start} className="dyn-find__mark">
        {text.slice(start, end)}
      </mark>,
    )
    at = end
  }
  if (at < text.length) parts.push(text.slice(at))
  if (hidden > 0) {
    parts.push(
      <span
        key="more"
        className="dyn-find__more"
        title={`${hidden} more ${hidden === 1 ? "match" : "matches"} past the shortened text; copy the value to see it whole`}
      >
        +{hidden}
      </span>,
    )
  }
  return <>{parts}</>
}

const depthStyle = (depth: number) => ({ "--depth": depth }) as CSSProperties

interface LeafProps {
  ctx: TreeContext
  place: Place
  value: TreeValue
  node: TreeNode
  editable: boolean
  label: string
  /** Found substrings of the shown text. */
  marks?: readonly FindRange[]
}

/** A leaf's value; double-click, Enter or F2 edits it in place when it can be edited. */
function LeafValue({ ctx, place, value, node, editable, label, marks }: LeafProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set once Enter or Esc closed the field, so the blur that follows doesn't commit again.
  const closed = useRef(false)
  // Whether this leaf holds the tree's open-field pin, to let go of it if the leaf goes away.
  const pinned = useRef(false)
  const release = ctx.releaseEditing
  const path = useRef(place.path)
  path.current = place.path
  useEffect(
    () => () => {
      if (pinned.current) release(path.current)
    },
    [release],
  )
  const readOnly = node.json ? jsonStringReadOnlyReason(node.json) : null

  const close = () => {
    closed.current = true
    pinned.current = false
    setDraft(null)
    setError(null)
    ctx.releaseEditing(place.path)
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
            // Enter that confirms a Hangul syllable (or kana) and Esc that drops a composition
            // belong to the IME; neither commits nor closes the field mid-word.
            const key = treeFieldKey(event.nativeEvent)
            if (key === "composing") return
            if (key === "commit") {
              event.preventDefault()
              commit(draft)
            } else if (matchesShortcut(event, APP_SHORTCUTS.apply)) {
              // The value joins the panel's review; one that isn't valid keeps the field open
              // with its error, and nothing is reviewed or applied.
              if (!commit(draft)) {
                event.preventDefault()
                event.stopPropagation()
              }
            } else if (key === "cancel") {
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
    pinned.current = true
    ctx.setEditing(place.path)
    setDraft(editText(value))
  }
  const onKeyDown = (event: ReactKeyboardEvent) => {
    // Only bare Enter or F2: Mod+Enter and Shift+Enter go on to the app's Run shortcut.
    if (startsTreeEdit(event.nativeEvent)) {
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
      <Marked text={node.text} ranges={marks} limit={shownLength(value, node)} />
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
  const editable = !children && canEdit(ctx, place, value)
  const changedInside = !place.host && changesUnder(ctx.edit, place.path).length > 0
  const changed = children ? changedInside && !open : isChanged(ctx, place, value)
  const host = membersHost(place, node)
  const childPlace = (segment: PathSegment): Place => memberPlace(place, value, node, segment)
  const hit = hitAt(ctx, place.path)
  const rowKey = pathKey(place.path)
  const filter = ctx.find?.filter
  const shownChildren =
    children && filter
      ? children.filter((child) => filterShows(filter, [...place.path, child.segment]))
      : children

  return (
    <>
      <div
        className="dyn-tree__row"
        style={depthStyle(depth)}
        data-path={rowKey}
        data-changed={changed || undefined}
        data-conflict={(!children && isConflict(ctx, place)) || undefined}
        data-match={hit ? ctx.find?.via : undefined}
        data-current={(hit && ctx.find?.current === rowKey) || undefined}
      >
        {children ? (
          <button
            type="button"
            className="dyn-tree__toggle"
            aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
            aria-expanded={open}
            onClick={() => ctx.toggle(place.path, holdsJson)}
          >
            <ChevronRight size={13} strokeWidth={2} aria-hidden />
          </button>
        ) : (
          <span className="dyn-tree__toggle" />
        )}
        <span className="dyn-tree__name mono" title={formatPath(place.path)}>
          {typeof place.path.at(-1) === "string" ? (
            <Marked text={label} ranges={hit?.key} />
          ) : (
            label
          )}
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
            marks={hit?.value}
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
                ctx.toggleTable(place.path)
                if (!open) ctx.toggle(place.path, holdsJson)
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
          items={filter ? filterTableRows(filter, place.path, children) : children}
          childPlace={childPlace}
          depth={depth + 1}
        />
      ) : (
        open &&
        shownChildren?.map((child) => (
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
            ctx.reveal(place.path, cellPlace.path)
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
        marks={hitAt(ctx, cellPlace.path)?.value}
      />
    )
  }
  return (
    <div className="dyn-tree__table-wrap" style={depthStyle(depth)}>
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
                  const cellPath = [...row.path, column]
                  const cellKey = pathKey(cellPath)
                  const changed =
                    member !== undefined &&
                    !treeNode(member).children &&
                    isChanged(ctx, { ...row, path: cellPath }, member)
                  // A cell matches itself, or holds a match inside a map or list it shows.
                  const hit = hitAt(ctx, cellPath)
                  const match = hit !== undefined || ctx.find?.above.has(cellKey)
                  return (
                    <td
                      key={column}
                      data-path={cellKey}
                      data-changed={changed || undefined}
                      data-match={match ? ctx.find?.via : undefined}
                      data-current={(hit && ctx.find?.current === cellKey) || undefined}
                    >
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
  /** The table the item is from; each table has its own find bar. */
  table: string | null
  itemId: string
  /** The item with its pending values applied. */
  item: Item
  schema: KeySchema | null
  edit: PendingItemEdit | undefined
  conflicts: ReadonlySet<PendingAttribute>
  expansion: TreeExpansion
  editable: boolean
  findChoices: FindChoices
}

/**
 * The selected item as a tree: attributes (keys first) that open into their members, with a
 * find bar that highlights or filters what matches.
 */
export function ItemTree(props: ItemTreeProps) {
  const { tabId, table, itemId, item, schema, edit, conflicts, expansion, editable } = props
  const columns = useMemo(
    () => itemColumns([item], schema).filter((c) => item[c.name]),
    [item, schema],
  )
  const names = useMemo(() => columns.map((c) => c.name), [columns])
  const found = useTreeFind({
    tabId,
    table,
    item,
    names,
    edit,
    expansion,
    findChoices: props.findChoices,
  })
  const { bar, barKey, searching, find, count, treeRef } = found
  const filter = find?.filter ?? null
  // Each pending string's JSON is parsed once per edit, not once per leaf on every render.
  const loaded = useMemo(() => loadedJson(edit), [edit])

  const ctx: TreeContext = {
    tabId,
    itemId,
    edit,
    conflicts,
    loaded,
    expansion: found.expansion,
    editable,
    find,
    toggle: found.toggle,
    toggleTable: found.toggleTable,
    reveal: found.reveal,
    setEditing: found.setEditing,
    releaseEditing: found.releaseEditing,
  }
  const shown = filter ? columns.filter((c) => filterShows(filter, [c.name])) : columns

  return (
    <>
      {bar.open && (
        <FindBar
          tabId={tabId}
          barKey={barKey}
          bar={bar}
          choices={props.findChoices}
          count={searching ? count : 0}
          at={found.at}
          via={found.via}
          asText={found.asText}
          capped={found.capped}
          onStep={found.step}
          onClose={() => treeRef.current?.focus()}
        />
      )}
      <div className="dyn-tree__bar">
        <button
          type="button"
          className="q-button q-button--ghost"
          title={searching ? "Opens everything until the search is cleared" : undefined}
          onClick={() => found.setAll(true)}
        >
          <ChevronsUpDown size={12} strokeWidth={2.2} />
          Expand all
        </button>
        <button
          type="button"
          className="q-button q-button--ghost"
          title={
            searching
              ? "Closes everything but the current match until the search is cleared"
              : undefined
          }
          onClick={() => found.setAll(false)}
        >
          <ChevronsDownUp size={12} strokeWidth={2.2} />
          Collapse all
        </button>
        {found.expandDepth !== null && (
          <span
            className="dyn-tree__capped"
            title={`Over ${EXPAND_LIMIT} rows: Expand all opens the first ${found.expandDepth} ${found.expandDepth === 1 ? "level" : "levels"}. Open deeper rows one at a time.`}
          >
            {found.expandDepth} {found.expandDepth === 1 ? "level" : "levels"} opened
          </span>
        )}
        <span className="dyn-side__spacer" />
        {!bar.open && (
          <button
            type="button"
            className="q-button q-button--ghost"
            onClick={() => requestFind(barKey)}
          >
            <Search size={12} strokeWidth={2.2} />
            Find
            <kbd className="q-kbd">{formatShortcut(DYNAMO_SHORTCUTS.find)}</kbd>
          </button>
        )}
      </div>
      <div className="dyn-tree" ref={treeRef} tabIndex={-1} aria-label="Item tree">
        {filter && count === 0 && <p className="dyn-tree__none">No matches</p>}
        {shown.map((column) => (
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
