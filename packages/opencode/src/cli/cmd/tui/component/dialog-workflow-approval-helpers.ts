// Approval mode for interactive workflow starts. Mirrors the `workflows.approval`
// config literal: `first-run` (default) asks once per workflow until "Yes, always"
// persists consent; `always` asks on every start regardless of stored consent;
// `never` starts without ever prompting.
export type ApprovalMode = "always" | "first-run" | "never"

// Pure decision used by the prompt's start gate. `alreadyApproved` is whether the
// workflow's name is in the persisted `workflows.approved` list. The default
// (undefined mode) follows `first-run` so an unconfigured install still gates the
// first interactive start of each workflow.
export function approvalDecision(input: { mode: ApprovalMode | undefined; alreadyApproved: boolean }): "ask" | "start" {
  if (input.mode === "never") return "start"
  if (input.mode === "always") return "ask"
  // first-run (and the undefined default): ask until consent is persisted.
  return input.alreadyApproved ? "start" : "ask"
}
