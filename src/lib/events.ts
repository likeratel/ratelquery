import type { ConnectionId } from "./connections"

/**
 * A tiny synchronous pub/sub for app-wide events that several stores react to. It lets the
 * connections store announce a deletion without importing the stores that clean up after it.
 */

export type AppEvents = {
  /** A connection was deleted on the backend; its tabs, session and caches should go. */
  "connection-removed": ConnectionId
}

type Listener<T> = (payload: T) => void

const listeners: { [K in keyof AppEvents]?: Set<Listener<AppEvents[K]>> } = {}

/** Registers a listener and returns the function that removes it. */
export function onAppEvent<K extends keyof AppEvents>(
  name: K,
  listener: Listener<AppEvents[K]>,
): () => void {
  const set = (listeners[name] ??= new Set()) as Set<Listener<AppEvents[K]>>
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

/** Calls every listener in registration order. A throwing listener doesn't stop the rest. */
export function emitAppEvent<K extends keyof AppEvents>(name: K, payload: AppEvents[K]): void {
  const set = listeners[name] as Set<Listener<AppEvents[K]>> | undefined
  if (!set) return
  for (const listener of [...set]) {
    try {
      listener(payload)
    } catch (error) {
      console.error(`"${name}" listener failed`, error)
    }
  }
}
