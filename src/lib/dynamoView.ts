import type { AttributeValue, Item, KeySchema } from "./dynamo"
import { attributeTag, wireToPlain } from "./dynamoJson"
import type { Cell, ColumnInfo } from "./mysql"

export type KeyRole = "partition" | "sort" | null

export interface ItemColumn {
  name: string
  /** Distinct type tags seen in this column, in first-seen order. */
  types: readonly string[]
  key: KeyRole
}

function keyRole(name: string, schema: KeySchema | null): KeyRole {
  if (schema?.hash.name === name) return "partition"
  if (schema?.range?.name === name) return "sort"
  return null
}

/**
 * Union of top-level attribute names across items. The table's partition and sort keys come
 * first (even when absent from this page), then the rest in first-seen order.
 */
export function itemColumns(items: readonly Item[], schema: KeySchema | null): ItemColumn[] {
  const keyNames = schema ? [schema.hash.name, ...(schema.range ? [schema.range.name] : [])] : []
  const types = new Map<string, string[]>(keyNames.map((name) => [name, []]))
  for (const item of items) {
    for (const [name, value] of Object.entries(item)) {
      const tag = attributeTag(value) ?? "?"
      const seen = types.get(name)
      if (!seen) types.set(name, [tag])
      else if (!seen.includes(tag)) types.set(name, [...seen, tag])
    }
  }
  return [...types.entries()].map(([name, seen]) => ({
    name,
    types: seen,
    key: keyRole(name, schema),
  }))
}

export function columnTypeLabel(column: ItemColumn): string {
  const types = column.types.length > 0 ? column.types.join(" | ") : "–"
  return column.key ? `${types} · ${column.key} key` : types
}

/** Grid header metadata; the grid shows `typeName` under the name. */
export function columnInfos(columns: readonly ItemColumn[]): ColumnInfo[] {
  return columns.map((column) => ({
    name: column.name,
    typeName: columnTypeLabel(column),
    table: null,
    nullable: column.key === null,
  }))
}

/** Maps a wire attribute onto the grid's tagged cell so the existing tones apply. */
export function attributeToCell(value: AttributeValue): Cell {
  const tag = attributeTag(value)
  switch (tag) {
    case "S":
      return { t: "str", v: String(value.S) }
    case "N":
      return { t: "decimal", v: String(value.N) }
    case "B":
      return { t: "bytes", v: String(value.B) }
    case "BOOL":
      return { t: "bool", v: Boolean(value.BOOL) }
    case "NULL":
      return { t: "null" }
    case null:
      return { t: "json", v: JSON.stringify(value) }
    default:
      return { t: "json", v: JSON.stringify(wireToPlain(value)) }
  }
}

/** Cells for one item; `undefined` where the item lacks the attribute. */
export function itemCells(item: Item, columns: readonly ItemColumn[]): (Cell | undefined)[] {
  return columns.map((column) => {
    const value = item[column.name]
    return value ? attributeToCell(value) : undefined
  })
}

/** Compact one-line text for a wire attribute, used in diff and detail lists. */
export function attributeSummary(value: AttributeValue): string {
  const tag = attributeTag(value)
  if (tag === "S") return JSON.stringify(value.S)
  if (tag === "SS" || tag === "NS" || tag === "BS") {
    return `${tag} ${JSON.stringify(value[tag])}`
  }
  return JSON.stringify(tag ? wireToPlain(value) : value)
}
