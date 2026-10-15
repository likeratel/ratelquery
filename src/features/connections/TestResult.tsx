import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react"
import type { TestState } from "../../state/connectionsStore"

export function TestResult({ test }: { test: TestState }) {
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
    return (
      <div className="conn-test" data-status="ok" role="status">
        <CircleCheck size={14} aria-hidden />
        <span>
          Connected in <span className="mono">{Math.round(test.latencyMs)} ms</span>
          {test.serverVersion && <span className="conn-test__detail"> · {test.serverVersion}</span>}
        </span>
      </div>
    )
  }
  return (
    <div className="conn-test" data-status="fail" role="alert">
      <CircleAlert size={14} aria-hidden />
      <span className="conn-test__text">
        {test.error.summary}
        {test.error.detail && <span className="conn-test__detail">{test.error.detail}</span>}
      </span>
    </div>
  )
}
