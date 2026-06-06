import { describe, expect, test } from "bun:test"
import {
  agentEffectiveEnd,
  agentEffectiveStatus,
  phaseStatus,
} from "../../../../src/cli/cmd/tui/component/dialog-workflow"
import type { WorkflowRun } from "@opencode-ai/sdk/v2"

// Minimal WorkflowRun builder for the pure phase/agent derivations under test.
// Only the fields these functions read are set; the cast keeps the test focused
// on logic, not on the full SDK shape (mirrors the other pure TUI helper tests).
function makeRun(input: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: "job_test",
    workflow: "demo",
    status: "running",
    started_at: 1_000,
    logs: [],
    agents: [],
    ...input,
  } as WorkflowRun
}

function makeAgent(input: Partial<WorkflowRun["agents"][number]>): WorkflowRun["agents"][number] {
  return { id: "1", status: "running", started_at: 1_000, prompt: "p", ...input } as WorkflowRun["agents"][number]
}

describe("phaseStatus (N5)", () => {
  const phases = ["a", "b", "c"]

  test("a completed run that stopped on a non-last phase reports later phases as skipped, never pending", () => {
    const run = makeRun({ status: "completed", completed_at: 2_000, current_phase: "a" })
    // The phase the run stopped on and everything before it is completed.
    expect(phaseStatus(run, phases, "a")).toBe("completed")
    // Phases the run never reached are `skipped` (the N5 fix), NOT `pending`.
    expect(phaseStatus(run, phases, "b")).toBe("skipped")
    expect(phaseStatus(run, phases, "c")).toBe("skipped")
  })

  test("a completed run that walked every phase reports all completed", () => {
    const run = makeRun({ status: "completed", completed_at: 2_000, current_phase: "c" })
    expect(phaseStatus(run, phases, "a")).toBe("completed")
    expect(phaseStatus(run, phases, "b")).toBe("completed")
    expect(phaseStatus(run, phases, "c")).toBe("completed")
  })

  test("a running run still reports unreached phases as pending (live behavior unchanged)", () => {
    const run = makeRun({ status: "running", current_phase: "a" })
    expect(phaseStatus(run, phases, "a")).toBe("running")
    expect(phaseStatus(run, phases, "b")).toBe("pending")
    expect(phaseStatus(run, phases, "c")).toBe("pending")
  })

  test("a failed run marks the failing phase with its status and never-reached phases as skipped", () => {
    const run = makeRun({ status: "failed", completed_at: 2_000, current_phase: "b" })
    expect(phaseStatus(run, phases, "a")).toBe("completed")
    expect(phaseStatus(run, phases, "b")).toBe("failed")
    expect(phaseStatus(run, phases, "c")).toBe("skipped")
  })
})

describe("agent terminal rendering (Fund 34)", () => {
  test("a lingering running agent on a terminal run renders as failed, not live", () => {
    const run = makeRun({ status: "completed", completed_at: 5_000 })
    const agent = makeAgent({ status: "running" })
    expect(agentEffectiveStatus(run, agent)).toBe("failed")
  })

  test("a genuinely running agent on a live run still renders as running", () => {
    const run = makeRun({ status: "running" })
    const agent = makeAgent({ status: "running" })
    expect(agentEffectiveStatus(run, agent)).toBe("running")
  })

  test("a lingering running agent's elapsed end clamps to the run completion, not Date.now()", () => {
    const run = makeRun({ status: "completed", completed_at: 5_000 })
    const agent = makeAgent({ status: "running", started_at: 1_000 })
    expect(agentEffectiveEnd(run, agent)).toBe(5_000)
  })

  test("a node's own completed_at always wins over the run clamp", () => {
    const run = makeRun({ status: "completed", completed_at: 9_000 })
    const agent = makeAgent({ status: "completed", started_at: 1_000, completed_at: 3_000 })
    expect(agentEffectiveEnd(run, agent)).toBe(3_000)
  })

  test("a running agent on a live run has no clamped end (still ticking)", () => {
    const run = makeRun({ status: "running" })
    const agent = makeAgent({ status: "running" })
    expect(agentEffectiveEnd(run, agent)).toBeUndefined()
  })
})
