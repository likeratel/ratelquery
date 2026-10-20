import { describe, expect, it } from "vitest"
import {
  canDrop,
  cleanFolderName,
  createFolder,
  deleteFolder,
  EMPTY_LAYOUT,
  FOLDER_NAME_MAX,
  folderOf,
  layoutEntries,
  moveItem,
  moveStep,
  moveToFolder,
  newFolderName,
  normalizeLayout,
  placeAfter,
  reconcileLayout,
  renameFolder,
  setFolderCollapsed,
  type ConnectionLayout,
  type LayoutItem,
} from "./connectionLayout"
import type { ConnectionConfig } from "./connections"

const conn = (id: string, name = id): ConnectionConfig => ({
  kind: "mysql",
  id,
  name,
  host: "localhost",
  port: 3306,
  user: "root",
})

/** Compact layout notation: "a" is a connection, ["F", "b", "c"] a folder F holding b and c. */
type Shape = (string | string[])[]

function layout(shape: Shape): ConnectionLayout {
  const items = shape.map((entry): LayoutItem =>
    typeof entry === "string"
      ? { type: "connection", id: entry }
      : { type: "folder", id: entry[0], children: entry.slice(1) },
  )
  const folders = shape
    .filter((entry): entry is string[] => typeof entry !== "string")
    .map(([id]) => ({ id, name: `Folder ${id}`, collapsed: false }))
  return { version: 1, folders, items }
}

const shapeOf = (l: ConnectionLayout): Shape =>
  l.items.map((item) => (item.type === "connection" ? item.id : [item.id, ...item.children]))

const c = (id: string) => ({ type: "connection", id }) as const
const f = (id: string) => ({ type: "folder", id }) as const

describe("normalizeLayout", () => {
  it("keeps a valid layout", () => {
    const valid = layout(["a", ["F", "b"]])
    expect(normalizeLayout(valid)).toEqual(valid)
  })

  it("is null for anything but a version 1 layout", () => {
    for (const bad of [null, "x", [], { version: 2, folders: [], items: [] }, { version: 1 }]) {
      expect(normalizeLayout(bad)).toBeNull()
    }
  })

  it("drops entries that don't parse", () => {
    const raw = {
      version: 1,
      folders: [{ id: "F", name: "Prod", collapsed: "yes" }, { id: "", name: "x" }, 5],
      items: [
        { type: "connection", id: "a" },
        { type: "folder", id: "F", children: ["b", 3, ""] },
        { type: "group", id: "g" },
        { type: "connection" },
      ],
    }
    expect(normalizeLayout(raw)).toEqual({
      version: 1,
      folders: [{ id: "F", name: "Prod", collapsed: false }],
      items: [
        { type: "connection", id: "a" },
        { type: "folder", id: "F", children: ["b"] },
      ],
    })
  })
})

describe("reconcileLayout", () => {
  it("appends unplaced connections at the top level in name order", () => {
    const connections = [conn("b", "beta"), conn("a", "Alpha"), conn("x", "Xeno"), conn("m", "m")]
    const result = reconcileLayout(layout([["F", "x"]]), connections)
    expect(shapeOf(result)).toEqual([["F", "x"], "a", "b", "m"])
  })

  it("starts from name order without a saved layout", () => {
    const result = reconcileLayout(EMPTY_LAYOUT, [conn("b", "B"), conn("a", "a")])
    expect(shapeOf(result)).toEqual(["a", "b"])
  })

  it("drops deleted ids and repeats, and keeps empty folders", () => {
    const saved = layout(["gone", "a", ["F", "a", "b", "gone"], ["E"], "b", ["F"]])
    const result = reconcileLayout(saved, [conn("a"), conn("b")])
    expect(shapeOf(result)).toEqual(["a", ["F", "b"], ["E"]])
    expect(result.folders.map((x) => x.id)).toEqual(["F", "E"])
  })

  it("fixes folders and folder items that miss their counterpart", () => {
    const saved: ConnectionLayout = {
      version: 1,
      folders: [
        { id: "F", name: "kept", collapsed: true },
        { id: "F", name: "repeat", collapsed: false },
        { id: "lonely", name: "no item", collapsed: false },
      ],
      items: [{ type: "folder", id: "ghost", children: ["a"] }, ...layout([["F", "b"]]).items],
    }
    const result = reconcileLayout(saved, [conn("a"), conn("b")])
    expect(shapeOf(result)).toEqual([["F", "b"], ["lonely"], "a"])
    expect(result.folders).toEqual([saved.folders[0], saved.folders[2]])
  })
})

