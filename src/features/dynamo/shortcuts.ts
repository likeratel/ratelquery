import { parseShortcut } from "../../lib/shortcuts"

/** Shortcuts local to the DynamoDB item editor; run / save / tabs live in APP_SHORTCUTS. */
export const DYNAMO_SHORTCUTS = {
  closeEditor: parseShortcut("Escape"),
} as const
