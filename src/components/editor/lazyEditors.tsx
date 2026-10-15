import { lazy, Suspense } from "react"
import type { JsonEditorProps } from "./JsonEditor"
import type { SqlEditorProps } from "./SqlEditor"

/**
 * CodeMirror lives in its own chunks, loaded the first time an editor shows. Until then the
 * editor area stays empty at its normal size.
 */
const SqlEditorChunk = lazy(() => import("./SqlEditor").then((m) => ({ default: m.SqlEditor })))
const JsonEditorChunk = lazy(() => import("./JsonEditor").then((m) => ({ default: m.JsonEditor })))

export function SqlEditor(props: SqlEditorProps) {
  return (
    <Suspense fallback={<div className="sql-editor" aria-busy="true" />}>
      <SqlEditorChunk {...props} />
    </Suspense>
  )
}

export function JsonEditor(props: JsonEditorProps) {
  return (
    <Suspense fallback={<div className="sql-editor json-editor" aria-busy="true" />}>
      <JsonEditorChunk {...props} />
    </Suspense>
  )
}
