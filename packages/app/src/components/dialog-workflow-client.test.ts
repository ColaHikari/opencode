import { describe, expect, test } from "bun:test"
import { answerWorkflowRun, asWorkflowRunEvent, questionOptions, selectedAnswer } from "./dialog-workflow-client"

const fake = (data: unknown, status: number) =>
  ({
    client: { workflow: { answer: async () => ({ data, response: { status } }) } },
    directory: "/x",
  }) as any

describe("answerWorkflowRun status mapping", () => {
  test("maps 404 → not_found", async () => {
    expect(await answerWorkflowRun(fake(undefined, 404), { id: "r", answer: "y" })).toEqual({ type: "not_found" })
  })
  test("maps 409 → no_question", async () => {
    expect((await answerWorkflowRun(fake(undefined, 409), { id: "r", answer: "y" })).type).toBe("no_question")
  })
  test("maps 200 → ok with run", async () => {
    const run = { id: "r", workflow: "w", status: "running" as const, logs: [], agents: [], started_at: 0 }
    expect(await answerWorkflowRun(fake(run, 200), { id: "r", answer: "y" })).toEqual({ type: "ok", run })
  })
  test("maps an unexpected status → error", async () => {
    expect((await answerWorkflowRun(fake(undefined, 500), { id: "r", answer: "y" })).type).toBe("error")
  })
  test("a thrown transport failure → error", async () => {
    const throwing = {
      client: {
        workflow: {
          answer: async () => {
            throw new Error("boom")
          },
        },
      },
      directory: "/x",
    } as any
    const result = await answerWorkflowRun(throwing, { id: "r", answer: "y" })
    expect(result).toEqual({ type: "error", message: "boom" })
  })
})

describe("asWorkflowRunEvent narrowing", () => {
  test("narrows workflow.run.finished and updated", () => {
    expect(asWorkflowRunEvent({ type: "workflow.run.finished", id: "e", properties: { id: "r" } } as any)?.kind).toBe(
      "finished",
    )
    expect(asWorkflowRunEvent({ type: "workflow.run.updated", id: "e", properties: { id: "r" } } as any)?.kind).toBe(
      "updated",
    )
  })
  test("returns undefined for an unrelated event", () => {
    expect(asWorkflowRunEvent({ type: "session.status" } as any)).toBeUndefined()
  })
})

describe("questionOptions + selectedAnswer", () => {
  test("appends a free-text sentinel after declared options", () => {
    const out = questionOptions({ question: "q", options: ["a", "b"], asked_at: 1 })
    expect(out.map((o) => o.kind)).toEqual(["option", "option", "freetext"])
  })
  test("selectedAnswer returns the option label or the trimmed free text", () => {
    const opts = questionOptions({ question: "q", options: ["yes"], asked_at: 1 })
    expect(selectedAnswer(opts, 0, "ignored")).toBe("yes")
    expect(selectedAnswer(opts, 1, "  custom  ")).toBe("custom")
    expect(selectedAnswer(opts, 1, "   ")).toBeUndefined()
    expect(selectedAnswer(opts, 9, "x")).toBeUndefined()
  })
})
