import { ChevronDown, ChevronUp, ListFilter, Search, X } from "lucide-react"
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { asTextQuery, escapeFind, REVEAL_LIMIT, type FindBarState } from "../../lib/dynamoSearch"
import type { FindChoices } from "../../lib/dynamoTabs"
import { formatShortcut, matchesShortcut } from "../../lib/shortcuts"
import { setFindChoices } from "./actions"
import { findBarFocused, setFindBar, useItemFind } from "./findStore"
import { DYNAMO_SHORTCUTS } from "./shortcuts"
import { FIND_BAR_ATTRIBUTE } from "./useFindShortcut"

interface FindBarProps {
  tabId: string
  barKey: string
  bar: FindBarState
  choices: FindChoices
  /** Matching rows, the current one, and whether the query led to rows as a path. */
  count: number
  at: number
  via: "text" | "path"
  /** After a path jump: how many rows the query matches as text. */
  asText: number
  /** Too many matches to open them all; only the current one's rows open. */
  capped: boolean
  onStep: (direction: 1 | -1) => void
  /** Called once the bar closes, to give focus back to the tree. */
  onClose: () => void
}

function Toggle(props: {
  label: string
  title: string
  pressed: boolean
  onChange: (pressed: boolean) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="dyn-find__toggle"
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.title}
      onClick={() => props.onChange(!props.pressed)}
    >
      {props.children}
    </button>
  )
}

/** Find in the item: keys, values or a document path, with the matches stepped through. */
export function FindBar(props: FindBarProps) {
  const { tabId, barKey, bar, choices, count, at, via, asText, capped, onStep, onClose } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const focusBar = useItemFind((s) => s.focusBar)

  // Mod+F focuses the field and selects its query, as a browser's find bar does.
  useEffect(() => {
    if (!focusBar) return
    inputRef.current?.focus()
    inputRef.current?.select()
    findBarFocused()
  }, [focusBar])

  const close = () => {
    setFindBar(barKey, { open: false, query: "" })
    onClose()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Enter while composing Hangul (or any IME text) finishes the syllable, not a search step.
    if (event.nativeEvent.isComposing) return
    if (matchesShortcut(event, DYNAMO_SHORTCUTS.findPrevious)) onStep(-1)
    else if (matchesShortcut(event, DYNAMO_SHORTCUTS.findNext)) onStep(1)
    else if (matchesShortcut(event, DYNAMO_SHORTCUTS.closeEditor)) {
      const next = escapeFind(bar)
      setFindBar(barKey, next)
      if (!next.open) onClose()
    } else return
    event.preventDefault()
    event.stopPropagation()
  }

  const active = bar.query.trim() !== ""
  const status = !active ? "" : count === 0 ? "No matches" : `${at + 1} / ${count}`

  return (
    <div className="dyn-find" role="search">
      <label className="dyn-find__field">
        <Search size={12} strokeWidth={2.2} aria-hidden className="dyn-find__icon" />
        <input
          ref={inputRef}
          {...{ [FIND_BAR_ATTRIBUTE]: "" }}
          className="dyn-find__input mono"
          placeholder="Find keys, values or a path"
          aria-label="Find in item"
          value={bar.query}
          onChange={(event) => setFindBar(barKey, { ...bar, query: event.target.value })}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <span
        className="dyn-find__count"
        aria-live="polite"
        title={
          capped
            ? `Over ${REVEAL_LIMIT} matches: only the current match is opened in the tree`
            : undefined
        }
      >
        {via === "path" && count > 0 && <span className="dyn-type">path</span>}
        {status}
        {capped && <span className="dyn-find__note">current opened</span>}
      </span>
      {via === "path" && count > 0 && asText > 0 && (
        <button
          type="button"
          className="dyn-find__toggle"
          title="Search the query as text instead (wrap it in double quotes)"
          onClick={() => setFindBar(barKey, { ...bar, query: asTextQuery(bar.query) })}
        >
          {asText} as text
        </button>
      )}
      <button
        type="button"
        className="ui-icon-button"
        aria-label="Previous match"
        title={`Previous match (${formatShortcut(DYNAMO_SHORTCUTS.findPrevious)})`}
        disabled={count === 0}
        onClick={() => onStep(-1)}
      >
        <ChevronUp size={13} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="ui-icon-button"
        aria-label="Next match"
        title={`Next match (${formatShortcut(DYNAMO_SHORTCUTS.findNext)})`}
        disabled={count === 0}
        onClick={() => onStep(1)}
      >
        <ChevronDown size={13} strokeWidth={2} />
      </button>
      <span className="dyn-find__toggles">
        <Toggle
          label="Match case"
          title="Match case"
          pressed={choices.caseSensitive}
          onChange={(caseSensitive) => setFindChoices(tabId, { caseSensitive })}
        >
          Aa
        </Toggle>
        <Toggle
          label="Match keys"
          title="Match attribute names and map keys"
          pressed={choices.keys}
          onChange={(keys) => setFindChoices(tabId, { keys })}
        >
          Keys
        </Toggle>
        <Toggle
          label="Match values"
          title="Match values"
          pressed={choices.values}
          onChange={(values) => setFindChoices(tabId, { values })}
        >
          Values
        </Toggle>
        <Toggle
          label="Show only matching rows"
          title="Show only matching rows"
          pressed={choices.mode === "filter"}
          onChange={(filter) => setFindChoices(tabId, { mode: filter ? "filter" : "highlight" })}
        >
          <ListFilter size={12} strokeWidth={2.2} aria-hidden />
        </Toggle>
      </span>
      <button
        type="button"
        className="ui-icon-button"
        aria-label="Close find"
        title={`Close (${formatShortcut(DYNAMO_SHORTCUTS.closeEditor)})`}
        onClick={close}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  )
}
