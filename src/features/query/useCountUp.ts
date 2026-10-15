import { useEffect, useState } from "react"
import { SeenKeys } from "../../lib/seenKeys"

const COUNT_UP_MS = 200

/** Runs that already animated, so remounting (tab or result switch) shows the final value. */
const animated = new SeenKeys()

/** Drops the runs of a closed tab; run keys start with `${tabId}:`. */
export function forgetTabCountUps(tabId: string): void {
  animated.forgetPrefix(`${tabId}:`)
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/**
 * Counts from 0 to `target` the first time a given `runKey` is shown. Shows `target` at once
 * for runs seen before and under reduced motion.
 */
export function useCountUp(target: number, runKey: string): number {
  const [value, setValue] = useState(() =>
    animated.has(runKey) || target <= 1 || prefersReducedMotion() ? target : 0,
  )

  useEffect(() => {
    if (animated.has(runKey) || prefersReducedMotion() || target <= 1) {
      animated.add(runKey)
      setValue(target)
      return
    }
    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MS)
      const eased = 1 - (1 - progress) ** 3
      setValue(Math.round(target * eased))
      if (progress < 1) frame = requestAnimationFrame(tick)
      else animated.add(runKey)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, runKey])

  return value
}
