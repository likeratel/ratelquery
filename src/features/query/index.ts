// STUB owned by the query feature. The query implementer replaces this file.
// Other features may rely on this public surface only.
import type { ConnectionId } from "../../lib/connections"

/** Connects (if needed) and opens a query tab for the given MySQL connection. */
export async function openQueryTabFor(_connectionId: ConnectionId): Promise<void> {}
