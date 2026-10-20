import { describe, expect, it } from "vitest"
import { dragAttributes, dropPosition, folderKey, readDragRef, sameRef } from "./layoutTree"

const conn = { type: "connection", id: "c" } as const
const folder = { type: "folder", id: "f" } as const

/** Just enough of an element for `readDragRef`. */
const element = (attributes: Record<string, string>) =>
  ({ getAttribute: (name: string) => attributes[name] ?? null }) as unknown as Element

describe("dropPosition", () => {
  it("drops a connection inside the middle of a folder row", () => {
    expect(dropPosition(conn, folder, 0.1)).toBe("before")
    expect(dropPosition(conn, folder, 0.5)).toBe("inside")
    expect(dropPosition(conn, folder, 0.9)).toBe("after")
  })

  it("splits other rows in halves", () => {
    expect(dropPosition(conn, conn, 0.4)).toBe("before")
    expect(dropPosition(conn, conn, 0.6)).toBe("after")
    expect(dropPosition(folder, folder, 0.5)).toBe("after")
    expect(dropPosition(folder, conn, 0.2)).toBe("before")
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
