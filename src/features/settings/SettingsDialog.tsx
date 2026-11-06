import type { ReactNode } from "react"
import { Button, Dialog, SegmentedControl, type SegmentOption } from "../../components/ui"
import type { SecretStore, SettingsPatch, ThemePreference } from "../../lib/settings"
import { formatShortcut } from "../../lib/shortcuts"
import { formatZoom, nearestZoomLevel, ZOOM_LEVELS, ZOOM_SHORTCUTS } from "../../lib/zoom"
import { useSettingsStore } from "../../state/settingsStore"
import { useUiStore } from "../../state/uiStore"
import { setUiZoom } from "../../state/uiZoom"
import { NumberSetting } from "./NumberSetting"
import { ToggleSetting } from "./ToggleSetting"
import "./settings.css"

const THEME_OPTIONS: readonly SegmentOption<ThemePreference>[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

const ZOOM_OPTIONS: readonly SegmentOption<string>[] = ZOOM_LEVELS.map((level) => ({
  value: String(level),
  label: formatZoom(level),
}))

const ZOOM_HINT = `Scales the whole window. ${formatShortcut(ZOOM_SHORTCUTS.in[0])} and ${formatShortcut(ZOOM_SHORTCUTS.out[0])} step through these; ${formatShortcut(ZOOM_SHORTCUTS.reset[0])} goes back to 100%.`

const SECRET_STORE_OPTIONS: readonly SegmentOption<SecretStore>[] = [
  { value: "keychain", label: "Keychain" },
  { value: "file", label: "App file" },
]

const SECRET_STORE_HINTS: Record<SecretStore, string> = {
  keychain:
    "Uses the system keychain. On macOS a development build asks for approval after each rebuild.",
  file: "Stores passwords in a file only your user account can read, like ~/.aws/credentials. Nothing is moved when you switch; you'll be asked for passwords again.",
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-label={title}>
      <h3 className="settings-section__title">{title}</h3>
      <div className="settings-section__body">{children}</div>
    </section>
  )
}

/** Preferences dialog (Mod+,). Every change saves at once; Done or Esc closes it. */
export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen)
  const close = useUiStore((s) => s.closeSettings)
  if (!open) return null
  return (
    <Dialog
      title="Settings"
      description="Changes are saved as you make them."
      onClose={close}
      footer={
        <>
          <span className="settings-footer__spacer" />
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <SettingsForm />
    </Dialog>
  )
}

function SettingsForm() {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const save = (patch: SettingsPatch) => void update(patch)
  const { query, dynamo, secretStore } = settings
  return (
    <div className="settings">
      <Section title="Appearance">
        <div className="ui-field">
          <span className="ui-field__label">Theme</span>
          <SegmentedControl
            label="Theme"
            value={settings.theme}
            options={THEME_OPTIONS}
            onChange={(theme) => save({ theme })}
          />
        </div>
        <div className="ui-field">
          <span className="ui-field__label">Zoom</span>
          {/* Snapped so a hand-edited level in between still checks one option and stays
              reachable by Tab. */}
          <SegmentedControl
            label="Zoom"
            value={String(nearestZoomLevel(settings.uiZoom))}
            options={ZOOM_OPTIONS}
            onChange={(level) => void setUiZoom(Number(level))}
          />
          <p className="ui-field__hint">{ZOOM_HINT}</p>
        </div>
        <NumberSetting
          field="editorFontSize"
          label="Editor font size"
          hint="Pixels, 11 to 20"
          value={settings.editorFontSize}
          onCommit={(editorFontSize) => save({ editorFontSize })}
        />
      </Section>
      <Section title="Queries">
        <NumberSetting
          field="defaultLimit"
          label="Default row limit"
          value={query.defaultLimit}
          onCommit={(defaultLimit) => save({ query: { defaultLimit } })}
        />
        <ToggleSetting
          label="Add LIMIT to SELECT statements without one"
          hint="Only the executed statement changes; the editor text stays as written."
          checked={query.addLimitToSelect}
          onChange={(addLimitToSelect) => save({ query: { addLimitToSelect } })}
        />
        <ToggleSetting
          label="Confirm destructive statements"
          hint="UPDATE or DELETE without WHERE, DROP, TRUNCATE, ALTER and RENAME TABLE ask first."
          checked={query.confirmDestructive}
          onChange={(confirmDestructive) => save({ query: { confirmDestructive } })}
        />
        <NumberSetting
          field="maxRows"
          label="Max rows kept per result"
          hint="Rows past this are not fetched into the grid."
          value={query.maxRows}
          onCommit={(maxRows) => save({ query: { maxRows } })}
        />
        <NumberSetting
          field="outputRetentionDays"
          label="Keep query output for (days)"
          hint="The Output log, including the SQL text you ran, is saved on this computer. 0 keeps it until the app quits; up to 365."
          value={query.outputRetentionDays}
          onCommit={(outputRetentionDays) => save({ query: { outputRetentionDays } })}
        />
      </Section>
      <Section title="DynamoDB">
        <NumberSetting
          field="pageSize"
          label="Default page size"
          hint="Items per page for new tabs and empty limit fields, 1 to 1,000"
          value={dynamo.pageSize}
          onCommit={(pageSize) => save({ dynamo: { pageSize } })}
        />
      </Section>
      <Section title="Security">
        <div className="ui-field">
          <span className="ui-field__label">Password storage</span>
          <SegmentedControl
            label="Password storage"
            value={secretStore}
            options={SECRET_STORE_OPTIONS}
            onChange={(next) => save({ secretStore: next })}
          />
          <p className="ui-field__hint">{SECRET_STORE_HINTS[secretStore]}</p>
        </div>
      </Section>
    </div>
  )
}
