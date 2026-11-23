import { describe, expect, it } from "vitest"
import { changelogSection, releaseBody, unwrap } from "./release-notes.mjs"

const CHANGELOG = `# Changelog

## [Unreleased]

## [1.1.0] - 2026-11-23

### Added

- **Hover.** Shows a column's
  type and comment.
- Zoom (#5).

## [1.0.0] - 2026-11-01

### Fixed

- A fix.

[1.1.0]: https://example.com/compare
[1.0.0]: https://example.com/tag
`

describe("changelogSection", () => {
  it("returns the body under the version's heading, up to the next one", () => {
    expect(changelogSection(CHANGELOG, "1.1.0")).toBe(
      "### Added\n\n- **Hover.** Shows a column's\n  type and comment.\n- Zoom (#5).",
    )
    expect(changelogSection(CHANGELOG, "1.0.0")).toBe("### Fixed\n\n- A fix.")
  })

  it("is null for a missing or empty section", () => {
    expect(changelogSection(CHANGELOG, "2.0.0")).toBeNull()
    expect(changelogSection(CHANGELOG, "Unreleased")).toBeNull()
    expect(changelogSection(CHANGELOG, "1.1")).toBeNull()
  })
})

describe("releaseBody", () => {
  it("joins wrapped lines, raises headings and appends the install note", () => {
    const body = releaseBody(changelogSection(CHANGELOG, "1.1.0"))
    expect(body.startsWith("## Added\n\n- **Hover.** Shows a column's type and comment.\n- Zoom (#5).\n\n## Install\n")).toBe(true)
  })

  it("leaves fenced code blocks alone", () => {
    const section = "### Added\n\n- Run it:\n\n```sh\n### not a heading\npnpm a\npnpm b\n```\n\ntext\nmore"
    expect(releaseBody(section).split("\n\n## Install")[0]).toBe(
      "## Added\n\n- Run it:\n\n```sh\n### not a heading\npnpm a\npnpm b\n```\n\ntext more",
    )
  })

  it("keeps blocks apart when unwrapping", () => {
    expect(unwrap("para one\ncontinued\n\n- item\n- next\n  more\n## Head\ntext")).toBe(
      "para one continued\n\n- item\n- next more\n## Head\ntext",
    )
  })
})
