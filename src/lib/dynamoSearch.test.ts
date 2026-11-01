import { describe, expect, it } from "vitest"
import type { Item, PathSegment } from "./dynamo"
import { pathKey } from "./dynamoPath"
import {
  ancestorKeys,
  asTextQuery,
  DEFAULT_FIND_OPTIONS,
  EMPTY_OVERLAY,
  escapeFind,
  filterShows,
  filterTableRows,
  findFilter,
  findIndex,
  findInItem,
  jsonSearchText,
  orderHits,
  overlayReveal,
  overlaySetAll,
  overlayToggle,
  overlayToggleTable,
  queryPath,
  rescope,
  resolvePath,
  revealKeys,
  searchExpansion,
  stepMatch,
  textRanges,
  visibleRanges,
  type FindOptions,
} from "./dynamoSearch"
import {
  DEFAULT_TREE_EXPANSION,
  isExpanded,
  isTable,
  MAX_TREE_DEPTH,
  boundExpansion,
  shownExpandDepth,
  treeNode,
  type TreeExpansion,
  type TreeValue,
} from "./dynamoTree"

const item: Item = {
  pk: { S: "user#1" },
  senderService: {
    M: {
      numbers: {
        L: [
          { M: { senderNumber: { S: "01012345678" }, senderStatus: { S: "ACTIVE" } } },
          { M: { senderNumber: { S: "01099998888" }, senderStatus: { S: "Blocked" } } },
        ],
      },
    },
  },
  numbers: { L: [{ M: { senderStatus: { S: "top" } } }] },
  price: { N: "1.50" },
  enabled: { BOOL: true },
  removed: { BOOL: false },
  nothing: { NULL: true },
  blob: { B: "AAEC" },
  tags: { SS: ["red", "blue"] },
  meta: { S: '{"owner":{"name":"Ada","since":2019},"flags":[true,null]}' },
  rough: { S: '{"big":12345678901234567890,"note":"rounded"}' },
}

const names = Object.keys(item)
const entries = findIndex(item, names)
const find = (query: string, options: Partial<FindOptions> = {}) =>
  findInItem(entries, query, { ...DEFAULT_FIND_OPTIONS, ...options })
const paths = (query: string, options: Partial<FindOptions> = {}) =>
  find(query, options).hits.map((hit) => hit.path)

describe("findIndex", () => {
  it("lists every row in the tree's order, attributes in the order given", () => {
    const order = findIndex(item, ["price", "pk"]).map((entry) => entry.path)
    expect(order).toEqual([["price"], ["pk"]])
    const all = entries.map((entry) => pathKey(entry.path))
    expect(all.indexOf(pathKey(["senderService", "numbers", 0, "senderStatus"]))).toBeLessThan(
      all.indexOf(pathKey(["senderService", "numbers", 1, "senderNumber"])),
    )
  })

  it("is built once per item object and order", () => {
    const copy = { ...item }
    const first = findIndex(copy, names)
    expect(findIndex(copy, names)).toBe(first)
    expect(findIndex({ ...item }, names)).not.toBe(first)
    expect(findIndex(copy, ["pk"])).not.toBe(first)
  })
})

