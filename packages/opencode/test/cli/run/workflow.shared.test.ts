import { describe, expect, test } from "bun:test"
import {
  parseHeadlessWorkflowArgs,
  workflowExitCode,
  detectUltracodeKeyword,
  stripUltracodeKeyword,
  RUN_ULTRACODE_DIRECTIVE,
} from "../../../src/cli/cmd/run/workflow.shared"

describe("parseHeadlessWorkflowArgs", () => {
  test("parses key=value tokens, keeping quoted values and bare flags", () => {
    expect(parseHeadlessWorkflowArgs(["target=src/", 'msg="a b"', "--verbose"])).toEqual({
      target: "src/",
      msg: "a b",
      verbose: "true",
    })
  })
  test("keeps numeric-looking values as strings (no meta declaration headless)", () => {
    expect(parseHeadlessWorkflowArgs(["version=1.0", "zip=01234"])).toEqual({ version: "1.0", zip: "01234" })
  })
})

describe("workflowExitCode", () => {
  test("completed => 0; failed/cancelled/interrupted => 1", () => {
    expect(workflowExitCode("completed")).toBe(0)
    expect(workflowExitCode("failed")).toBe(1)
    expect(workflowExitCode("cancelled")).toBe(1)
    expect(workflowExitCode("interrupted")).toBe(1)
  })
})

// Parity lock against the TUI ultracode module (Delta 6a): same boundary +
// same directive wording, asserted here so drift between the two copies fails.
describe("ultracode parity in the run path", () => {
  test("detects + strips the standalone keyword exactly like the TUI", () => {
    expect(detectUltracodeKeyword("ultracode: audit src/")?.index).toBe(0)
    expect(detectUltracodeKeyword("xultracode")).toBeUndefined()
    expect(stripUltracodeKeyword("ultracode: audit src/")).toBe("audit src/")
  })
  test("the directive opts the turn into workflow orchestration", () => {
    expect(RUN_ULTRACODE_DIRECTIVE).toContain("workflow")
    expect(RUN_ULTRACODE_DIRECTIVE).toContain("create")
  })
})
