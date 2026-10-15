import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { Button } from "../../components/ui"
import type { AthenaTestInfo } from "../../lib/connections"
import type { TestState } from "../../state/connectionsStore"
import type { FriendlyError } from "./errors"

interface TestResultProps {
  test: TestState
  /**
   * Creates the missing Athena result bucket and tests again. Resolves with the error to show,
   * or null on success. Called only from the Create bucket button.
   */
  onCreateBucket?: (bucket: string) => Promise<FriendlyError | null>
}

function FailLine({ error }: { error: FriendlyError }) {
  return (
    <span className="conn-test__text">
      {error.summary}
      {error.detail && <span className="conn-test__detail">{error.detail}</span>}
    </span>
  )
}

/** The default result bucket doesn't exist: asks before creating it in the user's account. */
function MissingBucket({
  bucket,
  onCreate,
}: {
  bucket: string
  onCreate?: (bucket: string) => Promise<FriendlyError | null>
}) {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<FriendlyError | null>(null)
  const create = async () => {
    if (!onCreate || creating) return
    setCreating(true)
    setError(null)
    const failure = await onCreate(bucket)
    setCreating(false)
    setError(failure)
  }
  return (
    <div className="conn-test" data-status="warn" role="status">
      <TriangleAlert size={14} aria-hidden />
      <span className="conn-test__text">
        <span>
          Bucket <span className="mono">s3://{bucket}/</span> doesn&apos;t exist. Create it?
        </span>
        <span className="conn-test__detail">
          Athena writes query results there. It is created in this region with public access
          blocked. Or set an output location under Advanced.
        </span>
        {error && (
          <span className="conn-test__detail" role="alert">
            {error.summary} {error.detail}
          </span>
        )}
        {onCreate && (
          <span className="conn-test__actions">
            <Button size="sm" onClick={() => void create()} disabled={creating}>
              {creating ? "Creating…" : "Create bucket"}
            </Button>
          </span>
        )}
      </span>
    </div>
  )
}

function AthenaDetail({ info }: { info: AthenaTestInfo }) {
  return (
    <span className="conn-test__detail">
      {" "}
      · Workgroup <span className="mono">{info.workgroup}</span>
      {info.outputLocation && (
        <>
          {" "}
          · Results in <span className="mono">{info.outputLocation}</span>
        </>
      )}
    </span>
  )
}

export function TestResult({ test, onCreateBucket }: TestResultProps) {
  if (test.status === "idle") return null
  if (test.status === "testing") {
    return (
      <div className="conn-test" data-status="testing" role="status">
        <LoaderCircle size={14} className="conn-spin" aria-hidden />
        Testing connection…
      </div>
    )
  }
  if (test.status === "ok") {
    const missing = test.athena?.missingBucket ?? null
    return (
      <>
        <div className="conn-test" data-status="ok" role="status">
          <CircleCheck size={14} aria-hidden />
          <span>
            Connected in <span className="mono">{Math.round(test.latencyMs)} ms</span>
            {test.serverVersion && (
              <span className="conn-test__detail"> · {test.serverVersion}</span>
            )}
            {test.athena && <AthenaDetail info={test.athena} />}
          </span>
        </div>
        {missing && <MissingBucket key={missing} bucket={missing} onCreate={onCreateBucket} />}
      </>
    )
  }
  return (
    <div className="conn-test" data-status="fail" role="alert">
      <CircleAlert size={14} aria-hidden />
      <FailLine error={test.error} />
    </div>
  )
}
