import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import {
  answerWorkflowRun,
  asWorkflowRunEvent,
  type WorkflowRunEvent,
  type WorkflowRunWithQuestion,
} from "../../../../src/component/dialog-workflow-client"

describe("asWorkflowRunEvent", () => {
  test("narrows a workflow.run.finished wire payload not present in the SDK Event union", () => {
    // The SDK Event union has no workflow.run.* member (SDK not regenerated), so
    // the raw event arrives typed as `Event` but carries the wire shape. The
    // narrower recognizes it and exposes the typed RunEventData.
    const raw = {
      id: "evt_1",
      type: "workflow.run.finished",
      properties: {
        id: "job_x",
        workflow: "demo",
        status: "completed",
        directory: "/ws",
        agents: { total: 2, running: 0, failed: 0 },
        pending_question: false,
      },
    } as unknown as Event
    const narrowed = asWorkflowRunEvent(raw)
    expect(narrowed).toBeDefined()
    expect(narrowed!.kind).toBe("finished")
    expect(narrowed!.run.id).toBe("job_x")
    expect(narrowed!.run.status).toBe("completed")
    expect(narrowed!.run.pending_question).toBe(false)
  })

  test("recognizes updated events and exposes pending_question true", () => {
    const raw = {
      id: "evt_2",
      type: "workflow.run.updated",
      properties: {
        id: "job_q",
        workflow: "demo",
        status: "running",
        directory: "/ws",
        agents: { total: 1, running: 1, failed: 0 },
        pending_question: true,
      },
    } as unknown as Event
    const narrowed = asWorkflowRunEvent(raw)
    expect(narrowed!.kind).toBe("updated")
    expect(narrowed!.run.pending_question).toBe(true)
  })

  test("returns undefined for unrelated events", () => {
    const raw = { id: "e", type: "vcs.branch.updated", properties: { branch: "main" } } as unknown as Event
    expect(asWorkflowRunEvent(raw)).toBeUndefined()
  })
})

describe("answerWorkflowRun", () => {
  function fakeClient(handler: (path: string, init: RequestInit) => Response) {
    const calls: { path: string; body: unknown }[] = []
    const client = {
      // Mirrors the minimal surface the helper needs from the generated client's
      // request config: a fetch + the resolved baseUrl + the directory query.
      buildUrl: (p: string) => `http://test${p}?directory=%2Fws`,
      headers: { authorization: "Basic x" },
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ path: url, body: init.body ? JSON.parse(String(init.body)) : undefined })
        return handler(url, init)
      },
    }
    return { client, calls }
  }

  test("returns {run} on 200", async () => {
    const run = { id: "job_x", workflow: "demo", status: "running", started_at: 1, logs: [], agents: [] }
    const { client, calls } = fakeClient(() => new Response(JSON.stringify(run), { status: 200 }))
    const result = await answerWorkflowRun(client, { id: "job_x", answer: "yes", permissionSessionID: "ses_1" })
    expect(result.type).toBe("ok")
    expect(result.type === "ok" && result.run.id).toBe("job_x")
    expect(calls[0].body).toEqual({ answer: "yes", permissionSessionID: "ses_1" })
  })

  test("maps 404 to not_found and 409 to no_question", async () => {
    const c404 = fakeClient(() => new Response("{}", { status: 404 }))
    expect((await answerWorkflowRun(c404.client, { id: "job_x", answer: "y" })).type).toBe("not_found")
    const c409 = fakeClient(() => new Response("{}", { status: 409 }))
    expect((await answerWorkflowRun(c409.client, { id: "job_x", answer: "y" })).type).toBe("no_question")
  })
})

describe("WorkflowRunWithQuestion type", () => {
  test("carries an optional pending_question (compile-time check)", () => {
    const run: WorkflowRunWithQuestion = {
      id: "job_x",
      workflow: "demo",
      status: "paused",
      started_at: 1,
      logs: [],
      agents: [],
      pending_question: { question: "q?", options: ["a"], asked_at: 1 },
    } as WorkflowRunWithQuestion
    expect(run.pending_question?.question).toBe("q?")
  })

  test("WorkflowRunEvent kind union is updated|finished", () => {
    const e: WorkflowRunEvent = {
      kind: "updated",
      run: {
        id: "x",
        workflow: "demo",
        status: "running",
        directory: "/ws",
        agents: { total: 0, running: 0, failed: 0 },
        pending_question: false,
      },
    }
    expect(e.kind).toBe("updated")
  })
})
