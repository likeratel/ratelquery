import { beforeEach, describe, expect, it } from "vitest"
import { INITIAL_TABS } from "../lib/queryTabs"
import { useTabsStore } from "./tabsStore"
import { useTrashStore } from "./trashStore"
import { useUiStore } from "./uiStore"

beforeEach(() => {
  useTabsStore.setState({ ...INITIAL_TABS })
  useUiStore.setState({ trashOpen: false })
})

describe("tabs and the Trash panel", () => {
  it("opening or picking a tab closes the Trash", () => {
    const first = useTabsStore.getState().open("c1", "app")
    useUiStore.getState().openTrash()
    useTrashStore.setState({ selectedId: "entry" })
    useTabsStore.getState().activate(first)
    expect(useUiStore.getState().trashOpen).toBe(false)
    expect(useTrashStore.getState().selectedId).toBeNull()

    useUiStore.getState().openTrash()
    useTabsStore.getState().open("c1", "app")
    expect(useUiStore.getState().trashOpen).toBe(false)

    useUiStore.getState().openTrash()
    useTabsStore.getState().activateTabSlot(1)
    expect(useUiStore.getState().trashOpen).toBe(false)

    useUiStore.getState().openTrash()
    useTabsStore.getState().openTable("c1", "app", "users")
    expect(useUiStore.getState().trashOpen).toBe(false)
  })

  it("typing in a tab doesn't touch the Trash", () => {
    const id = useTabsStore.getState().open("c1", "app")
    useUiStore.getState().openTrash()
    useTabsStore.getState().setSql(id, "SELECT 1")
    expect(useUiStore.getState().trashOpen).toBe(true)
  })
})