describe("findInItem: text", () => {
  it("matches keys and values case-insensitively by default", () => {
    expect(paths("senderstatus")).toEqual([
      ["senderService", "numbers", 0, "senderStatus"],
      ["senderService", "numbers", 1, "senderStatus"],
      ["numbers", 0, "senderStatus"],
    ])
    expect(paths("blocked")).toEqual([["senderService", "numbers", 1, "senderStatus"]])
  })

  it("reports where the query occurs in the key and in the value", () => {
    const [hit] = find("ACT").hits
    expect(hit).toEqual({
      path: ["senderService", "numbers", 0, "senderStatus"],
      key: [],
      value: [[0, 3]],
    })
    expect(find("sender").hits[0]).toMatchObject({ key: [[0, 6]], value: [] })
  })

  it("searches keys only or values only", () => {
    expect(paths("status", { values: false })).toHaveLength(3)
    expect(paths("status", { keys: false })).toEqual([])
    expect(paths("top", { keys: false })).toEqual([["numbers", 0, "senderStatus"]])
    expect(paths("top", { values: false })).toEqual([])
    expect(paths("sender", { keys: false, values: false })).toEqual([])
  })

  it("matches case-sensitively when asked", () => {
    expect(paths("active", { caseSensitive: true })).toEqual([])
    expect(paths("ACTIVE", { caseSensitive: true })).toEqual([
      ["senderService", "numbers", 0, "senderStatus"],
    ])
  })

  it("searches set members and every depth of JSON stored in a string", () => {
    expect(paths("blue")).toEqual([["tags", 1]])
    expect(paths("ada")).toEqual([["meta", "owner", "name"]])
    expect(paths("since")).toEqual([["meta", "owner", "since"]])
    expect(paths("2019")).toEqual([["meta", "owner", "since"]])
  })

  it("matches JSON whose numbers can't be read exactly as the string it is", () => {
    expect(paths("12345678901234567890")).toEqual([["rough"]])
    expect(paths("big", { values: false })).toEqual([])
  })

  it("matches numbers on their exact text and booleans as true / false", () => {
    expect(paths("1.50")).toEqual([["price"]])
    expect(paths("1.5")).toEqual([["price"]])
    expect(paths("1.500")).toEqual([])
    expect(paths("true", { keys: false })).toEqual([["enabled"], ["meta", "flags", 0]])
    expect(paths("false")).toEqual([["removed"]])
  })

  it("matches NULL as the NULL it shows, so null finds it unless case matters", () => {
    expect(paths("null", { keys: false })).toEqual([["nothing"], ["meta", "flags", 1]])
    expect(paths("null", { keys: false, caseSensitive: true })).toEqual([])
    expect(paths("NULL", { keys: false, caseSensitive: true })).toHaveLength(2)
  })

  it("never matches binary on its placeholder text", () => {
    expect(paths("binary")).toEqual([])
    expect(paths("bytes")).toEqual([])
  })

  it("does nothing for an empty or blank query", () => {
    expect(find("").hits).toEqual([])
    expect(find("   ").hits).toEqual([])
  })
})

describe("textRanges", () => {
  it("finds every occurrence without overlaps", () => {
    expect(textRanges("aaaa", "aa", false)).toEqual([
      [0, 2],
      [2, 4],
    ])
    expect(textRanges("Abc abc", "ABC", false)).toEqual([
      [0, 3],
      [4, 7],
    ])
    expect(textRanges("Abc abc", "ABC", true)).toEqual([])
  })

  it("gives offsets into the original text when lowercasing changes its length", () => {
    // "İ".toLowerCase() is two code units long; offsets must not drift past it.
    expect(textRanges("İ😀abc", "😀", false)).toEqual([[1, 3]])
    expect(textRanges("İİ한국어", "한국", false)).toEqual([[2, 4]])
    expect(textRanges("İİ한국어", "한국", true)).toEqual([[2, 4]])
    expect(textRanges("a😀b😀", "😀", false)).toEqual([
      [1, 3],
      [4, 6],
    ])
  })

  it("matches regex characters literally", () => {
    expect(textRanges("a.b*c(d)[e]", ".b*c(d)[e]", false)).toEqual([[1, 11]])
    expect(textRanges("axbc", ".b", false)).toEqual([])
  })
})

