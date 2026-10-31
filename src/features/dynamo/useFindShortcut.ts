import { useEffect } from "react"
import { isModalOpen } from "../../components/ui"
import { selectedItem, type DynamoTab } from "../../lib/dynamoTabs"
import { findShortcutTarget, type FindFocus, type FindScreen } from "../../lib/findShortcut"
import { selectActiveTab, useTabsStore } from "../../state/tabsStore"
import { findBarKey, requestFind, requestJsonSearch } from "./findStore"

/** Marks the find bar's field, so Mod+F there selects its text rather than leaving it be. */
export const FIND_BAR_ATTRIBUTE = "data-item-find"

const TEXT_FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])"

function focusOf(target: EventTarget | null): FindFocus {
  const element = target instanceof Element ? target : null
  return {
    editor: element?.closest(".cm-editor") != null,
    findBar: element?.closest(`[${FIND_BAR_ATTRIBUTE}]`) != null,
    textField: element?.closest(TEXT_FIELD) != null,
  }
}

function panelOf(tab: DynamoTab): FindScreen["panel"] {
  if (!tab.table) return null
  if (tab.editor) return "other"
  if (tab.view !== "table" || !selectedItem(tab)) return null
  return tab.panel.reviewing ? "other" : tab.panel.view
}

/**
 * Mod+F while a DynamoDB tab is active, wherever focus is, like Cmd+F in a browser: the item
 * panel's find bar (or its JSON search), else the table filter. CodeMirror editors keep their
 * own search, and other text fields keep the key.
 */
export function useFindShortcut(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const active = selectActiveTab(useTabsStore.getState())
      const tab = active?.kind === "dynamo" ? active : null
      const screen: FindScreen = {
        dynamo: tab !== null,
        panel: tab ? panelOf(tab) : null,
        modalOpen: isModalOpen(),
      }
      const target = findShortcutTarget(event, focusOf(event.target), screen)
      if (target === "ignore" || !tab) return
      event.preventDefault()
      if (target === "find") requestFind(findBarKey(tab.id, tab.table))
      else if (target === "json") requestJsonSearch()
      else {
        const filter = document.querySelector<HTMLInputElement>(".dyn-tables__search")
        filter?.focus()
        filter?.select()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