describe("moveItem", () => {
  const base = layout(["a", "b", ["F", "c", "d"], "e"])

  it("reorders top-level connections", () => {
    expect(shapeOf(moveItem(base, c("e"), c("a"), "before"))).toEqual([
      "e",
      "a",
      "b",
      ["F", "c", "d"],
    ])
    expect(shapeOf(moveItem(base, c("a"), c("b"), "after"))).toEqual([
      "b",
      "a",
      ["F", "c", "d"],
      "e",
    ])
  })

  it("moves a connection into a folder, next to a child or at the end", () => {
    expect(shapeOf(moveItem(base, c("a"), c("d"), "before"))).toEqual([
      "b",
      ["F", "c", "a", "d"],
      "e",
    ])
    expect(shapeOf(moveItem(base, c("e"), f("F"), "inside"))).toEqual([
      "a",
      "b",
      ["F", "c", "d", "e"],
    ])
  })

  it("moves a connection out of a folder", () => {
    expect(shapeOf(moveItem(base, c("c"), f("F"), "before"))).toEqual([
      "a",
      "b",
      "c",
      ["F", "d"],
      "e",
    ])
    expect(shapeOf(moveItem(base, c("d"), c("a"), "after"))).toEqual([
      "a",
      "d",
      "b",
      ["F", "c"],
      "e",
    ])
  })

  it("moves folders among top-level items only", () => {
    expect(shapeOf(moveItem(base, f("F"), c("a"), "before"))).toEqual([
      ["F", "c", "d"],
      "a",
      "b",
      "e",
    ])
    // A target inside the folder stands for the folder itself.
    const two = layout([
      ["F", "c"],
      ["G", "x"],
    ])
    expect(shapeOf(moveItem(two, f("F"), c("x"), "after"))).toEqual([
      ["G", "x"],
      ["F", "c"],
    ])
  })

  it("leaves the layout alone for moves that make no sense", () => {
    expect(moveItem(base, f("F"), f("F"), "inside")).toBe(base)
    expect(moveItem(base, f("F"), c("c"), "before")).toBe(base)
    expect(moveItem(base, c("a"), c("b"), "inside")).toBe(base)
    expect(moveItem(base, c("a"), c("a"), "after")).toBe(base)
    expect(moveItem(base, c("zz"), c("a"), "after")).toBe(base)
    expect(moveItem(base, c("a"), f("nope"), "inside")).toBe(base)
  })
})

describe("canDrop", () => {
  const base = layout(["a", "b", ["F", "c"]])

  it("is true only where the drop changes the order", () => {
    expect(canDrop(base, c("a"), c("b"), "after")).toBe(true)
    expect(canDrop(base, c("a"), c("b"), "before")).toBe(false)
    expect(canDrop(base, c("a"), f("F"), "inside")).toBe(true)
    expect(canDrop(base, c("c"), f("F"), "inside")).toBe(false)
    expect(canDrop(base, f("F"), c("a"), "before")).toBe(true)
    expect(canDrop(base, f("F"), f("F"), "after")).toBe(false)
    expect(canDrop(base, f("F"), c("c"), "after")).toBe(false)
  })
})

describe("moveStep", () => {
  const base = layout(["a", ["F", "b", "c"], "d"])

  it("swaps with the neighbour among top-level items", () => {
    expect(shapeOf(moveStep(base, c("a"), 1))).toEqual([["F", "b", "c"], "a", "d"])
    expect(shapeOf(moveStep(base, f("F"), -1))).toEqual([["F", "b", "c"], "a", "d"])
  })

  it("moves within a folder and steps out at its edges", () => {
    expect(shapeOf(moveStep(base, c("b"), 1))).toEqual(["a", ["F", "c", "b"], "d"])
    expect(shapeOf(moveStep(base, c("b"), -1))).toEqual(["a", "b", ["F", "c"], "d"])
    expect(shapeOf(moveStep(base, c("c"), 1))).toEqual(["a", ["F", "b"], "c", "d"])
  })

  it("returns the same layout at the top-level edges", () => {
    expect(moveStep(base, c("a"), -1)).toBe(base)
    expect(moveStep(base, c("d"), 1)).toBe(base)
    expect(moveStep(layout([["F"], "a"]), f("F"), -1).items).toEqual(layout([["F"], "a"]).items)
    expect(moveStep(base, c("missing"), 1)).toBe(base)
  })
})