describe("findInItem: path", () => {
  it("reads only text with a dot or a bracket as a path", () => {
    expect(queryPath("senderStatus")).toBeNull()
    expect(queryPath(" numbers[0].senderStatus ")).toEqual(["numbers", 0, "senderStatus"])
    expect(queryPath("1.5")).toBeNull()
  })

  it("jumps to the path from the top first", () => {
    const result = find("numbers[0].senderStatus")
    expect(result.via).toBe("path")
    expect(result.hits.map((hit) => hit.path)).toEqual([["numbers", 0, "senderStatus"]])
  })

  it("takes a path that leads nowhere from the top as the end of longer paths", () => {
    expect(paths("numbers[1].senderStatus")).toEqual([
      ["senderService", "numbers", 1, "senderStatus"],
    ])
    expect(paths("senderService.numbers[1]")).toEqual([["senderService", "numbers", 1]])
    expect(paths("owner.name")).toEqual([["meta", "owner", "name"]])
  })

  it("finds every row a suffix leads to", () => {
    const rows = resolvePath(entries, ["senderStatus"])
    expect(rows.map((entry) => entry.path)).toHaveLength(3)
  })

  it("counts the text matches a path hides, and searches a quoted query as text", () => {
    const result = find("numbers[0].senderStatus")
    expect(result.asText).toBe(0)
    expect(find("owner.name").asText).toBe(0)
    const fancy: Item = { "a.b": { S: "x" }, note: { S: "see a.b" } }
    const index = findIndex(fancy, ["a.b", "note"])
    const asPath = findInItem(index, '["a.b"]', DEFAULT_FIND_OPTIONS)
    expect(asPath).toMatchObject({ via: "path", asText: 0 })
    const dotted: Item = { a: { M: { b: { S: "1" } } }, note: { S: "see a.b" } }
    const dots = findIndex(dotted, ["a", "note"])
    expect(findInItem(dots, "a.b", DEFAULT_FIND_OPTIONS)).toMatchObject({
      via: "path",
      asText: 1,
    })
    const quoted = findInItem(dots, '"a.b"', DEFAULT_FIND_OPTIONS)
    expect(quoted.via).toBe("text")
    expect(quoted.hits.map((hit) => hit.path)).toEqual([["note"]])
    expect(quoted.hits[0].value).toEqual([[4, 7]])
  })

  it("searches a quoted run of spaces literally", () => {
    const spaced: Item = { a: { S: "x  y" }, b: { S: "x y" } }
    const index = findIndex(spaced, ["a", "b"])
    expect(findInItem(index, '"  "', DEFAULT_FIND_OPTIONS).hits.map((hit) => hit.path)).toEqual([
      ["a"],
    ])
    expect(findInItem(index, '""', DEFAULT_FIND_OPTIONS).hits).toEqual([])
    expect(findInItem(index, "  ", DEFAULT_FIND_OPTIONS).hits).toEqual([])
  })

  it("counts as text exactly what the as-text query then finds", () => {
    const dotted: Item = { a: { M: { b: { S: "1" } } }, note: { S: "see a.b and a.b " } }
    const index = findIndex(dotted, ["a", "note"])
    for (const query of ["a.b", " a.b ", "a.b "]) {
      const path = findInItem(index, query, DEFAULT_FIND_OPTIONS)
      expect(path.via).toBe("path")
      const text = findInItem(index, asTextQuery(query), DEFAULT_FIND_OPTIONS)
      expect(text.via).toBe("text")
      expect(text.hits).toHaveLength(path.asText)
    }
  })

  it("falls back to a text search when the path leads nowhere", () => {
    const result = find("numbers[5].senderStatus")
    expect(result.via).toBe("text")
    expect(result.hits).toEqual([])
    expect(find("user#1").hits.map((hit) => hit.path)).toEqual([["pk"]])
  })
})

describe("ancestors and filter mode", () => {
  const deep: PathSegment[] = ["senderService", "numbers", 1, "senderStatus"]

  it("opens every row above a match", () => {
    expect([...ancestorKeys([deep])]).toEqual([
      pathKey(["senderService"]),
      pathKey(["senderService", "numbers"]),
      pathKey(["senderService", "numbers", 1]),
    ])
  })

  it("shows the matches, the rows above them and everything inside them", () => {
    const filter = findFilter([deep, ["numbers"]])
    expect(filterShows(filter, ["senderService"])).toBe(true)
    expect(filterShows(filter, ["senderService", "numbers", 1])).toBe(true)
    expect(filterShows(filter, ["senderService", "numbers", 0])).toBe(false)
    expect(filterShows(filter, ["numbers", 0, "senderStatus"])).toBe(true)
    expect(filterShows(filter, ["pk"])).toBe(false)
  })

  it("keeps the table rows that hold a match", () => {
    const rows = [0, 1, 2].map((segment) => ({ segment }))
    const filter = findFilter([deep])
    expect(filterTableRows(filter, ["senderService", "numbers"], rows)).toEqual([{ segment: 1 }])
    const whole = findFilter([["senderService", "numbers"]])
    expect(filterTableRows(whole, ["senderService", "numbers"], rows)).toEqual(rows)
  })
})

