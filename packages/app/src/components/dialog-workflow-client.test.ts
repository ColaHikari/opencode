import { describe, expect, test } from "bun:test"
import {
  answerWorkflowRun,
  asWorkflowRunEvent,
  questionOptions,
  saveWorkflowPayload,
  saveWorkflowRun,
  selectedAnswer,
} from "./dialog-workflow-client"

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

describe("saveWorkflowPayload", () => {
  test("omits scope when unset so the server default (project) applies", () => {
    expect(saveWorkflowPayload({ name: "n", source: "s" })).toEqual({ name: "n", source: "s" })
  })
  test("includes scope when explicitly project/global", () => {
    expect(saveWorkflowPayload({ name: "n", source: "s", scope: "global" })).toEqual({
      name: "n",
      source: "s",
      scope: "global",
    })
    expect(saveWorkflowPayload({ name: "n", source: "s", scope: "project" }).scope).toBe("project")
  })
})

describe("saveWorkflowRun status mapping", () => {
  // The raw-transport fallback: `workflow.post` returns { data, response }.
  const fakePost = (data: unknown, status: number) =>
    ({
      client: { workflow: { post: async () => ({ data, response: { status } }) } },
      directory: "/x",
    }) as any

  test("maps 200 + path → ok", async () => {
    expect(
      await saveWorkflowRun(fakePost({ path: "/p/.opencode/workflows/n.ts" }, 200), { name: "n", source: "s" }),
    ).toEqual({
      type: "ok",
      path: "/p/.opencode/workflows/n.ts",
    })
  })
  test("maps 409 → conflict", async () => {
    expect((await saveWorkflowRun(fakePost(undefined, 409), { name: "n", source: "s" })).type).toBe("conflict")
  })
  test("maps 400 → invalid", async () => {
    expect((await saveWorkflowRun(fakePost(undefined, 400), { name: "n", source: "s" })).type).toBe("invalid")
  })
  test("maps an unexpected status → error", async () => {
    expect((await saveWorkflowRun(fakePost(undefined, 500), { name: "n", source: "s" })).type).toBe("error")
  })
  test("a thrown transport failure → error", async () => {
    const throwing = {
      client: {
        workflow: {
          post: async () => {
            throw new Error("boom")
          },
        },
      },
      directory: "/x",
    } as any
    expect(await saveWorkflowRun(throwing, { name: "n", source: "s" })).toEqual({ type: "error", message: "boom" })
  })
  test("prefers the generated save() method when present", async () => {
    let used = ""
    const withSave = {
      client: {
        workflow: {
          save: async () => {
            used = "save"
            return { data: { path: "/p/n.ts" }, response: { status: 200 } }
          },
          post: async () => {
            used = "post"
            return { data: { path: "/wrong" }, response: { status: 200 } }
          },
        },
      },
      directory: "/x",
    } as any
    const result = await saveWorkflowRun(withSave, { name: "n", source: "s", scope: "global" })
    expect(result).toEqual({ type: "ok", path: "/p/n.ts" })
    expect(used).toBe("save")
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
