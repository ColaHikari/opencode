import { describe, expect, test } from "bun:test"
import {
  formatPhase,
  formatShortElapsed,
  parseWorkflowCommand,
  phaseIcon,
  phaseStatus,
  reanchorSelection,
  spentThisMonth,
  statusIcon,
} from "../../../../src/cli/cmd/tui/component/dialog-workflow-helpers"
import type { WorkflowInfo, WorkflowRun } from "@opencode-ai/sdk/v2"

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

describe("statusIcon (Fund 32, 33 — all five status)", () => {
  test("each status maps to a distinct glyph", () => {
    const icons = new Set([
      statusIcon("running"),
      statusIcon("completed"),
      statusIcon("failed"),
      statusIcon("cancelled"),
      statusIcon("interrupted"),
    ])
    // Fund 32: cancelled gets its own glyph, so all five are distinct.
    expect(icons.size).toBe(5)
  })

  test("cancelled has a glyph different from interrupted and the hollow pending marker", () => {
    expect(statusIcon("cancelled")).not.toBe(statusIcon("interrupted"))
    expect(statusIcon("cancelled")).not.toBe("◌")
  })
})

describe("phaseIcon", () => {
  test("renders each phase status distinctly except pending/skipped (both hollow)", () => {
    expect(phaseIcon("completed")).toBe("✔")
    expect(phaseIcon("running")).toBe("●")
    expect(phaseIcon("failed")).toBe("✖")
    expect(phaseIcon("interrupted")).toBe("⊘")
    expect(phaseIcon("cancelled")).toBe(statusIcon("cancelled"))
    expect(phaseIcon("pending")).toBe("◌")
    expect(phaseIcon("skipped")).toBe("◌")
  })
})

describe("phaseStatus (N5)", () => {
  const phases = ["a", "b", "c"]

  test("a completed run that stopped on a non-last phase reports later phases as skipped, never pending", () => {
    const run = makeRun({ status: "completed", completed_at: 2_000, current_phase: "a" })
    expect(phaseStatus(run, phases, "a")).toBe("completed")
    expect(phaseStatus(run, phases, "b")).toBe("skipped")
    expect(phaseStatus(run, phases, "c")).toBe("skipped")
  })

  test("a running run still reports unreached phases as pending", () => {
    const run = makeRun({ status: "running", current_phase: "a" })
    expect(phaseStatus(run, phases, "a")).toBe("running")
    expect(phaseStatus(run, phases, "b")).toBe("pending")
  })

  test("a cancelled run marks the stopped phase cancelled and later phases skipped", () => {
    const run = makeRun({ status: "cancelled", completed_at: 2_000, current_phase: "b" })
    expect(phaseStatus(run, phases, "a")).toBe("completed")
    expect(phaseStatus(run, phases, "b")).toBe("cancelled")
    expect(phaseStatus(run, phases, "c")).toBe("skipped")
  })
})

describe("formatShortElapsed", () => {
  test("undefined start renders the placeholder", () => {
    expect(formatShortElapsed(undefined)).toBe("--")
  })

  test("string NaN timestamps render the placeholder", () => {
    expect(formatShortElapsed("NaN")).toBe("--")
  })

  test("numeric string timestamps are parsed", () => {
    expect(formatShortElapsed("1000", 4_000)).toBe("3s")
  })

  test("uses the injected now when there is no completion", () => {
    expect(formatShortElapsed(1_000, undefined, 4_000)).toBe("3s")
  })

  test("clamps to completed_at instead of ticking with now", () => {
    // completed_at is in the past relative to now; the elapsed must freeze at it.
    expect(formatShortElapsed(1_000, 5_000, 999_999)).toBe("4s")
  })

  test("never goes negative", () => {
    expect(formatShortElapsed(5_000, 1_000)).toBe("0s")
  })

  test("formats minutes and hours", () => {
    expect(formatShortElapsed(0, 90_000)).toBe("1m30s")
    expect(formatShortElapsed(0, 3_660_000)).toBe("1h01m")
  })
})

