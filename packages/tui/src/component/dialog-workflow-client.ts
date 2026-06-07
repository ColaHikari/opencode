import type { Event, WorkflowRun } from "@opencode-ai/sdk/v2"
import type { useSDK } from "../context/sdk"

// DELTA (Phase-1+T2 grounding, 2026-06-07): answerWorkflowRun + asWorkflowRunEvent
// + WorkflowRunWithQuestion are TRANSITIONAL SHIMS until the Phase-3 SDK regen.
// The generated SDK was NOT regenerated since Phase 1, so:
//   - the `Event` union has no `workflow.run.updated`/`workflow.run.finished`
//     member (they are LIVE on the wire via WORKFLOWSVC EventV2.define, but not
//     in types.gen.ts) — asWorkflowRunEvent narrows the raw payload by string;
//   - `WorkflowRun` has no `pending_question` field (server `Run` carries it) —
//     WorkflowRunWithQuestion patches it in;
//   - there is no `sdk.client.workflow.answer` method — answerWorkflowRun is a
//     minimal typed fetch helper against the LIVE `POST /workflow/run/:id/answer`.
// After the Phase-3 regen, `sdk.client.workflow.answer` / the typed Event union /
// `WorkflowRun.pending_question` deliver the same natively — DELETE this layer then.

export const WORKFLOW_RUN_UPDATED = "workflow.run.updated"
export const WORKFLOW_RUN_FINISHED = "workflow.run.finished"

// The wire shape of a workflow.run.updated/finished event's `properties`
// (Phase-1 contract; WORKFLOWSVC EventV2.define). Not present in the SDK type.
export type WorkflowRunEventData = {
  id: string
  workflow: string
  status: WorkflowRun["status"]
  current_phase?: string
  directory: string
  agents: { total: number; running: number; failed: number }
  pending_question: boolean
  error?: string
}

export type WorkflowRunEvent = {
  kind: "updated" | "finished"
  run: WorkflowRunEventData
}

// A run's pending question (Phase-1 contract: server `Run.pending_question`).
export type PendingQuestion = {
  question: string
  options?: string[]
  asked_at: number
}

// WorkflowRun augmented with the pending_question field the server sends on the
// wire but the SDK type omits.
export type WorkflowRunWithQuestion = WorkflowRun & {
  pending_question?: PendingQuestion
}

// Narrows a raw SDK `Event` to a workflow run event when it carries one of the
// workflow.run.* wire types. The SDK Event union literal set does not include
// these members, so the comparison is against the string constants and the
// payload is cast to the known wire shape.
export function asWorkflowRunEvent(event: Event): WorkflowRunEvent | undefined {
  const type = event.type as string
  if (type !== WORKFLOW_RUN_UPDATED && type !== WORKFLOW_RUN_FINISHED) return undefined
  return {
    kind: type === WORKFLOW_RUN_FINISHED ? "finished" : "updated",
    run: (event as { properties: unknown }).properties as WorkflowRunEventData,
  }
}

export type AnswerResult =
  | { type: "ok"; run: WorkflowRunWithQuestion }
  | { type: "not_found" }
  | { type: "no_question" }
  | { type: "error"; message: string }

// The minimal surface answerWorkflowRun needs from the generated client: a way to
// build the full URL for a path, the resolved headers, and the fetch impl. The
// real adapter (workflowClientFromSdk) reads these from the SDK client internals;
// the unit test fakes it directly.
export type WorkflowFetchClient = {
  buildUrl: (path: string) => string
  headers: HeadersInit | undefined
  fetch: (url: string, init: RequestInit) => Promise<Response>
}

export type AnswerInput = {
  id: string
  answer: string
  permissionSessionID?: string
}

// Calls the LIVE `POST /workflow/run/:id/answer` route (T2-merged) with a JSON
// body of only the set fields. Maps 200 -> {run}, 404 -> not_found,
// 409 -> no_question, anything else -> error.
export async function answerWorkflowRun(client: WorkflowFetchClient, input: AnswerInput): Promise<AnswerResult> {
  const body: { answer: string; permissionSessionID?: string } = { answer: input.answer }
  if (input.permissionSessionID !== undefined) body.permissionSessionID = input.permissionSessionID
  try {
    const response = await client.fetch(client.buildUrl(`/workflow/run/${input.id}/answer`), {
      method: "POST",
      headers: { ...(client.headers as Record<string, string> | undefined), "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (response.status === 200) {
      const run = (await response.json()) as WorkflowRunWithQuestion
      return { type: "ok", run }
    }
    if (response.status === 404) return { type: "not_found" }
    if (response.status === 409) return { type: "no_question" }
    return { type: "error", message: `unexpected status ${response.status}` }
  } catch (error) {
    return { type: "error", message: error instanceof Error ? error.message : String(error) }
  }
}

// Adapter from the live SDK context to the WorkflowFetchClient abstraction. NOT
// unit-tested (it reads the SDK context fields); the unit tests fake the
// WorkflowFetchClient directly. The SDK context exposes the server `url`, the
// active `directory`, and the `fetch` impl directly. The POST route is not a GET
// so the generated client's rewrite interceptor would NOT lift the directory
// into the query string anyway — we add `?directory=` ourselves (URI-encoded)
// to match the GET behavior the server expects for directory routing.
export function workflowClientFromSdk(sdk: ReturnType<typeof useSDK>): WorkflowFetchClient {
  const baseUrl = sdk.url
  const directory = sdk.directory
  const fetchImpl = sdk.fetch as WorkflowFetchClient["fetch"]
  return {
    buildUrl: (path) => {
      const url = `${baseUrl}${path}`
      return directory ? `${url}?directory=${encodeURIComponent(directory)}` : url
    },
    headers: undefined,
    fetch: (url, init) => fetchImpl(url, init),
  }
}