describe("searchExpansion and the search overlay", () => {
  const user: TreeExpansion = {
    base: "first",
    open: { [pathKey(["senderService"])]: false },
    tables: { [pathKey(["senderService", "numbers"])]: true },
  }
  const deep: PathSegment[] = ["senderService", "numbers", 1, "senderStatus"]
  const reveal = ancestorKeys([deep])
  const frozen = structuredClone(user)

  it("opens the rows above matches without touching the user's expansion", () => {
    const shown = searchExpansion(user, reveal, EMPTY_OVERLAY)
    expect(isExpanded(shown, ["senderService"], false)).toBe(true)
    expect(isExpanded(shown, ["senderService", "numbers", 1], false)).toBe(true)
    expect(shown.tables).toEqual(user.tables)
    expect(user).toEqual(frozen)
  })

  it("lets toggles made during the search win, and forgets them once it is cleared", () => {
    const during = searchExpansion(user, reveal, EMPTY_OVERLAY)
    const overlay = overlayToggle(EMPTY_OVERLAY, during, ["senderService"], false)
    expect(isExpanded(searchExpansion(user, reveal, overlay), ["senderService"], false)).toBe(false)
    // Clearing the query: no reveal, no overlay, the user's own expansion as it was.
    expect(searchExpansion(user, new Set(), EMPTY_OVERLAY)).toBe(user)
    expect(searchExpansion(DEFAULT_TREE_EXPANSION, new Set(), EMPTY_OVERLAY)).toBe(
      DEFAULT_TREE_EXPANSION,
    )
    expect(user).toEqual(frozen)
  })

  it("collapses and expands everything during the search but the current match", () => {
    const focus = ancestorKeys([deep])
    const collapsed = searchExpansion(user, reveal, overlaySetAll(EMPTY_OVERLAY, false), focus)
    expect(collapsed.base).toBe("none")
    expect(isExpanded(collapsed, ["pk"], false)).toBe(false)
    expect(isExpanded(collapsed, ["numbers"], false)).toBe(false)
    expect(isExpanded(collapsed, ["senderService", "numbers"], false)).toBe(true)
    const expanded = searchExpansion(user, reveal, overlaySetAll(EMPTY_OVERLAY, true), focus)
    expect(isExpanded(expanded, ["numbers", 0], false)).toBe(true)
    // Nothing reached the user's expansion: clearing the search shows the tree as it was.
    expect(user).toEqual(frozen)
    expect(searchExpansion(user, new Set(), EMPTY_OVERLAY)).toBe(user)
  })

  it("keeps table toggles and followed cells of the search out of the user's state", () => {
    const shown = searchExpansion(user, reveal, EMPTY_OVERLAY)
    const asTree = overlayToggleTable(EMPTY_OVERLAY, shown, ["senderService", "numbers"])
    expect(isTable(searchExpansion(user, reveal, asTree), ["senderService", "numbers"])).toBe(false)
    const followed = overlayReveal(EMPTY_OVERLAY, ["senderService", "numbers"], deep)
    const after = searchExpansion(user, reveal, followed)
    expect(isTable(after, ["senderService", "numbers"])).toBe(false)
    expect(isExpanded(after, ["senderService", "numbers", 1, "senderStatus"], false)).toBe(true)
    expect(isTable(user, ["senderService", "numbers"])).toBe(true)
    expect(user).toEqual(frozen)
  })
})

describe("revealKeys", () => {
  const many = Array.from({ length: 4 }, (_, i): PathSegment[] => ["list", i, "name"])

  it("opens the rows above every match up to the limit", () => {
    expect(revealKeys(many, many[0], 4).size).toBe(5)
  })

  it("opens only the current match's rows past the limit", () => {
    expect([...revealKeys(many, many[2], 3)]).toEqual([pathKey(["list"]), pathKey(["list", 2])])
    expect(revealKeys(many, null, 3).size).toBe(0)
  })
})

describe("orderHits", () => {
  const rows: Item = {
    list: {
      L: [{ M: { a: { S: "x1" }, b: { S: "x2" } } }, { M: { b: { S: "x3" }, a: { S: "x4" } } }],
    },
    other: { M: { b: { S: "x5" }, a: { S: "x6" } } },
  }
  const hits = findInItem(findIndex(rows, ["list", "other"]), "x", DEFAULT_FIND_OPTIONS).hits
  const order = (tables: string[]) =>
    orderHits(hits, rows, (path) => tables.includes(pathKey(path))).map((hit) => hit.path)

  it("keeps document order outside tables", () => {
    expect(orderHits(hits, rows, () => false)).toBe(hits)
    expect(order([])).toEqual([
      ["list", 0, "a"],
      ["list", 0, "b"],
      ["list", 1, "b"],
      ["list", 1, "a"],
      ["other", "b"],
      ["other", "a"],
    ])
  })

  it("orders a table row's cells by the table's columns", () => {
    expect(order([pathKey(["list"])])).toEqual([
      ["list", 0, "a"],
      ["list", 0, "b"],
      ["list", 1, "a"],
      ["list", 1, "b"],
      ["other", "b"],
      ["other", "a"],
    ])
  })
})

