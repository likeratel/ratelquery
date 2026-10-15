/** Token kinds for colouring formatted JSON; map to the `--data-*` tokens. */
export type JsonTokenKind = "key" | "string" | "number" | "bool" | "null" | "punct"

export interface JsonToken {
  kind: JsonTokenKind
  text: string
}

const TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g

/** Splits formatted JSON into coloured runs. Text between tokens is kept as `punct`. */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = []
  let last = 0
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0
    if (start > last) tokens.push({ kind: "punct", text: text.slice(last, start) })
    const [whole, quoted, colon] = match
    if (quoted !== undefined) {
      tokens.push({ kind: colon ? "key" : "string", text: quoted })
      if (colon) tokens.push({ kind: "punct", text: colon })
    } else if (whole === "true" || whole === "false") {
      tokens.push({ kind: "bool", text: whole })
    } else if (whole === "null") {
      tokens.push({ kind: "null", text: whole })
    } else {
      tokens.push({ kind: "number", text: whole })
    }
    last = start + whole.length
  }
  if (last < text.length) tokens.push({ kind: "punct", text: text.slice(last) })
  return tokens
}
