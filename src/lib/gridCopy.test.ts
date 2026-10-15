import { describe, expect, it } from "vitest"
import { copyText } from "./gridCopy"

describe("copyText", () => {
  it("copies one cell as its plain text", () => {
    expect(copyText([{ t: "str", v: 'say "hi"\tthere' }])).toBe('say "hi"\tthere')
    expect(copyText([{ t: "null" }])).toBe("NULL")
    expect(copyText([{ t: "bool", v: true }])).toBe("true")
  })

  it("tab-separates a row and quotes fields that would break the columns", () => {
    expect(
      copyText([
        { t: "int", v: "1" },
        { t: "str", v: "a\tb" },
        { t: "str", v: 'x"y' },
        undefined,
        { t: "float", v: 1.5 },
      ]),
    ).toBe('1\t"a\tb"\t"x""y"\t\t1.5')
  })
})
