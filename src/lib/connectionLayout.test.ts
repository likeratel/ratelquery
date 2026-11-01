import { describe, expect, it } from "vitest"
import {
  canDrop,
  cleanFolderName,
  createFolder,
  deleteFolder,
  EMPTY_LAYOUT,
  FOLDER_NAME_MAX,
  folderPaths,
  layoutEntries,
  MAX_FOLDER_DEPTH,
  moveItem,
  moveStep,
  moveTargets,
  moveToFolder,
  newFolderName,
  normalizeLayout,
  placeAfter,
  reconcileLayout,
  renameFolder,
  setFolderCollapsed,
  type ConnectionLayout,
  type LayoutEntry,
  type LayoutItem,
  type LayoutRef,
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

/**
 * Compact layout notation: "a" is a connection, ["F", "b", ["G", "c"]] a folder F holding b and
 * a folder G that holds c.
 */
type Shape = (string | Shape)[]

const folderIds = (shape: Shape): string[] =>
  shape.flatMap((entry) =>
    typeof entry === "string" ? [] : [entry[0] as string, ...folderIds(entry.slice(1))],
  )

const toItems = (shape: Shape): LayoutItem[] =>
  shape.map((entry): LayoutItem =>
    typeof entry === "string"
      ? { type: "connection", id: entry }
      : { type: "folder", id: entry[0] as string, children: toItems(entry.slice(1)) },
  )

function layout(shape: Shape): ConnectionLayout {
  const folders = folderIds(shape).map((id) => ({ id, name: `Folder ${id}`, collapsed: false }))
  return { version: 2, folders, items: toItems(shape) }
}

const toShape = (items: readonly LayoutItem[]): Shape =>
  items.map((item) => (item.type === "connection" ? item.id : [item.id, ...toShape(item.children)]))

const shapeOf = (l: ConnectionLayout): Shape => toShape(l.items)

/** `depth` nested folders D1, D2, …, the deepest holding `inner`. */
const chain = (depth: number, inner: Shape = [], from = 1): Shape =>
  from > depth ? inner : [[`D${from}`, ...chain(depth, inner, from + 1)]]

const c = (id: string) => ({ type: "connection", id }) as const
const f = (id: string) => ({ type: "folder", id }) as const

describe("normalizeLayout", () => {
  it("keeps a valid layout", () => {
    const valid = layout(["a", ["F", "b", ["G", ["H", "c"]]]])
    expect(normalizeLayout(valid)).toEqual(valid)
  })

  it("reads a version 1 layout as the same tree", () => {
    const v1 = {
      version: 1,
      folders: [{ id: "F", name: "Prod", collapsed: true }],
      items: [
        { type: "folder", id: "F", children: ["b", 3, ""] },
        { type: "connection", id: "a" },
      ],
    }
    expect(normalizeLayout(v1)).toEqual({
      version: 2,
      folders: [{ id: "F", name: "Prod", collapsed: true }],
      items: [
        { type: "folder", id: "F", children: [{ type: "connection", id: "b" }] },
        { type: "connection", id: "a" },
      ],
    })
  })

  it("is null for anything but a version 1 or 2 layout", () => {
    for (const bad of [null, "x", [], { version: 3, folders: [], items: [] }, { version: 2 }]) {
      expect(normalizeLayout(bad)).toBeNull()
    }
  })

  it("drops entries that don't parse", () => {
    const raw = {
      version: 2,
      folders: [{ id: "F", name: "Prod", collapsed: "yes" }, { id: "", name: "x" }, 5],
      items: [
        { type: "connection", id: "a" },
        {
          type: "folder",
          id: "F",
          children: ["b", { type: "connection", id: "c" }, { type: "folder", id: "G" }],
        },
        { type: "group", id: "g" },
        { type: "connection" },
      ],
    }
    expect(normalizeLayout(raw)).toEqual({
      version: 2,
      folders: [{ id: "F", name: "Prod", collapsed: false }],
      items: [
        { type: "connection", id: "a" },
        { type: "folder", id: "F", children: [{ type: "connection", id: "c" }] },
      ],
    })
  })

  it("flattens what lies below the deepest allowed folder into it", () => {
    const deep = layout(chain(MAX_FOLDER_DEPTH + 1, ["b", ["X", "a"], "c"]))
    const result = normalizeLayout(deep)
    expect(result && shapeOf(result)).toEqual(chain(MAX_FOLDER_DEPTH, ["b", "a", "c"]))
    // The connections stay where they were read; the dropped folders come back empty on top.
    const reconciled = reconcileLayout(result ?? EMPTY_LAYOUT, [conn("a"), conn("b"), conn("c")])
    expect(shapeOf(reconciled)).toEqual([
      ...chain(MAX_FOLDER_DEPTH, ["b", "a", "c"]),
      [`D${MAX_FOLDER_DEPTH + 1}`],
      ["X"],
    ])
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

  it("drops deleted ids and repeats at any depth, and keeps empty folders", () => {
    const saved = layout(["gone", "a", ["F", "a", ["G", "b", "gone"]], ["E"], "b"])
    const result = reconcileLayout(
      { ...saved, items: [...saved.items, { type: "folder", id: "G", children: [] }] },
      [conn("a"), conn("b")],
    )
    expect(shapeOf(result)).toEqual(["a", ["F", ["G", "b"]], ["E"]])
    expect(result.folders.map((x) => x.id)).toEqual(["F", "G", "E"])
  })

  it("fixes folders and folder items that miss their counterpart", () => {
    const saved: ConnectionLayout = {
      version: 2,
      folders: [
        { id: "F", name: "kept", collapsed: true },
        { id: "F", name: "repeat", collapsed: false },
        { id: "lonely", name: "no item", collapsed: false },
      ],
      items: [{ type: "folder", id: "ghost", children: [c("a")] }, ...layout([["F", "b"]]).items],
    }
    const result = reconcileLayout(saved, [conn("a"), conn("b")])
    expect(shapeOf(result)).toEqual(["a", ["F", "b"], ["lonely"]])
    expect(result.folders).toEqual([saved.folders[0], saved.folders[2]])
  })

  it("puts what a missing or repeated folder holds in its place", () => {
    const saved = layout([
      ["F", "a"],
      ["G", ["F", "b", ["H", "c"]], "d"],
    ])
    const result = reconcileLayout(
      { ...saved, folders: saved.folders.filter((x) => x.id !== "H") },
      ["a", "b", "c", "d"].map((id) => conn(id)),
    )
    expect(shapeOf(result)).toEqual([
      ["F", "a"],
      ["G", "b", "c", "d"],
    ])
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

  it("moves folders next to and into other items at any depth", () => {
    expect(shapeOf(moveItem(base, f("F"), c("a"), "before"))).toEqual([
      ["F", "c", "d"],
      "a",
      "b",
      "e",
    ])
    const tree = layout([["F", "c"], ["G", "x", ["H", "y"]], "z"])
    expect(shapeOf(moveItem(tree, f("F"), c("y"), "after"))).toEqual([
      ["G", "x", ["H", "y", ["F", "c"]]],
      "z",
    ])
    expect(shapeOf(moveItem(tree, f("F"), f("H"), "inside"))).toEqual([
      ["G", "x", ["H", "y", ["F", "c"]]],
      "z",
    ])
    expect(shapeOf(moveItem(tree, f("H"), c("z"), "after"))).toEqual([
      ["F", "c"],
      ["G", "x"],
      "z",
      ["H", "y"],
    ])
    expect(shapeOf(moveItem(tree, c("z"), c("y"), "before"))).toEqual([
      ["F", "c"],
      ["G", "x", ["H", "z", "y"]],
    ])
  })

  it("never puts a folder inside itself or one of its subfolders", () => {
    const tree = layout([["F", "a", ["G", "b", ["H"]]]])
    expect(moveItem(tree, f("F"), f("G"), "inside")).toBe(tree)
    expect(moveItem(tree, f("F"), f("H"), "inside")).toBe(tree)
    expect(moveItem(tree, f("F"), c("b"), "after")).toBe(tree)
    expect(moveItem(tree, f("G"), f("G"), "inside")).toBe(tree)
  })

  it("refuses moves that nest folders deeper than the limit", () => {
    const base = layout([...chain(MAX_FOLDER_DEPTH - 1), ["P", ["Q"]], "z"])
    const last = `D${MAX_FOLDER_DEPTH - 1}`
    expect(moveItem(base, f("P"), f(last), "inside")).toBe(base)
    expect(canDrop(base, f("P"), f(last), "inside")).toBe(false)
    expect(moveItem(base, f("Q"), f(last), "inside")).not.toBe(base)
    expect(moveItem(base, c("z"), f(last), "inside")).not.toBe(base)
    expect(moveItem(base, f("P"), f(`D${MAX_FOLDER_DEPTH - 2}`), "inside")).not.toBe(base)
    // Next to a connection in the deepest folder, P and its subfolder Q would be 32 and 33 deep.
    const deep = moveItem(base, c("z"), f(last), "inside")
    expect(moveItem(deep, f("P"), c("z"), "after")).toBe(deep)
    expect(moveItem(deep, f("Q"), c("z"), "after")).not.toBe(deep)
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
  const base = layout(["a", "b", ["F", "c", ["G"]]])

  it("is true only where the drop changes the order", () => {
    expect(canDrop(base, c("a"), c("b"), "after")).toBe(true)
    expect(canDrop(base, c("a"), c("b"), "before")).toBe(false)
    expect(canDrop(base, c("a"), f("F"), "inside")).toBe(true)
    expect(canDrop(base, c("a"), f("G"), "inside")).toBe(true)
    expect(canDrop(base, c("c"), f("G"), "before")).toBe(false)
    expect(canDrop(base, f("F"), c("a"), "before")).toBe(true)
    expect(canDrop(base, f("F"), f("F"), "after")).toBe(false)
    expect(canDrop(base, f("G"), f("F"), "inside")).toBe(false)
    expect(canDrop(base, f("G"), c("a"), "after")).toBe(true)
  })

  it("rejects a folder dropped into itself or its subtree", () => {
    expect(canDrop(base, f("F"), f("G"), "inside")).toBe(false)
    expect(canDrop(base, f("F"), c("c"), "after")).toBe(false)
    expect(canDrop(base, f("F"), f("F"), "inside")).toBe(false)
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

  it("steps nested folders and connections among their siblings and out of their folder", () => {
    const tree = layout([["F", ["G", "x", "y"], ["H"]]])
    expect(shapeOf(moveStep(tree, f("G"), 1))).toEqual([["F", ["H"], ["G", "x", "y"]]])
    expect(shapeOf(moveStep(tree, f("G"), -1))).toEqual([
      ["G", "x", "y"],
      ["F", ["H"]],
    ])
    expect(shapeOf(moveStep(tree, c("y"), 1))).toEqual([["F", ["G", "x"], "y", ["H"]]])
    expect(shapeOf(moveStep(tree, c("x"), -1))).toEqual([["F", "x", ["G", "y"], ["H"]]])
  })

  it("returns the same layout at the top-level edges", () => {
    expect(moveStep(base, c("a"), -1)).toBe(base)
    expect(moveStep(base, c("d"), 1)).toBe(base)
    expect(moveStep(layout([["F"], "a"]), f("F"), -1).items).toEqual(layout([["F"], "a"]).items)
    expect(moveStep(base, c("missing"), 1)).toBe(base)
  })
})

describe("moveToFolder", () => {
  const base = layout(["a", ["F", "b", ["N", "n"]], ["G"]])

  it("appends to a folder at any depth, or goes back to the top level after its folder", () => {
    expect(shapeOf(moveToFolder(base, c("a"), "F"))).toEqual([["F", "b", ["N", "n"], "a"], ["G"]])
    expect(shapeOf(moveToFolder(base, c("a"), "N"))).toEqual([["F", "b", ["N", "n", "a"]], ["G"]])
    expect(shapeOf(moveToFolder(base, c("b"), "G"))).toEqual(["a", ["F", ["N", "n"]], ["G", "b"]])
    expect(shapeOf(moveToFolder(base, c("n"), null))).toEqual(["a", ["F", "b", ["N"]], "n", ["G"]])
  })

  it("moves folders too, but never into themselves", () => {
    expect(shapeOf(moveToFolder(base, f("N"), "G"))).toEqual(["a", ["F", "b"], ["G", ["N", "n"]]])
    expect(shapeOf(moveToFolder(base, f("N"), null))).toEqual(["a", ["F", "b"], ["N", "n"], ["G"]])
    expect(moveToFolder(base, f("F"), "N")).toBe(base)
    expect(moveToFolder(base, f("F"), "F")).toBe(base)
  })

  it("returns the same layout when it is already there", () => {
    expect(moveToFolder(base, c("a"), null)).toBe(base)
    expect(moveToFolder(base, c("b"), "F")).toBe(base)
    expect(moveToFolder(base, c("n"), "N")).toBe(base)
    expect(moveToFolder(base, f("G"), null)).toBe(base)
  })
})

describe("moveTargets", () => {
  const base = layout(["a", ["F", "b", ["N", "n"]], ["G"]])
  const disabledness = (l: ConnectionLayout, ref: LayoutRef) =>
    new Map(moveTargets(l, ref).map((t) => [t.folderId, t.disabled]))

  it("disables the top level, or the folder, a connection is already in", () => {
    expect(disabledness(base, c("a"))).toEqual(
      new Map([
        [null, true],
        ["F", false],
        ["N", false],
        ["G", false],
      ]),
    )
    expect(disabledness(base, c("b"))).toEqual(
      new Map([
        [null, false],
        ["F", true],
        ["N", false],
        ["G", false],
      ]),
    )
    expect(disabledness(base, c("n"))).toEqual(
      new Map([
        [null, false],
        ["F", false],
        ["N", true],
        ["G", false],
      ]),
    )
  })

  it("disables the top level a top-level folder is already at", () => {
    expect(disabledness(base, f("G"))).toEqual(
      new Map([
        [null, true],
        ["F", false],
        ["N", false],
        ["G", true],
      ]),
    )
  })

  it("disables a folder itself and its subfolders when moving it", () => {
    const tree = layout([["F", "a", ["G", "b", ["H"]]], ["K"]])
    // F is already at the top level; G is already in F. Either way its own subtree is out.
    expect(disabledness(tree, f("F"))).toEqual(
      new Map([
        [null, true],
        ["F", true],
        ["G", true],
        ["H", true],
        ["K", false],
      ]),
    )
    expect(disabledness(tree, f("G"))).toEqual(
      new Map([
        [null, false],
        ["F", true],
        ["G", true],
        ["H", true],
        ["K", false],
      ]),
    )
  })

  it("disables targets that would nest the moved item deeper than the limit", () => {
    const deep = layout([...chain(MAX_FOLDER_DEPTH - 1), ["P", ["Q"]], "z"])
    const last = `D${MAX_FOLDER_DEPTH - 1}`
    const secondToLast = `D${MAX_FOLDER_DEPTH - 2}`
    // Moving P (height 2, holding the empty folder Q) into D31 would reach 33 levels; into D30
    // it still fits at 32, and nothing stops it from going back to where it already is.
    expect(disabledness(deep, f("P")).get(last)).toBe(true)
    expect(disabledness(deep, f("P")).get(secondToLast)).toBe(false)
    expect(disabledness(deep, f("P")).get(null)).toBe(true)
  })
})

describe("placeAfter", () => {
  it("puts a duplicate right after its source, in the same folder", () => {
    expect(shapeOf(placeAfter(layout(["a", ["F", "b", "c"], "copy"]), "copy", "b"))).toEqual([
      "a",
      ["F", "b", "copy", "c"],
    ])
    expect(shapeOf(placeAfter(layout(["a", "b"]), "copy", "a"))).toEqual(["a", "copy", "b"])
    expect(shapeOf(placeAfter(layout([["F", ["G", "b"]], "copy"]), "copy", "b"))).toEqual([
      ["F", ["G", "b", "copy"]],
    ])
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

  it("creates a subfolder at the end of its parent and expands the parent", () => {
    const base = setFolderCollapsed(layout([["F", "a", ["G"]]]), "G", true)
    const result = createFolder(base, "S", "Sub", "G")
    expect(shapeOf(result)).toEqual([["F", "a", ["G", ["S"]]]])
    expect(result.folders.find((x) => x.id === "G")?.collapsed).toBe(false)
    expect(result.folders.at(-1)).toEqual({ id: "S", name: "Sub", collapsed: false })
    expect(createFolder(base, "S", "Sub", "nope")).toBe(base)
  })

  it("refuses a subfolder deeper than the limit", () => {
    const base = layout(chain(MAX_FOLDER_DEPTH))
    expect(createFolder(base, "S", "Sub", `D${MAX_FOLDER_DEPTH}`)).toBe(base)
    const result = createFolder(base, "S", "Sub", `D${MAX_FOLDER_DEPTH - 1}`)
    expect(shapeOf(result)).toEqual(chain(MAX_FOLDER_DEPTH - 1, [[`D${MAX_FOLDER_DEPTH}`], ["S"]]))
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

  it("deletes a nested folder and moves its contents, subfolders too, into its parent", () => {
    const result = deleteFolder(layout([["F", "a", ["G", "b", ["H", "c"]], "d"]]), "G")
    expect(shapeOf(result)).toEqual([["F", "a", "b", ["H", "c"], "d"]])
    expect(result.folders.map((x) => x.id)).toEqual(["F", "H"])
  })

  it("lists every folder with its path in tree order", () => {
    const base = renameFolder(layout([["F", ["G", ["H"]]], ["K"]]), "H", "mysql")
    expect(folderPaths(base).map((p) => [p.folder.id, p.names.join(" › ")])).toEqual([
      ["F", "Folder F"],
      ["G", "Folder F › Folder G"],
      ["H", "Folder F › Folder G › mysql"],
      ["K", "Folder K"],
    ])
  })
})

describe("layoutEntries", () => {
  const connections = [
    conn("a", "alpha"),
    conn("b", "beta"),
    conn("c", "gamma"),
    conn("d", "delta"),
  ]
  const base = layout(["a", ["F", "b", ["N", "d"]], ["E"], ["G", "c"]])
  const ids = (entries: readonly LayoutEntry[]): Shape =>
    entries.map((e) => (e.type === "folder" ? [e.folder.id, ...ids(e.children)] : e.config.id))

  it("lists connections and folders with what they hold", () => {
    const entries = layoutEntries(base, connections)
    expect(ids(entries)).toEqual(["a", ["F", "b", ["N", "d"]], ["E"], ["G", "c"]])
    const folder = entries[1]
    expect(folder.type === "folder" && folder.count).toBe(2)
  })

  it("keeps only matches and the folders around them while filtering", () => {
    const entries = layoutEntries(base, connections, (config) => config.name.includes("lt"))
    expect(ids(entries)).toEqual([["F", ["N", "d"]]])
    expect(entries[0].type === "folder" && entries[0].count).toBe(1)
  })
})
