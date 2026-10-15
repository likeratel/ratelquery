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
