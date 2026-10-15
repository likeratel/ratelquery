import { Cloud, Database } from "lucide-react"
import { useId, useState, type FormEvent } from "react"
import { Button, Dialog, SegmentedControl, showToast } from "../../components/ui"
import type { ConnectionConfig } from "../../lib/connections"
import { useConnectionsStore } from "../../state/connectionsStore"
import { DynamoFields } from "./DynamoFields"
import {
  emptyForm,
  formFromConfig,
  parseForm,
  type ConnectionForm,
  type ConnectionKind,
  type DynamoDraft,
  type FieldErrors,
  type MysqlDraft,
} from "./form"
import { MysqlFields } from "./MysqlFields"
import { TestResult } from "./TestResult"

/** Mounts the connection dialog while the store says it is open. */
export function ConnectionDialog() {
  const open = useConnectionsStore((s) => s.dialog.open)
  const session = useConnectionsStore((s) => s.dialog.session)
  const editing = useConnectionsStore((s) => s.dialog.editing)
  if (!open) return null
  return <ConnectionDialogContent key={session} editing={editing} />
}

function withoutKeys(errors: FieldErrors, keys: readonly string[]): FieldErrors {
  return Object.fromEntries(Object.entries(errors).filter(([key]) => !keys.includes(key)))
}

function kindOptions(editing: ConnectionConfig | null) {
  return [
    {
      value: "mysql",
      label: (
        <>
          <Database size={13} aria-hidden /> MySQL
        </>
      ),
      disabled: editing !== null && editing.kind !== "mysql",
    },
    {
      value: "dynamodb",
      label: (
        <>
          <Cloud size={13} aria-hidden /> DynamoDB
        </>
      ),
      disabled: editing !== null && editing.kind !== "dynamodb",
    },
  ] as const
}

function ConnectionDialogContent({ editing }: { editing: ConnectionConfig | null }) {
  const formId = useId()
  const [form, setForm] = useState<ConnectionForm>(() =>
    editing ? formFromConfig(editing) : emptyForm(),
  )
  const [errors, setErrors] = useState<FieldErrors>({})
  const hasStoredSecret = useConnectionsStore((s) => s.dialog.hasStoredSecret)
  const test = useConnectionsStore((s) => s.test)
  const saving = useConnectionsStore((s) => s.saving)
  const saveError = useConnectionsStore((s) => s.saveError)
  const { closeDialog, save, testConnection, resetTest } = useConnectionsStore.getState()

  const context = { original: editing ?? undefined, hasStoredSecret }
  const secretOptional =
    editing?.kind === "dynamodb" && editing.auth.type === "keys" && hasStoredSecret

  const touch = (keys: readonly string[]) => {
    setErrors((current) => withoutKeys(current, keys))
    if (useConnectionsStore.getState().test.status !== "idle") resetTest()
  }
  const updateMysql = (patch: Partial<MysqlDraft>) => {
    setForm((current) => ({ ...current, mysql: { ...current.mysql, ...patch } }))
    touch(Object.keys(patch))
  }
  const updateDynamo = (patch: Partial<DynamoDraft>) => {
    setForm((current) => ({ ...current, dynamodb: { ...current.dynamodb, ...patch } }))
    touch(Object.keys(patch))
  }
  const changeKind = (kind: ConnectionKind) => {
    setForm((current) => ({ ...current, kind }))
    setErrors({})
    resetTest()
  }

  const validate = () => {
    const result = parseForm(form, context)
    setErrors(result.ok ? {} : result.errors)
    return result.ok ? result : null
  }

  const onTest = () => {
    const parsed = validate()
    if (parsed) void testConnection(parsed.config, parsed.secret)
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const parsed = validate()
    if (!parsed || saving) return
    const result = await save(parsed.config, parsed.secret)
    if (result.ok) showToast({ tone: "success", message: `Saved ${result.value.name}` })
  }

  return (
    <Dialog
      title={editing ? "Edit connection" : "New connection"}
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={onTest} disabled={test.status === "testing"}>
            Test connection
          </Button>
          <span className="conn-form__spacer" />
          <Button variant="ghost" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form id={formId} className="conn-form" onSubmit={onSubmit} noValidate>
        <SegmentedControl<ConnectionKind>
          label="Database type"
          value={form.kind}
          options={kindOptions(editing)}
          onChange={changeKind}
        />
        {form.kind === "mysql" ? (
          <MysqlFields
            draft={form.mysql}
            errors={errors}
            editing={editing !== null}
            hasStoredSecret={hasStoredSecret}
            onChange={updateMysql}
          />
        ) : (
          <DynamoFields
            draft={form.dynamodb}
            errors={errors}
            secretOptional={secretOptional}
            onChange={updateDynamo}
          />
        )}
        <TestResult test={test} />
        {saveError && (
          <div className="conn-test" data-status="fail" role="alert">
            <span className="conn-test__text">
              {saveError.summary}
              {saveError.detail && <span className="conn-test__detail">{saveError.detail}</span>}
            </span>
          </div>
        )}
      </form>
    </Dialog>
  )
}