describe("formatPhase (Fund 33 — [?/N])", () => {
  const workflow = { meta: { phases: ["a", "b", "c"] } } as unknown as WorkflowInfo

  test("terminal run is complete", () => {
    expect(formatPhase(makeRun({ status: "completed" }), workflow)).toBe("[---] complete")
  })

  test("running run with known phase shows [index/total]", () => {
    expect(formatPhase(makeRun({ status: "running", current_phase: "b" }), workflow)).toBe("[2/3] b")
  })

  test("running run on an unknown phase shows [?/total]", () => {
    expect(formatPhase(makeRun({ status: "running", current_phase: "zzz" }), workflow)).toBe("[?/3] zzz")
  })

  test("running run with no phases declared falls back to the current phase", () => {
    expect(formatPhase(makeRun({ status: "running", current_phase: "x" }), undefined)).toBe("x")
  })
})

describe("spentThisMonth (month boundary, undefined-cost agents)", () => {
  test("sums only runs started this month and tolerates undefined agent cost", () => {
    const now = new Date(2026, 5, 15).getTime()
    const monthStart = new Date(2026, 5, 3).getTime()
    const lastMonth = new Date(2026, 4, 20).getTime()
    const runs = [
      makeRun({ started_at: monthStart, agents: [makeAgent({ cost: 1.5 }), makeAgent({ cost: undefined })] }),
      makeRun({ started_at: lastMonth, agents: [makeAgent({ cost: 99 })] }),
    ]
    expect(spentThisMonth(runs, now)).toBeCloseTo(1.5, 5)
  })

  test("string-NaN started_at is excluded", () => {
    const now = new Date(2026, 5, 15).getTime()
    const runs = [makeRun({ started_at: "NaN", agents: [makeAgent({ cost: 5 })] })]
    expect(spentThisMonth(runs, now)).toBe(0)
  })
})

describe("reanchorSelection (Fund 10 — selection follows run.id across re-sort)", () => {
  const rows = [makeRun({ id: "job_a" }), makeRun({ id: "job_b" }), makeRun({ id: "job_c" })]

  test("returns the index of the row that still carries the previous id", () => {
    expect(reanchorSelection("job_c", rows)).toBe(2)
  })

  test("clamps to the last row when the previous id is gone", () => {
    expect(reanchorSelection("job_gone", rows)).toBe(2)
  })

  test("returns 0 for an empty list", () => {
    expect(reanchorSelection("job_a", [])).toBe(0)
  })

  test("returns 0 when no previous id is anchored", () => {
    expect(reanchorSelection(undefined, rows)).toBe(0)
  })
})

describe("parseWorkflowCommand (Fund 59 — dispatch, Fund 60 — raw remainder)", () => {
  test("/workflows opens the dashboard", () => {
    expect(parseWorkflowCommand("/workflows")).toEqual({ type: "dashboard" })
  })

  test("/workflows with trailing args still opens the dashboard (never a start)", () => {
    expect(parseWorkflowCommand("/workflows foo")).toEqual({ type: "dashboard" })
  })

  test("/workflow with no name opens the dashboard", () => {
    expect(parseWorkflowCommand("/workflow")).toEqual({ type: "dashboard" })
    expect(parseWorkflowCommand("/workflow   ")).toEqual({ type: "dashboard" })
  })

  test("/workflow <name> starts the named workflow", () => {
    expect(parseWorkflowCommand("/workflow review")).toEqual({ type: "start", name: "review", args: "" })
  })

  test("the remainder is the raw substring, preserving multiple spaces (Fund 60)", () => {
    expect(parseWorkflowCommand('/workflow flow msg="hello   world"')).toEqual({
      type: "start",
      name: "flow",
      args: 'msg="hello   world"',
    })
  })

  test("only the first line drives the command", () => {
    expect(parseWorkflowCommand("/workflow flow a=1\nsecond line")).toEqual({
      type: "start",
      name: "flow",
      args: "a=1",
    })
  })

  test("non-workflow input is not a workflow command", () => {
    expect(parseWorkflowCommand("/help")).toBeUndefined()
    expect(parseWorkflowCommand("hello")).toBeUndefined()
  })
})