describe("visibleRanges / jsonSearchText", () => {
  it("leaves the ellipsis of a shortened value and counts the matches past it", () => {
    expect(
      visibleRanges(
        [
          [0, 2],
          [398, 402],
          [450, 452],
        ],
        400,
      ),
    ).toEqual({
      shown: [
        [0, 2],
        [398, 400],
      ],
      hidden: 1,
    })
  })

  it("prefills JSON with the same text the tree searches, or a path's last key", () => {
    const resolves = (path: readonly PathSegment[]) => resolvePath(entries, path).length > 0
    expect(jsonSearchText(" ada ", resolves)).toBe(" ada ")
    expect(jsonSearchText("   ", resolves)).toBe("")
    expect(jsonSearchText("numbers[0].senderStatus", resolves)).toBe("senderStatus")
    expect(jsonSearchText("senderService.numbers[1]", resolves)).toBe("numbers")
    expect(jsonSearchText('"a.b"', resolves)).toBe("a.b")
    expect(jsonSearchText('"  "', resolves)).toBe("  ")
  })

  it("prefills path-shaped text that leads nowhere as the text the tree searches", () => {
    const site: Item = { url: { S: "example.com" } }
    const index = findIndex(site, ["url"])
    const resolves = (path: readonly PathSegment[]) => resolvePath(index, path).length > 0
    const tree = findInItem(index, "example.com", DEFAULT_FIND_OPTIONS)
    expect(tree).toMatchObject({ via: "text", hits: [{ path: ["url"] }] })
    expect(jsonSearchText("example.com", resolves)).toBe("example.com")
  })
})

describe("rescope", () => {
  it("keeps a search's state while the search stays", () => {
    const stored = { search: "name", value: overlaySetAll(EMPTY_OVERLAY, false) }
    expect(rescope(stored, "name", EMPTY_OVERLAY)).toBe(stored)
  })

  it("starts afresh when the same query is typed again after another search", () => {
    // Type `name`, Collapse all, Esc, type `name` again: the tree must not collapse by itself.
    let stored = { search: "name", value: overlaySetAll(EMPTY_OVERLAY, false) }
    stored = rescope(stored, "", EMPTY_OVERLAY)
    expect(stored.value).toBe(EMPTY_OVERLAY)
    stored = rescope(stored, "name", EMPTY_OVERLAY)
    expect(stored).toEqual({ search: "name", value: EMPTY_OVERLAY })
  })
})

describe("stepMatch / escapeFind", () => {
  it("moves to the next and previous match and wraps at either end", () => {
    expect(stepMatch(0, 3, 1)).toBe(1)
    expect(stepMatch(2, 3, 1)).toBe(0)
    expect(stepMatch(0, 3, -1)).toBe(2)
    expect(stepMatch(1, 3, -1)).toBe(0)
    expect(stepMatch(0, 1, 1)).toBe(0)
    expect(stepMatch(0, 0, 1)).toBe(0)
  })

  it("clears the query first, then closes the bar", () => {
    const cleared = escapeFind({ open: true, query: "abc" })
    expect(cleared).toEqual({ open: true, query: "" })
    expect(escapeFind(cleared)).toEqual({ open: false, query: "" })
  })
})

describe("find in JSON numbers and deep JSON", () => {
  it("matches a JSON number by the digits its string stores", () => {
    const stored: Item = { doc: { S: '{"big":1000000000000000000000,"price":1.50}' } }
    const index = findIndex(stored, ["doc"])
    const hits = (query: string) =>
      findInItem(index, query, DEFAULT_FIND_OPTIONS).hits.map((hit) => hit.path)
    expect(hits("1000000000000000000000")).toEqual([["doc", "big"]])
    expect(hits("1.50")).toEqual([["doc", "price"]])
    expect(hits("1e+21")).toEqual([])
  })

  it("indexes no rows below the deepest level the tree shows", () => {
    const depth = MAX_TREE_DEPTH + 50
    const deep: Item = { doc: { S: "[".repeat(depth) + '"needle"' + "]".repeat(depth) } }
    const index = findIndex(deep, ["doc"])
    expect(Math.max(...index.map((entry) => entry.path.length))).toBe(MAX_TREE_DEPTH)
    expect(findInItem(index, "needle", DEFAULT_FIND_OPTIONS).hits).toEqual([])
  })
})

