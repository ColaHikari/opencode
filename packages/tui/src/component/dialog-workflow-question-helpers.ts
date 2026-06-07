import type { WorkflowRun } from "@opencode-ai/sdk/v2"
import type { PendingQuestion } from "./dialog-workflow-client"

// One selectable entry in the question dialog: either a declared option or the
// trailing free-text sentinel (always last, so a question with no declared
// options still lets the operator type a custom answer).
export type QuestionOption = { kind: "option"; label: string } | { kind: "freetext"; label: string }

// Builds the option list for a pending question: each declared option becomes an
// `option` entry, and a single `freetext` entry is always appended so a custom
// answer is possible (Spec §5.2 (4): question + options + free text).
export function questionOptions(pq: PendingQuestion): QuestionOption[] {
  const declared: QuestionOption[] = (pq.options ?? []).map((label) => ({ kind: "option", label }))
  return [...declared, { kind: "freetext", label: "Type a custom answer" }]
}

// Resolves the answer string to submit from the current selection: an `option`
// selection returns its label (the free-text field is ignored), the `freetext`
// entry returns the trimmed typed text or `undefined` when empty (nothing to
// submit). An out-of-range index returns `undefined`.
export function selectedAnswer(options: QuestionOption[], index: number, freetext: string): string | undefined {
  const selected = options[index]
  if (!selected) return undefined
  if (selected.kind === "option") return selected.label
  const trimmed = freetext.trim()
  return trimmed === "" ? undefined : trimmed
}

// Distinguishes a live answer (the run is running and resolves IN PLACE — same
// id) from a parked-resume answer (the run was paused/parked and answering it
// spawns a NEW resume run with a different id; Phase-1 contract). The caller
// follows the new id into its detail view when this is true.
export function isResumeAnswer(sourceID: string, returnedRun: WorkflowRun): boolean {
  return returnedRun.id !== sourceID
}
