import { describe, expect, it } from "vitest"
import { findShortcutTarget, type FindFocus, type FindScreen } from "./findShortcut"

const modF = {
  code: "KeyF",
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 70,
  defaultPrevented: false,
}
const nowhere: FindFocus = { editor: false, findBar: false, textField: false }
const tree: FindScreen = { dynamo: true, panel: "tree", modalOpen: false }

const target = (
  focus: Partial<FindFocus> = {},
  screen: Partial<FindScreen> = {},
  event: Partial<typeof modF> = {},
) =>
  findShortcutTarget({ ...modF, ...event }, { ...nowhere, ...focus }, { ...tree, ...screen }, true)

describe("findShortcutTarget", () => {
  it("opens the item find bar wherever focus is while the tree shows", () => {
    expect(target()).toBe("find")
    expect(target({}, { panel: "tree" })).toBe("find")
  })

  it("selects the query when the find bar already has focus", () => {
    expect(target({ findBar: true, textField: true })).toBe("find")
  })

  it("leaves Mod+F to CodeMirror inside an editor", () => {
    expect(target({ editor: true })).toBe("ignore")
    expect(target({ editor: true, textField: true }, { panel: "json" })).toBe("ignore")
    expect(target({}, {}, { defaultPrevented: true })).toBe("ignore")
  })

  it("leaves other text fields alone", () => {
    expect(target({ textField: true })).toBe("ignore")
    expect(target({ textField: true }, { panel: null })).toBe("ignore")
  })

  it("opens the JSON view's search when the panel shows JSON", () => {
    expect(target({}, { panel: "json" })).toBe("json")
  })

  it("focuses the table filter when no item is open", () => {
    expect(target({}, { panel: null })).toBe("tables")
  })

  it("does nothing while the editor or the review shows, outside DynamoDB, or under a dialog", () => {
    expect(target({}, { panel: "other" })).toBe("ignore")
    expect(target({}, { dynamo: false })).toBe("ignore")
    expect(target({}, { modalOpen: true })).toBe("ignore")
  })

  it("matches the physical F key only, with the platform modifier", () => {
    expect(target({}, {}, { isComposing: true })).toBe("ignore")
    // WebKit: the key that ends a composition comes after compositionend, with keyCode 229.
    // Mod+F itself reported as 229 (pressed mid-composition) still opens the find bar.
    expect(target({}, {}, { keyCode: 229 })).toBe("find")
    expect(target({}, {}, { keyCode: 229, isComposing: true })).toBe("ignore")
    expect(target({}, {}, { code: "KeyG" })).toBe("ignore")
    expect(target({}, {}, { shiftKey: true })).toBe("ignore")
    expect(target({}, {}, { metaKey: false, ctrlKey: true })).toBe("ignore")
    expect(
      findShortcutTarget({ ...modF, metaKey: false, ctrlKey: true }, nowhere, tree, false),
    ).toBe("find")
  })
})
