// STUB owned by the connections feature. The connections implementer replaces this file.
// Other features may rely on this public surface only.
import { create } from "zustand"
import type { ConnectionConfig, ConnectionId } from "../lib/connections"

interface ConnectionsState {
  connections: ConnectionConfig[]
  load: () => Promise<void>
  openDialog: (existing?: ConnectionConfig) => void
  byId: (id: ConnectionId) => ConnectionConfig | undefined
}

export const useConnectionsStore = create<ConnectionsState>((_set, get) => ({
  connections: [],
  load: async () => {},
  openDialog: () => {},
  byId: (id) => get().connections.find((c) => c.id === id),
}))
