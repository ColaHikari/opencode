import type { WorkflowInfo, WorkflowRun } from "@opencode-ai/sdk/v2"

// The engine persists timestamps as numbers, but the SDK schema widens them to
// include stringified non-finite sentinels ("NaN"/"Infinity"). Normalize any of
// those — plus genuine numeric strings — to a finite number or `undefined`.
export function timestamp(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

export function statusIcon(status: WorkflowRun["status"]) {
  if (status === "running") return "●"
  if (status === "completed") return "✔"
  if (status === "failed") return "✖"
  // Fund 32: `cancelled` (a user-requested kill) now reads apart from every
  // other terminal state with its own crossed-circle glyph; previously it fell
  // through to the hollow pending marker `◌` and looked unfinished.
  if (status === "cancelled") return "⊗"
  // `interrupted` is a failure-like terminal state (orphaned/zombie run), shown
  // with a distinct broken-circle marker so it reads apart from a clean cancel.
  if (status === "interrupted") return "⊘"
  return "◌"
}

// N5: the engine never advances/clears `current_phase` at completion (only
// `setPhase` writes it), so a run that finished on a non-last declared phase
// (common: meta.phases declares more phases than the body walks) left every
// later phase rendering as `pending` forever on a terminal run. A terminal run
// will NEVER reach those phases, so they are reported `skipped` (a distinct,
// non-live rendering) rather than the misleading `pending`. This is purely a
// derived TUI view — the engine row is untouched, so the persisted lifecycle
// stays honest (no synthetic "current_phase = last" lie).
export function phaseStatus(run: WorkflowRun, phases: readonly string[], phase: string) {
  const current = run.current_phase ? phases.indexOf(run.current_phase) : -1
  const index = phases.indexOf(phase)
  if (run.status === "running") {
    if (index < current) return "completed"
    if (index === current) return "running"
    return "pending"
  }
  if (index < current || (run.status === "completed" && (current === -1 || index <= current))) return "completed"
  if (index === current) return run.status
  // A phase after the one the terminal run stopped on was never reached.
  return "skipped"
}

export function phaseIcon(status: ReturnType<typeof phaseStatus>) {
  if (status === "completed") return "✔"
  if (status === "running") return "●"
  if (status === "failed") return "✖"
  if (status === "cancelled") return statusIcon("cancelled")
  if (status === "interrupted") return "⊘"
  // `skipped` (never-reached phase on a terminal run) and `pending` both read as
  // the hollow marker — neither is live; `skipped` simply will never advance.
  return "◌"
}

// `now` is injected so the duration is deterministic in tests and frozen on a
// terminal run. On a live run the caller passes `Date.now()` so it keeps ticking.
export function formatShortElapsed(started_at: unknown, completed_at?: unknown, now: number = Date.now()) {
  const start = timestamp(started_at)
  if (start === undefined) return "--"
  const seconds = Math.max(0, Math.floor(((timestamp(completed_at) ?? now) - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${(seconds % 60).toString().padStart(2, "0")}s`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0")}m`
}

export function formatPhase(run: WorkflowRun, workflow?: WorkflowInfo) {
  if (run.status !== "running") return "[---] complete"
  const phases = workflow?.meta.phases ?? []
  if (!run.current_phase || phases.length === 0) return run.current_phase ?? "pending"
  const index = phases.indexOf(run.current_phase)
  return `[${index >= 0 ? index + 1 : "?"}/${phases.length}] ${run.current_phase}`
}

// Sums agent cost for runs started within the calendar month of `now`, tolerating
// undefined per-agent cost and non-finite `started_at`. `now` is injected for
// determinism in tests; callers pass `Date.now()`.
export function spentThisMonth(runs: readonly WorkflowRun[], now: number = Date.now()) {
  const start = new Date(now)
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setMonth(end.getMonth() + 1)
  return runs
    .filter((run) => {
      const started = timestamp(run.started_at)
      return started !== undefined && started >= start.getTime() && started < end.getTime()
    })
    .reduce((total, run) => total + run.agents.reduce((sum, agent) => sum + (agent.cost ?? 0), 0), 0)
}

// Fund 10: the dashboard re-sorts runs on every 1s refetch, so a positional
// selection silently jumps to a different run. Re-anchor to the run that still
// carries the previously-selected id; if it is gone (e.g. deleted), clamp to the
// last row so the selection never points past the end.
export function reanchorSelection(prevId: string | undefined, rows: readonly WorkflowRun[]) {
  if (rows.length === 0) return 0
  if (prevId === undefined) return 0
  const index = rows.findIndex((run) => run.id === prevId)
  if (index >= 0) return index
  return rows.length - 1
}

// IMPORTANT: the Logs section renders into a non-scrolling, flexShrink={0} box, so
// an unbounded `<For>` over every persisted log entry lets a chatty run push the
// other detail panels off-screen. Keep only the last `max` entries and report how
// many older ones were dropped, so the view can show a "… N earlier entries" hint
// instead of silently truncating. Generic over the element type (it only slices,
// never inspects the fields) so the SDK's widened LogEntry passes through intact.
// Pure + deterministic so it is unit-testable.
export function capLogs<T>(entries: readonly T[], max: number) {
  if (entries.length <= max) return { entries: entries.slice(), hidden: 0 }
  return { entries: entries.slice(-max), hidden: entries.length - max }
}

export type WorkflowCommand = { type: "dashboard" } | { type: "start"; name: string; args: string }

// Fund 59: dispatch `/workflows ...` to the dashboard and `/workflow <name> ...`
// to a start. Splitting only on whitespace is not enough because `/workflows`
// has `/workflow` as a prefix, so `/workflows foo` used to be parsed as starting
// a workflow literally named `workflows`. Anchor on the exact first token.
// Fund 60: the start remainder is the RAW substring after the name (multiple
// spaces preserved) so `msg="hello   world"` survives intact to parseWorkflowArgs.
export function parseWorkflowCommand(input: string): WorkflowCommand | undefined {
  const firstLine = input.split("\n")[0]
  const command = firstLine.trimStart().split(/\s/)[0]
  if (command === "/workflows") return { type: "dashboard" }
  if (command !== "/workflow") return
  const remainder = firstLine.trimStart().slice(command.length).trimStart()
  if (!remainder) return { type: "dashboard" }
  const nameEnd = remainder.search(/\s/)
  if (nameEnd === -1) return { type: "start", name: remainder, args: "" }
  return { type: "start", name: remainder.slice(0, nameEnd), args: remainder.slice(nameEnd + 1) }
}
