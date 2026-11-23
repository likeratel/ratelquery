/**
 * Completion options for the members of a compared ENUM / SET column: `col = |` offers
 * `'SMISHING'` as a whole literal, and inside a literal (`col = 'SM|'`) the bare member, quoted
 * to fit that literal.
 */

import type { Completion } from "@codemirror/autocomplete"
import { enumMembers, escapeStringBody, sqlStringLiteral } from "../../../lib/sqlEnum"
import { BOOST } from "./catalog"
import type { ResolvedColumn } from "./resolve"

function detailOf({ table, column }: ResolvedColumn): string {
  return `${column.name} · ${table.name}`
}

/** Keeps members in declaration order among equally ranked options (instead of by label). */
const declarationOrder = (index: number) => `\u0000${String(index).padStart(5, "0")}`

/**
 * Members as string literals, for an operand position (`col = |`). The label is the bare member
 * so typing `SM` matches `SMISHING` from its first letter; the list shows and inserts the literal.
 */
export function memberLiteralOptions(resolved: ResolvedColumn): Completion[] {
  const detail = detailOf(resolved)
  return (enumMembers(resolved.column.typeName) ?? []).map((member, index) => ({
    label: member,
    displayLabel: sqlStringLiteral(member),
    apply: sqlStringLiteral(member),
    sortText: declarationOrder(index),
    type: "enum",
    detail,
    boost: BOOST.value,
  }))
}

/**
 * Members as the body of a literal quoted with `quote`; the closing quote is added when the
 * literal has none yet. The empty member has no label to show here and is left out.
 */
export function memberValueOptions(
  resolved: ResolvedColumn,
  quote: "'" | '"',
  closed: boolean,
): Completion[] {
  const detail = detailOf(resolved)
  return (enumMembers(resolved.column.typeName) ?? [])
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => member !== "")
    .map(({ member, index }) => ({
      label: member,
      sortText: declarationOrder(index),
      apply: escapeStringBody(member, quote) + (closed ? "" : quote),
      type: "enum",
      detail,
      boost: BOOST.value,
    }))
}
