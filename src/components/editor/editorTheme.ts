import { defaultHighlightStyle, HighlightStyle, type TagStyle } from "@codemirror/language"
import { EditorView } from "@codemirror/view"

/**
 * Token colours for syntax highlighting. CodeMirror's default style carries the tag set, so we
 * keep its tags and swap each colour for a design token. Unknown colours fall back to text.
 */
const COLOR_BY_DEFAULT: Record<string, string> = {
  "#708": "var(--accent)",
  "#219": "var(--data-bool)",
  "#164": "var(--data-number)",
  "#a11": "var(--data-json)",
  "#e40": "var(--data-json)",
  "#085": "var(--data-date)",
  "#940": "var(--text-faint)",
  "#404740": "var(--text-muted)",
  "#f00": "var(--danger)",
}

const COMMENT_COLOR = "#940"

function toTokenStyle(spec: TagStyle): TagStyle {
  if (typeof spec.color !== "string") return spec
  const color = COLOR_BY_DEFAULT[spec.color] ?? "var(--text)"
  return spec.color === COMMENT_COLOR ? { ...spec, color, fontStyle: "italic" } : { ...spec, color }
}

export const tokenHighlightStyle = HighlightStyle.define(
  defaultHighlightStyle.specs.map(toTokenStyle),
)

/** Editor chrome driven entirely by CSS variables, so light and dark follow the app theme. */
export const tokenTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--bg)",
    // Set from Settings › Appearance; falls back to the UI size before settings load.
    fontSize: "var(--editor-font-size, var(--text-md))",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontVariantLigatures: "none",
    lineHeight: "1.6",
  },
  ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  // The selection layer sits behind the content, so the active line must stay translucent or it
  // hides the selection on that line (which is every line of a one-line query).
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--surface-hover) 55%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--text-faint)",
    border: "none",
    paddingRight: "4px",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-muted)" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", cursor: "pointer" },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--text)" },
  ".cm-foldPlaceholder": {
    margin: "0 2px",
    padding: "0 4px",
    border: "none",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--accent-soft)",
    color: "var(--text-muted)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 14px", minWidth: "36px" },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--accent-soft)",
    outline: "1px solid var(--accent-ring)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-placeholder": { color: "var(--text-faint)" },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-raised)",
    color: "var(--text)",
    border: "none",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-pop)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    maxHeight: "260px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 10px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--text)",
  },
  ".cm-completionDetail": { color: "var(--text-muted)", fontStyle: "normal", marginLeft: "8px" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent)" },
  // Schema hover (`features/query/completion/hover.ts`).
  ".cm-tooltip-hover": { maxWidth: "440px" },
  ".rq-hover": { padding: "8px 10px", fontSize: "var(--text-sm)", lineHeight: "1.45" },
  ".rq-hover__card + .rq-hover__card": {
    marginTop: "8px",
    paddingTop: "8px",
    borderTop: "1px solid var(--line)",
  },
  ".rq-hover__head": { display: "flex", alignItems: "baseline", gap: "8px" },
  ".rq-hover__title": { fontFamily: "var(--font-mono)", fontWeight: "600" },
  ".rq-hover__badge": { color: "var(--text-faint)", fontSize: "var(--text-xs)" },
  ".rq-hover__location": { color: "var(--text-muted)", fontFamily: "var(--font-mono)" },
  ".rq-hover__type": {
    marginTop: "4px",
    fontFamily: "var(--font-mono)",
    color: "var(--accent)",
    overflowWrap: "anywhere",
  },
  ".rq-hover__facts": { marginTop: "2px", color: "var(--text-muted)" },
  ".rq-hover__comment": { marginTop: "4px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  ".rq-hover__rows": {
    margin: "6px 0 0",
    padding: "0",
    listStyle: "none",
    fontFamily: "var(--font-mono)",
  },
  ".rq-hover__row": { display: "flex", justifyContent: "space-between", gap: "16px" },
  ".rq-hover__row-type": {
    color: "var(--text-muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".rq-hover__key": { marginLeft: "6px", color: "var(--warn)", fontSize: "var(--text-xs)" },
  ".rq-hover__more": { color: "var(--text-faint)" },
  ".cm-panels": { backgroundColor: "var(--bg-sunken)", color: "var(--text)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-searchMatch": {
    backgroundColor: "var(--accent-soft)",
    outline: "1px solid var(--accent-ring)",
  },
  ".cm-textfield": {
    backgroundColor: "var(--surface)",
    border: "1px solid var(--line-strong)",
    borderRadius: "var(--radius-sm)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--surface-raised)",
    border: "1px solid var(--line-strong)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text)",
  },
})
