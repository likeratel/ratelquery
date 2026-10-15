import { describe, expect, it } from "vitest"
import { detectPlatform, resolveTheme } from "./uiStore"

describe("resolveTheme", () => {
  it("follows the system only for the system preference", () => {
    expect(resolveTheme("system", true)).toBe("light")
    expect(resolveTheme("system", false)).toBe("dark")
    expect(resolveTheme("dark", true)).toBe("dark")
    expect(resolveTheme("light", false)).toBe("light")
  })
})

describe("detectPlatform", () => {
  it("recognises the three desktop platforms", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos")
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows")
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux")
    expect(detectPlatform("")).toBe("unknown")
  })
})
