import type { Event, WorkflowRun } from "@opencode-ai/sdk/v2"
import type { useSDK } from "@/context/sdk"

// Thin web-side layer over the generated v2 SDK workflow surface, ported from the
// TUI (`dialog-workflow-client.ts` + `dialog-workflow-question-helpers.ts`):
//   - asWorkflowRunEvent narrows the real Event union (no string/unknown casts);
//   - answerWorkflowRun maps the generated answer() result to a small union;
//   - questionOptions/selectedAnswer derive the answer-dialog option list.
// Pure + dependency-free so it is unit-testable.

export const WORKFLOW_RUN_UPDATED = "workflow.run.updated"
export const WORKFLOW_RUN_FINISHED = "workflow.run.finished"

export type WorkflowRunEventMember = Extract<
  Event,
  { type: typeof WORKFLOW_RUN_UPDATED | typeof WORKFLOW_RUN_FINISHED }
>

export type WorkflowRunEventData = WorkflowRunEventMember["properties"]

export type WorkflowRunEvent = {
  kind: "updated" | "finished"
  run: WorkflowRunEventData
}

// A run's pending question, derived from the generated WorkflowRun type so it
// tracks the SDK shape automatically.
export type PendingQuestion = NonNullable<WorkflowRun["pending_question"]>

// Narrows a raw SDK `Event` to a workflow run event when it carries one of the
// generated workflow.run.* members. A real discriminated-union check, so
// `event.properties` is the generated WorkflowRunEventData without a cast.
export function asWorkflowRunEvent(event: Event): WorkflowRunEvent | undefined {
  if (event.type !== WORKFLOW_RUN_UPDATED && event.type !== WORKFLOW_RUN_FINISHED) return undefined
  return {
    kind: event.type === WORKFLOW_RUN_FINISHED ? "finished" : "updated",
    run: event.properties,
  }
}

export type AnswerResult =
  | { type: "ok"; run: WorkflowRun }
  | { type: "not_found" }
  | { type: "no_question" }
  | { type: "error"; message: string }

export type AnswerInput = {
  id: string
  answer: string
  permissionSessionID?: string
}

// The slice of the SDK context this helper needs: the generated client (for the
// typed answer() method) and the active directory (forwarded as the directory
// query param, matching how the rest of the dashboard calls the client).
export type WorkflowAnswerClient = {
  client: ReturnType<typeof useSDK>["client"]
  directory?: string
}

// Calls the generated `sdk.client.workflow.answer` with only the set fields.
// Maps 200 → {run}, 404 → not_found, 409 → no_question, anything else (incl. a
// transport failure) → error.
export async function answerWorkflowRun(sdk: WorkflowAnswerClient, input: AnswerInput): Promise<AnswerResult> {
  const payload: { answer: string; permissionSessionID?: string } = { answer: input.answer }
  if (input.permissionSessionID !== undefined) payload.permissionSessionID = input.permissionSessionID
  try {
    const result = await sdk.client.workflow.answer({
      id: input.id,
      directory: sdk.directory,
      workflowAnswerPayload: payload,
    })
    if (result.data) return { type: "ok", run: result.data }
    const status = result.response.status
    if (status === 404) return { type: "not_found" }
    if (status === 409) return { type: "no_question" }
    return { type: "error", message: `unexpected status ${status}` }
  } catch (error) {
    return { type: "error", message: error instanceof Error ? error.message : String(error) }
  }
}

// One selectable entry in the question dialog: either a declared option or the
// trailing free-text sentinel (always last, so a question with no declared
// options still lets the operator type a custom answer).
export type QuestionOption = { kind: "option"; label: string } | { kind: "freetext"; label: string }

// Builds the option list for a pending question: each declared option becomes an
// `option` entry, and a single `freetext` entry is always appended so a custom
// answer is possible.
export function questionOptions(pq: PendingQuestion): QuestionOption[] {
  const declared: QuestionOption[] = (pq.options ?? []).map((label) => ({ kind: "option", label }))
  return [...declared, { kind: "freetext", label: "Type a custom answer" }]
}

// Resolves the answer string to submit from the current selection: an `option`
// selection returns its label (the free-text field is ignored), the `freetext`
// entry returns the trimmed typed text or `undefined` when empty. An out-of-range
// index returns `undefined`.
export function selectedAnswer(options: QuestionOption[], index: number, freetext: string): string | undefined {
  const selected = options[index]
  if (!selected) return undefined
  if (selected.kind === "option") return selected.label
  const trimmed = freetext.trim()
  return trimmed === "" ? undefined : trimmed
}

// Distinguishes a live answer (the run resolves IN PLACE — same id) from a
// parked-resume answer (answering a paused/parked run spawns a NEW resume run
// with a different id). The caller follows the new id into its detail view.
export function isResumeAnswer(sourceID: string, returnedRun: WorkflowRun): boolean {
  return returnedRun.id !== sourceID
}
