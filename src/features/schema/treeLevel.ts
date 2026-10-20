import { createContext, useContext } from "react"

/**
 * How many levels a subtree sits below where its rows would be at the top of the tree: a
 * connection inside a sidebar folder is one level deeper, and so is everything under it.
 */
export const TreeLevelOffset = createContext(0)

/** aria-level (and indentation) of a row written as `level` for a top-level connection. */
export function useTreeLevel(level: number): number {
  return level + useContext(TreeLevelOffset)
}
