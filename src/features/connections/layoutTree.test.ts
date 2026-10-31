import { describe, expect, it } from "vitest"
import type { LayoutEntry } from "../../lib/connectionLayout"
import type { ConnectionConfig } from "../../lib/connections"
import { databaseKey } from "../schema/treeState"
import {
  dragAttributes,
  dropPosition,
  entryKey,
  folderKey,
  readDragRef,
  sameRef,
  showsNode,
} from "./layoutTree"

const conn = { type: "connection", id: "c" } as const
const folder = { type: "folder", id: "f" } as const

/** Just enough of an element for `readDragRef`. */
const element = (attributes: Record<string, string>) =>
  ({ getAttribute: (name: string) => attributes[name] ?? null }) as unknown as Element

describe("dropPosition", () => {
  it("drops inside the middle of a folder row", () => {
    expect(dropPosition(conn, folder, 0.1)).toBe("before")
    expect(dropPosition(conn, folder, 0.5)).toBe("inside")
    expect(dropPosition(conn, folder, 0.9)).toBe("after")
    expect(dropPosition(folder, folder, 0.5)).toBe("inside")
  })

  it("gives a dragged folder wider bands before and after a folder row", () => {
    expect(dropPosition(folder, folder, 0.28)).toBe("before")
    expect(dropPosition(conn, folder, 0.28)).toBe("inside")
    expect(dropPosition(folder, folder, 0.72)).toBe("after")
    expect(dropPosition(conn, folder, 0.72)).toBe("inside")
  })

  it("splits connection rows in halves", () => {
    expect(dropPosition(conn, conn, 0.4)).toBe("before")
    expect(dropPosition(conn, conn, 0.6)).toBe("after")
    expect(dropPosition(folder, conn, 0.6)).toBe("after")
  })
})

describe("showsNode", () => {
  const config: ConnectionConfig = {
    kind: "mysql",
    id: "c",
    name: "c",
    host: "h",
    port: 1,
    user: "u",
  }
  const entry = (collapsed: boolean): LayoutEntry => ({
    type: "folder",
    folder: { id: "f", name: "F", collapsed: false },
    count: 1,
    children: [
      {
        type: "folder",
        folder: { id: "g", name: "G", collapsed },
        count: 1,
        children: [{ type: "connection", config }],
      },
    ],
  })

  it("finds rows and their schema nodes inside open folders", () => {
    expect(showsNode([entry(false)], folderKey("g"), false)).toBe(true)
    expect(showsNode([entry(false)], "c", false)).toBe(true)
    expect(showsNode([entry(false)], databaseKey("c", "app"), false)).toBe(true)
    expect(showsNode([entry(false)], "other", false)).toBe(false)
  })

  it("skips collapsed folders unless forced open", () => {
    expect(showsNode([entry(true)], folderKey("g"), false)).toBe(true)
    expect(showsNode([entry(true)], "c", false)).toBe(false)
    expect(showsNode([entry(true)], "c", true)).toBe(true)
  })

  it("keys entries like their rows", () => {
    expect(entryKey(entry(false))).toBe(folderKey("f"))
    expect(entryKey({ type: "connection", config })).toBe("c")
  })
})

describe("drag refs", () => {
  it("reads back what dragAttributes writes", () => {
    expect(readDragRef(element(dragAttributes(folder)))).toEqual(folder)
    expect(readDragRef(element(dragAttributes(conn)))).toEqual(conn)
  })

  it("ignores elements without a valid ref", () => {
    expect(readDragRef(null)).toBeNull()
    expect(readDragRef(element({ "data-drag-type": "table", "data-drag-id": "x" }))).toBeNull()
    expect(readDragRef(element({ "data-drag-type": "folder" }))).toBeNull()
  })

  it("compares refs by type and id", () => {
    expect(sameRef(conn, { type: "connection", id: "c" })).toBe(true)
    expect(sameRef(conn, { type: "folder", id: "c" })).toBe(false)
    expect(sameRef(null, conn)).toBe(false)
  })

  it("keeps folder keys apart from connection keys", () => {
    expect(folderKey("abc")).not.toBe("abc")
    expect(folderKey("abc").startsWith("abc")).toBe(false)
  })
})
