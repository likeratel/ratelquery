/**
 * Accent swatches a user can attach to a connection. These are persisted data values
 * (the IPC contract stores `color` as hex), so they are fixed hex strings rather than
 * theme tokens. They mirror the dark-theme accent, ok, warn, danger and data palette.
 */
export const CONNECTION_COLORS: readonly { value: string; label: string }[] = [
  { value: "#7c9cff", label: "Blue" },
  { value: "#4fd1a1", label: "Green" },
  { value: "#f2c14e", label: "Yellow" },
  { value: "#ff6b6b", label: "Red" },
  { value: "#c7a6ff", label: "Purple" },
  { value: "#7cc4ff", label: "Sky" },
]

export const HEX_COLOR = /^#[0-9a-f]{6}$/i
