import { useEffect, useState } from "react"
import { connectionsApi } from "../../lib/connections"
import type { AwsProfilesState } from "./awsProfiles"

/**
 * Loads the AWS profiles once per mount (the dialog opening). A failure only switches the
 * Profile field to its text fallback, so the error itself is not surfaced further.
 */
export function useAwsProfiles(): AwsProfilesState {
  const [state, setState] = useState<AwsProfilesState>({ status: "loading" })
  useEffect(() => {
    let active = true
    connectionsApi.awsProfiles().then(
      (profiles) => {
        if (active) setState({ status: "ready", profiles })
      },
      () => {
        if (active) setState({ status: "failed" })
      },
    )
    return () => {
      active = false
    }
  }, [])
  return state
}
