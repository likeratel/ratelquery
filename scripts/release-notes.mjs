#!/usr/bin/env node
/**
 * Prints the GitHub Release body for a version: its section of CHANGELOG.md followed by the install
 * note. Fails when the section is missing or empty, so a release can't ship without notes.
 *
 *   node scripts/release-notes.mjs 0.5.0     (a leading "v" is accepted)
 */

import { readFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

const INSTALL = `## Install

Download the file for your platform below. macOS builds are not notarized: right-click the app and choose **Open** on first launch, or run \`xattr -dr com.apple.quarantine /Applications/RatelQuery.app\`. See the [README](https://github.com/likeratel/ratelquery#install) for details.`

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** The body of `## [version]` in `changelog`, without its heading; null when absent or empty. */
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith("## ") || /^\[[^\]]+\]: /.test(line))
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim()
  return body === "" ? null : body
}

const BLOCK_START = /^(#|[-*+] |\d+\. |```|>|\|)/
const FENCE = /^\s*```/

/**
 * Joins the hard-wrapped lines of each paragraph and list item: GitHub renders a newline in a
 * release body as a line break. Fenced code blocks are left as they are.
 */
export function unwrap(markdown) {
  const out = []
  let inFence = false
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence
    if (inFence || FENCE.test(line)) {
      out.push(line)
      continue
    }
    const previous = out[out.length - 1]
    const continues =
      line.trim() !== "" &&
      previous !== undefined &&
      previous.trim() !== "" &&
      !previous.startsWith("#") &&
      !BLOCK_START.test(line.trimStart())
    if (continues) out[out.length - 1] = `${previous} ${line.trim()}`
    else out.push(line)
  }
  return out.join("\n")
}

/** `### ` headings one level up, outside fenced code blocks. */
function raiseHeadings(markdown) {
  let inFence = false
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) inFence = !inFence
      return !inFence && line.startsWith("### ") ? line.slice(1) : line
    })
    .join("\n")
}

/** The release page body: headings one level up (`### Added` → `## Added`), lines unwrapped. */
export function releaseBody(section) {
  return `${unwrap(raiseHeadings(section))}\n\n${INSTALL}\n`
}

/** Whether this file is the script node was asked to run (also through a symlinked path). */
function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

function main() {
  const version = (process.argv[2] ?? "").replace(/^v/, "")
  if (!VERSION.test(version)) {
    console.error("usage: node scripts/release-notes.mjs <version>")
    process.exit(2)
  }
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8")
  const section = changelogSection(changelog, version)
  if (!section) {
    console.error(`CHANGELOG.md has no notes under "## [${version}]".`)
    process.exit(1)
  }
  process.stdout.write(releaseBody(section))
}

if (isMain()) main()
