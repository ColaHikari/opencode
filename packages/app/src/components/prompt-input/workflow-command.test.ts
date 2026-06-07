import { describe, expect, test } from "bun:test"
import {
  parseWorkflowArgs,
  parseWorkflowCommand,
  sanitizeWorkflowFilename,
  workflowCommandOptions,
} from "./workflow-command"
import type { WorkflowInfo } from "@opencode-ai/sdk/v2"

const wf = (name: string, valid = true): WorkflowInfo => ({
  name,
  path: `/${name}.ts`,
  valid,
  meta: { name, description: `${name} desc` },
})

describe("parseWorkflowCommand", () => {
  test("/workflows opens dashboard", () => expect(parseWorkflowCommand("/workflows")).toEqual({ type: "dashboard" }))
  test("/workflow with no name opens dashboard", () =>
    expect(parseWorkflowCommand("/workflow")).toEqual({ type: "dashboard" }))
  test("/workflow <name> starts and keeps raw args", () =>
    expect(parseWorkflowCommand('/workflow review msg="a  b"')).toEqual({
      type: "start",
      name: "review",
      args: 'msg="a  b"',
    }))
  test("non-workflow input returns undefined", () => expect(parseWorkflowCommand("/share")).toBeUndefined())
})

describe("parseWorkflowArgs", () => {
  test("coerces declared-number, keeps undeclared strings", () => {
    expect(parseWorkflowArgs("count=3 version=1.0", { count: { type: "number" } })).toEqual({
      count: 3,
      version: "1.0",
    })
  })
  test("keeps quoted value with spaces intact", () =>
    expect(parseWorkflowArgs('msg="a b"', {})).toEqual({ msg: "a b" }))
})

describe("workflowCommandOptions", () => {
  test("drops invalid workflows and command-name collisions", () => {
    const out = workflowCommandOptions([wf("review"), wf("broken", false), wf("share")], new Set(["share"]))
    expect(out.map((o) => o.name)).toEqual(["review"])
  })
  test("carries the workflow description", () => {
    const out = workflowCommandOptions([wf("review")], new Set())
    expect(out[0]?.description).toBe("review desc")
  })
})

describe("sanitizeWorkflowFilename", () => {
  test("rejects traversal/separators, accepts a clean segment", () => {
    expect(sanitizeWorkflowFilename(" review ")).toBe("review")
    expect(sanitizeWorkflowFilename("a/b")).toBeUndefined()
    expect(sanitizeWorkflowFilename("..")).toBeUndefined()
  })
})
