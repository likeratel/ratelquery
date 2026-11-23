/**
 * Hover tooltips over names in the SQL editor: a column's type, nullability, key, default and
 * comment; a table's columns; a database's table count. Reads the same schema cache as
 * completion and waits for a schema it needs that isn't loaded yet.
 */

import type { Extension } from "@codemirror/state"
import { hoverTooltip, type EditorView, type Tooltip } from "@codemirror/view"
import { MYSQL_DIALECT } from "../../../lib/sqlDialect"
import { identifierAt, type IdentifierAt } from "../../../lib/sqlScope"
import { hoverCards, hoverTarget, type HoverCard } from "./hoverCard"
import { createLookup } from "./resolve"
import type { CompletionEnv } from "./source"

/** Pointer rest before the tooltip opens, in milliseconds (CodeMirror's default is 300). */
const HOVER_DELAY_MS = 350

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  // Schema text (comments, defaults) is data: always set as text, never as HTML.
  if (text !== undefined) node.textContent = text
  return node
}

function renderRows(card: HoverCard): HTMLElement | null {
  if (!card.rows || card.rows.length === 0) return null
  const list = element("ul", "rq-hover__rows")
  for (const row of card.rows) {
    const item = element("li", "rq-hover__row")
    const name = element("span", "rq-hover__row-name", row.name)
    if (row.primary) name.append(element("span", "rq-hover__key", "PK"))
    item.append(name, element("span", "rq-hover__row-type", row.type))
    list.append(item)
  }
  if (card.more) list.append(element("li", "rq-hover__more", `+${card.more} more`))
  return list
}

function renderCard(card: HoverCard): HTMLElement {
  const section = element("section", "rq-hover__card")
  const head = element("div", "rq-hover__head")
  head.append(
    element("span", "rq-hover__title", card.title),
    element("span", "rq-hover__badge", card.badge),
  )
  section.append(head)
  if (card.location) section.append(element("div", "rq-hover__location", card.location))
  if (card.type) section.append(element("div", "rq-hover__type", card.type))
  if (card.facts.length > 0) {
    section.append(element("div", "rq-hover__facts", card.facts.join(" · ")))
  }
  if (card.comment) section.append(element("div", "rq-hover__comment", card.comment))
  const rows = renderRows(card)
  if (rows) section.append(rows)
  return section
}

function renderCards(cards: readonly HoverCard[]): HTMLElement {
  const dom = element("div", "rq-hover")
  dom.append(...cards.map(renderCard))
  return dom
}

/** Cards for `id`, and the loads of schemas it needed that weren't cached. */
function lookupCards(id: IdentifierAt, env: CompletionEnv) {
  const missing = new Set<string>()
  const lookup = createLookup(env.catalog(), env.dialect ?? MYSQL_DIALECT, missing)
  const target = hoverTarget(id, lookup)
  const loads = [...missing]
    .map((database) => env.requestSchema(database))
    .filter((load): load is Promise<void> => load !== null)
  return { cards: target ? hoverCards(target) : [], loads }
}

async function tooltipAt(
  view: EditorView,
  pos: number,
  side: -1 | 1,
  env: CompletionEnv,
): Promise<Tooltip | null> {
  const doc = view.state.doc
  const syntax = (env.dialect ?? MYSQL_DIALECT).syntax
  const id = identifierAt(doc.toString(), pos, side, syntax)
  if (!id) return null
  let { cards, loads } = lookupCards(id, env)
  if (loads.length > 0) {
    await Promise.all(loads)
    // The text moved on while the schema loaded: the name may be somewhere else now.
    if (view.state.doc !== doc) return null
    cards = lookupCards(id, env).cards
  }
  if (cards.length === 0) return null
  return { pos: id.from, end: id.to, above: true, create: () => ({ dom: renderCards(cards) }) }
}

/** The hover tooltip extension for an editor whose names resolve through `env`. */
export function schemaHover(env: CompletionEnv): Extension {
  return hoverTooltip((view, pos, side) => tooltipAt(view, pos, side, env), {
    hoverTime: HOVER_DELAY_MS,
  })
}
