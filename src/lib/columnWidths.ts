/**
 * Remembers resized column widths per grid, keyed by the column names, so a grid that remounts
 * with the same columns (after Apply re-runs the statement, or a re-run of the same query)
 * keeps the widths the user chose.
 */

/** Most grids remembered at once; the oldest entry is dropped beyond this. */
export const MAX_REMEMBERED_GRIDS = 100

/** Identity of a column layout: names in order. Widths only carry over to the same layout. */
export function columnSignature(names: readonly string[]): string {
  return JSON.stringify(names)
}

export class WidthMemory {
  private readonly entries = new Map<string, readonly number[]>()

  constructor(private readonly limit: number = MAX_REMEMBERED_GRIDS) {}

  recall(gridKey: string, names: readonly string[]): readonly number[] | undefined {
    const widths = this.entries.get(this.key(gridKey, names))
    return widths && widths.length === names.length ? widths : undefined
  }

  remember(gridKey: string, names: readonly string[], widths: readonly number[]): void {
    const key = this.key(gridKey, names)
    // Re-inserting moves the entry to the end, so eviction drops the least recently resized.
    this.entries.delete(key)
    this.entries.set(key, [...widths])
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }

  private key(gridKey: string, names: readonly string[]): string {
    return `${gridKey}\u0000${columnSignature(names)}`
  }
}