describe("Expand all during a filtered search", () => {
  /** Rows the tree renders: open all the way down from an attribute, and shown by `filter`. */
  function renderedRows(
    item: Item,
    expansion: TreeExpansion,
    filter: ReturnType<typeof findFilter> | null,
  ): PathSegment[][] {
    const rows: PathSegment[][] = []
    const visit = (value: TreeValue, path: PathSegment[]) => {
      if (filter && !filterShows(filter, path)) return
      rows.push(path)
      const node = treeNode(value)
      if (!node.children || !isExpanded(expansion, path, node.json !== null)) return
      for (const child of node.children) visit(child.value, [...path, child.segment])
    }
    for (const name of Object.keys(item)) visit({ kind: "wire", value: item[name] }, [name])
    return rows
  }

  /** The tree after Expand all during a search for `query`, in filter mode or not. */
  function expandAllWith(item: Item, query: string, filtering: boolean) {
    const names = Object.keys(item)
    const hits = findInItem(findIndex(item, names), query, DEFAULT_FIND_OPTIONS).hits
    const paths = hits.map((hit) => hit.path)
    const filter = filtering ? findFilter(paths) : null
    const above = ancestorKeys(paths)
    // Only the current match's rows are opened by name once Expand all sets the base.
    const shown = searchExpansion(
      DEFAULT_TREE_EXPANSION,
      above,
      overlaySetAll(EMPTY_OVERLAY, true),
      ancestorKeys(paths.slice(-1)),
    )
    const depth = shownExpandDepth(shown.base, item, names)
    const expansion = boundExpansion(shown, depth, filter ? above : new Set())
    return { paths, depth, rows: renderedRows(item, expansion, filter) }
  }

  // 3,000 maps: opening everything would be 9,001 rows, past EXPAND_LIMIT.
  const needles = new Set([2998, 2999])
  const deep: Item = {
    l: {
      L: Array.from({ length: 3000 }, (_, i) => ({
        M: { x: { M: { y: { S: needles.has(i) ? "needle" : "n" } } } },
      })),
    },
  }
  const other: PathSegment[] = ["l", 2998, "x", "y"]
  const current: PathSegment[] = ["l", 2999, "x", "y"]

  it("bounds the depth whenever everything is opened", () => {
    expect(shownExpandDepth("all", deep, ["l"])).toBe(1)
    expect(shownExpandDepth("first", deep, ["l"])).toBeNull()
    expect(boundExpansion(DEFAULT_TREE_EXPANSION, null, new Set(["x"]))).toBe(
      DEFAULT_TREE_EXPANSION,
    )
  })

  it("keeps every deep leaf match in view under a filter", () => {
    const { paths, depth, rows } = expandAllWith(deep, "needle", true)
    expect(paths).toEqual([other, current])
    expect(depth).toBe(1)
    const keys = rows.map(pathKey)
    for (const match of [other, current]) expect(keys).toContain(pathKey(match))
    expect(rows.length).toBeLessThanOrEqual(10)
  })

  it("keeps a matching container's subtree bounded under a filter", () => {
    // 3,000 maps of 20 fields: the whole of `l` would be 63,001 rows.
    const wide: Item = {
      l: {
        L: Array.from({ length: 3000 }, () => ({
          M: Object.fromEntries(Array.from({ length: 20 }, (_, f) => [`f${f}`, { S: "v" }])),
        })),
      },
    }
    const { paths, depth, rows } = expandAllWith(wide, "l", true)
    expect(paths).toEqual([["l"]])
    expect(depth).toBe(1)
    expect(rows).toHaveLength(3001)
  })

  it("bounds highlight mode the same way", () => {
    const { rows } = expandAllWith(deep, "needle", false)
    // Only the current match's rows open past the bound.
    expect(rows.length).toBe(3001 + 2)
  })

  it("leaves a row the user closed during the search closed", () => {
    const shown = {
      ...DEFAULT_TREE_EXPANSION,
      base: "all" as const,
      open: { [pathKey(["l"])]: false },
    }
    const bounded = boundExpansion(shown, 1, new Set([pathKey(["l"])]))
    expect(isExpanded(bounded, ["l"], false)).toBe(false)
  })
})
