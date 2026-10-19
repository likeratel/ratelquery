import type { SecretStore } from "../../lib/settings"
import { useSettingsStore } from "../../state/settingsStore"

/** Where a new secret will be kept, as chosen in Settings › Security. */
export function secretStoreHint(store: SecretStore): string {
  return store === "file"
    ? "Stored in the app's secrets file (Settings › Security), never in the connection list."
    : "Stored in the system keychain, never in the settings file."
}

export function useSecretStoreHint(): string {
  return useSettingsStore((s) => secretStoreHint(s.settings.secretStore))
}
