import type { ReactNode } from "react"
import { Button, Dialog, SegmentedControl, type SegmentOption } from "../../components/ui"
import type { SettingsPatch, ThemePreference } from "../../lib/settings"
import { useSettingsStore } from "../../state/settingsStore"
import { useUiStore } from "../../state/uiStore"
import { NumberSetting } from "./NumberSetting"
import { ToggleSetting } from "./ToggleSetting"
import "./settings.css"

const THEME_OPTIONS: readonly SegmentOption<ThemePreference>[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

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
  const { query, dynamo } = settings
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
          hint="UPDATE or DELETE without WHERE, DROP, TRUNCATE and ALTER ask first."
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
    </div>
  )
}
