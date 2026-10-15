import { Play } from "lucide-react"
import type { ReactNode } from "react"
import { SegmentedControl } from "../../components/ui"
import type { KeyAttribute, KeyType, TableDescription } from "../../lib/dynamo"
import { indexKeySchema, RANGE_OPS, type DynamoMode, type RangeOp } from "../../lib/dynamoRequest"
import type { DynamoTab } from "../../lib/dynamoTabs"
import { formatShortcut } from "../../lib/shortcuts"
import { APP_SHORTCUTS } from "../query/appShortcuts"
import { patchForm, runDynamo, setDynamoMode } from "./actions"

const MODE_OPTIONS = [
  { value: "scan", label: "Scan" },
  { value: "query", label: "Query" },
] as const

const PLACEHOLDER: Record<KeyType, string> = { S: "text", N: "number", B: "base64" }

function Field({ label, children, grow }: { label: string; children: ReactNode; grow?: boolean }) {
  return (
    <label className="dyn-field" data-grow={grow || undefined}>
      <span className="dyn-field__label">{label}</span>
      {children}
    </label>
  )
}

interface KeyInputProps {
  attr: KeyAttribute
  value: string
  label?: string
  onChange: (value: string) => void
}

function KeyInput({ attr, value, label, onChange }: KeyInputProps) {
  return (
    <input
      className="dyn-input mono"
      aria-label={label ?? `${attr.name} (${attr.type})`}
      placeholder={PLACEHOLDER[attr.type]}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      autoComplete="off"
    />
  )
}

function KeyConditions({ tab, description }: { tab: DynamoTab; description: TableDescription }) {
  const schema = indexKeySchema(description, tab.form.index)
  if (!schema) return null
  const { form } = tab
  const range = schema.range
  const set = (patch: Parameters<typeof patchForm>[1]) => patchForm(tab.id, patch)
  return (
    <>
      <Field label={`${schema.hash.name} =`}>
        <KeyInput attr={schema.hash} value={form.hash} onChange={(hash) => set({ hash })} />
      </Field>
      {range && (
        <Field label={range.name}>
          <span className="dyn-range">
            <select
              className="dyn-select"
              aria-label={`${range.name} condition`}
              value={form.rangeOp}
              onChange={(event) => set({ rangeOp: event.target.value as RangeOp | "" })}
            >
              <option value="">Any</option>
              {RANGE_OPS.filter((o) => o.op !== "begins_with" || range.type !== "N").map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {form.rangeOp !== "" && (
              <KeyInput
                attr={range}
                value={form.rangeValue}
                onChange={(rangeValue) => set({ rangeValue })}
              />
            )}
            {form.rangeOp === "between" && (
              <>
                <span className="dyn-range__and">and</span>
                <KeyInput
                  attr={range}
                  label={`${range.name} upper bound`}
                  value={form.rangeTo}
                  onChange={(rangeTo) => set({ rangeTo })}
                />
              </>
            )}
          </span>
        </Field>
      )}
      <label className="dyn-check">
        <input
          type="checkbox"
          checked={!form.scanForward}
          onChange={(event) => set({ scanForward: !event.target.checked })}
        />
        Descending
      </label>
    </>
  )
}

interface QueryFormProps {
  tab: DynamoTab
  description: TableDescription | null
}

/** Scan / Query request form. Enter in any field or Mod+Enter runs it. */
export function QueryForm({ tab, description }: QueryFormProps) {
  const { form } = tab
  const set = (patch: Parameters<typeof patchForm>[1]) => patchForm(tab.id, patch)
  const indexes = description?.indexes ?? []

  return (
    <form
      className="dyn-form"
      aria-label="Request"
      onSubmit={(event) => {
        event.preventDefault()
        void runDynamo(tab.id, "first")
      }}
    >
      <div className="dyn-form__row">
        <div className="dyn-compact">
          <SegmentedControl<DynamoMode>
            label="Request type"
            value={tab.mode}
            options={MODE_OPTIONS}
            onChange={(mode) => setDynamoMode(tab.id, mode)}
          />
        </div>
        <Field label="Index">
          <select
            className="dyn-select"
            value={form.index}
            onChange={(event) => set({ index: event.target.value, rangeOp: "" })}
          >
            <option value="">Table</option>
            {indexes.map((index) => (
              <option key={index.name} value={index.name}>
                {index.name} · {index.kind.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        {tab.mode === "query" &&
          (description ? (
            <KeyConditions tab={tab} description={description} />
          ) : (
            <span className="dyn-form__muted">Loading keys…</span>
          ))}
        <span className="dyn-form__spacer" />
        <Field label="Limit">
          <input
            className="dyn-input dyn-input--narrow mono"
            inputMode="numeric"
            value={form.limit}
            onChange={(event) => set({ limit: event.target.value })}
          />
        </Field>
        <button type="submit" className="q-button q-button--primary" disabled={tab.running}>
          <Play size={12} strokeWidth={2.4} />
          Run
          <kbd className="q-kbd">{formatShortcut(APP_SHORTCUTS.run)}</kbd>
        </button>
      </div>
      <div className="dyn-form__row dyn-form__row--expr">
        <Field label="Filter" grow>
          <input
            className="dyn-input mono"
            placeholder="#s = :s AND attribute_exists(email)"
            value={form.filter}
            onChange={(event) => set({ filter: event.target.value })}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Field label="Names">
          <textarea
            className="dyn-input dyn-textarea mono"
            rows={2}
            placeholder="#s = status"
            value={form.names}
            onChange={(event) => set({ names: event.target.value })}
            spellCheck={false}
          />
        </Field>
        <Field label="Values">
          <textarea
            className="dyn-input dyn-textarea mono"
            rows={2}
            placeholder={':s = "open"'}
            value={form.values}
            onChange={(event) => set({ values: event.target.value })}
            spellCheck={false}
          />
        </Field>
      </div>
      <div className="run-line" data-running={tab.running || undefined} aria-hidden="true" />
    </form>
  )
}
