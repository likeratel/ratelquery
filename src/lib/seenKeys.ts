/** A set of string keys that can drop every key with a given prefix, such as a closed tab's. */
export class SeenKeys {
  private readonly keys = new Set<string>()

  has(key: string): boolean {
    return this.keys.has(key)
  }

  add(key: string): void {
    this.keys.add(key)
  }

  forgetPrefix(prefix: string): void {
    for (const key of [...this.keys]) {
      if (key.startsWith(prefix)) this.keys.delete(key)
    }
  }

  get size(): number {
    return this.keys.size
  }
}
