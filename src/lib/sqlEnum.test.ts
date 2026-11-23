import { describe, expect, it } from "vitest"
import { enumMembers, escapeStringBody, sqlStringLiteral } from "./sqlEnum"

describe("enumMembers", () => {
  it("reads enum and set members in declaration order", () => {
    expect(enumMembers("enum('SMISHING','NORMAL','SPAM')")).toEqual(["SMISHING", "NORMAL", "SPAM"])
    expect(enumMembers("set('read','write')")).toEqual(["read", "write"])
    expect(enumMembers("ENUM ( 'a' , 'b' )")).toEqual(["a", "b"])
  })

  it("unescapes quotes and backslash escapes as information_schema writes them", () => {
    // Read from MySQL 8.4 for ENUM('a''b','c\\d','x,y'): the backslash comes back doubled.
    expect(enumMembers("enum('a''b','c\\\\d','x,y')")).toEqual(["a'b", "c\\d", "x,y"])
    expect(enumMembers("enum('x)y','','l1\\nl2','\\'')")).toEqual(["x)y", "", "l1\nl2", "'"])
    expect(enumMembers("enum('trailing\\")).toBeNull()
  })

  it("is null for other types and malformed strings", () => {
    expect(enumMembers("varchar(20)")).toBeNull()
    expect(enumMembers("int unsigned")).toBeNull()
    expect(enumMembers("enumeration")).toBeNull()
    expect(enumMembers("enum('a'")).toBeNull()
    expect(enumMembers("enum('a' 'b')")).toBeNull()
    expect(enumMembers("enum(a)")).toBeNull()
  })
})

describe("string literals", () => {
  it("doubles quotes and escapes backslashes", () => {
    expect(escapeStringBody("it's")).toBe("it''s")
    expect(sqlStringLiteral("SMISHING")).toBe("'SMISHING'")
    expect(sqlStringLiteral("a\\b'c")).toBe("'a\\\\b''c'")
  })
})