describe("moveToFolder", () => {
  const base = layout(["a", ["F", "b"], ["G"]])

  it("appends to a folder, or goes back to the top level after its folder", () => {
    expect(shapeOf(moveToFolder(base, "a", "F"))).toEqual([["F", "b", "a"], ["G"]])
    expect(shapeOf(moveToFolder(base, "b", "G"))).toEqual(["a", ["F"], ["G", "b"]])
    expect(shapeOf(moveToFolder(base, "b", null))).toEqual(["a", ["F"], "b", ["G"]])
  })

  it("returns the same layout when it is already there", () => {
    expect(moveToFolder(base, "a", null)).toBe(base)
    expect(moveToFolder(base, "b", "F")).toBe(base)
  })

  it("tells which folder holds a connection", () => {
    expect(folderOf(base, "b")).toBe("F")
    expect(folderOf(base, "a")).toBeNull()
  })
})

describe("placeAfter", () => {
  it("puts a duplicate right after its source, in the same folder", () => {
    expect(shapeOf(placeAfter(layout(["a", ["F", "b", "c"], "copy"]), "copy", "b"))).toEqual([
      "a",
      ["F", "b", "copy", "c"],
    ])
    expect(shapeOf(placeAfter(layout(["a", "b"]), "copy", "a"))).toEqual(["a", "copy", "b"])
  })

  it("appends when the source is not placed", () => {
    expect(shapeOf(placeAfter(layout(["a"]), "copy", "gone"))).toEqual(["a", "copy"])
  })
})

describe("folders", () => {
  it("creates an expanded empty folder at the end with a free name", () => {
    const first = createFolder(layout(["a"]), "F", "")
    expect(shapeOf(first)).toEqual(["a", ["F"]])
    expect(first.folders).toEqual([{ id: "F", name: "New folder", collapsed: false }])
    expect(newFolderName(first)).toBe("New folder 2")
    expect(createFolder(first, "F", "again")).toBe(first)
  })

  it("renames with a trimmed name and ignores blank ones", () => {
    const base = layout([["F"]])
    expect(renameFolder(base, "F", "  Prod  ").folders[0].name).toBe("Prod")
    expect(renameFolder(base, "F", "   ")).toBe(base)
    expect(renameFolder(base, "nope", "x")).toBe(base)
    expect(cleanFolderName("x".repeat(FOLDER_NAME_MAX + 5))).toHaveLength(FOLDER_NAME_MAX)
  })

  it("collapses and expands", () => {
    const collapsed = setFolderCollapsed(layout([["F"]]), "F", true)
    expect(collapsed.folders[0].collapsed).toBe(true)
    expect(setFolderCollapsed(collapsed, "F", false).folders[0].collapsed).toBe(false)
  })

  it("deletes a folder and puts its connections in its place", () => {
    const result = deleteFolder(layout(["a", ["F", "b", "c"], "d"]), "F")
    expect(shapeOf(result)).toEqual(["a", "b", "c", "d"])
    expect(result.folders).toEqual([])
  })
})

describe("layoutEntries", () => {
  const connections = [conn("a", "alpha"), conn("b", "beta"), conn("c", "gamma")]
  const base = layout(["a", ["F", "b"], ["E"], ["G", "c"]])

  it("lists top-level connections and folders with their connections", () => {
    const entries = layoutEntries(base, connections)
    expect(entries.map((e) => (e.type === "folder" ? e.folder.id : e.config.id))).toEqual([
      "a",
      "F",
      "E",
      "G",
    ])
    const folder = entries[1]
    expect(folder.type === "folder" && folder.connections.map((x) => x.id)).toEqual(["b"])
  })

  it("keeps only matches and the folders that hold them while filtering", () => {
    const entries = layoutEntries(base, connections, (config) => config.name.includes("ta"))
    expect(entries.map((e) => (e.type === "folder" ? e.folder.id : e.config.id))).toEqual(["F"])
  })
})
