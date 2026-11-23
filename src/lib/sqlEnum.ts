/**
 * Members of MySQL `ENUM(...)` / `SET(...)` column types, read from `COLUMN_TYPE`
 * (`enum('a','b''c')`), and string literals for inserting them into SQL.
 */

const MEMBER_TYPE = /^\s*(enum|set)\s*\(/i

/** Escape sequences MySQL writes in `COLUMN_TYPE` members; any other escaped character is itself. */
const UNESCAPE: Readonly<Record<string, string>> = { "0": "\0", n: "\n", r: "\r", Z: "\x1a" }

/**
 * The members of an `enum(...)` or `set(...)` column type in declaration order, or null for any
 * other type or a type string that doesn't parse. `information_schema` writes a quote inside a
 * member as `''`, a backslash as `\\` and control characters as `\n`, `\r`, `\0`, `\Z`.
 */
export function enumMembers(typeName: string): string[] | null {
  const head = MEMBER_TYPE.exec(typeName)
  if (!head) return null
  const members: string[] = []
  let i = head[0].length
  for (;;) {
    while (typeName[i] === " ") i += 1
    if (typeName[i] !== "'") return null
    let value = ""
    i += 1
    for (;;) {
      const ch = typeName[i]
      if (ch === undefined) return null
      if (ch === "\\") {
        const escaped = typeName[i + 1]
        if (escaped === undefined) return null
        value += UNESCAPE[escaped] ?? escaped
        i += 2
        continue
      }
      if (ch === "'") {
        if (typeName[i + 1] !== "'") break
        value += "'"
        i += 2
        continue
      }
      value += ch
      i += 1
    }
    members.push(value)
    i += 1
    while (typeName[i] === " ") i += 1
    if (typeName[i] === ")") return members
    if (typeName[i] !== ",") return null
    i += 1
  }
}

/** Whether `typeName` is a `set(...)` type, whose values list several members. */
export function isSetType(typeName: string): boolean {
  return /^\s*set\s*\(/i.test(typeName)
}

/** The body of a SQL string quoted with `quote` for `value`: the quote doubled, `\` escaped. */
export function escapeStringBody(value: string, quote: "'" | '"' = "'"): string {
  return value.replaceAll("\\", "\\\\").replaceAll(quote, quote + quote)
}

/** `value` as a single-quoted SQL string literal (`'it''s'`). */
export function sqlStringLiteral(value: string): string {
  return `'${escapeStringBody(value)}'`
}
