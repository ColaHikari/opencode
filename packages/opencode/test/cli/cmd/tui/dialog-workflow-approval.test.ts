import { describe, expect, it } from "bun:test"
import { approvalDecision } from "@/cli/cmd/tui/component/dialog-workflow-approval-helpers"

describe("workflow approval", () => {
  it("never → kein Dialog", () => {
    expect(approvalDecision({ mode: "never", alreadyApproved: false })).toBe("start")
  })
  it("first-run → Dialog nur ohne gespeicherte Zustimmung", () => {
    expect(approvalDecision({ mode: "first-run", alreadyApproved: false })).toBe("ask")
    expect(approvalDecision({ mode: "first-run", alreadyApproved: true })).toBe("start")
  })
  it("always → immer Dialog", () => {
    expect(approvalDecision({ mode: "always", alreadyApproved: true })).toBe("ask")
  })

  // Edge cases beyond the canonical matrix.
  it("never starts even when not yet approved", () => {
    expect(approvalDecision({ mode: "never", alreadyApproved: true })).toBe("start")
  })
  it("always asks even on the very first run", () => {
    expect(approvalDecision({ mode: "always", alreadyApproved: false })).toBe("ask")
  })
  it("defaults to first-run semantics when mode is undefined", () => {
    expect(approvalDecision({ mode: undefined, alreadyApproved: false })).toBe("ask")
    expect(approvalDecision({ mode: undefined, alreadyApproved: true })).toBe("start")
  })
})
