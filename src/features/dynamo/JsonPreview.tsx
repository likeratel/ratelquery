import { useMemo } from "react"
import { tokenizeJson } from "../../lib/jsonTokens"

/** Read-only, token-coloured JSON text. */
export function JsonPreview({ text, className }: { text: string; className?: string }) {
  const tokens = useMemo(() => tokenizeJson(text), [text])
  return (
    <pre className={["dyn-json", className].filter(Boolean).join(" ")}>
      {tokens.map((token, i) => (
        <span key={i} data-token={token.kind}>
          {token.text}
        </span>
      ))}
    </pre>
  )
}
