import { isTauri } from "@tauri-apps/api/core"
import { homeDir, join } from "@tauri-apps/api/path"
import { open } from "@tauri-apps/plugin-dialog"

/** The native file picker only exists inside the Tauri window. */
export const canPickKeyFile = (): boolean => isTauri()

/** `~/.ssh`, or undefined when the home directory can't be resolved. */
async function sshDir(): Promise<string | undefined> {
  try {
    return await join(await homeDir(), ".ssh")
  } catch {
    return undefined
  }
}

/** Opens the file picker on `~/.ssh`. Resolves with the chosen path, or null when cancelled. */
export async function pickKeyFile(): Promise<string | null> {
  const picked = await open({
    title: "Choose an SSH private key",
    multiple: false,
    directory: false,
    defaultPath: await sshDir(),
  })
  return typeof picked === "string" ? picked : null
}
