import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { type DeepMutable, withStatics } from "@opencode-ai/core/schema"
import type { WorkflowAgentRow, WorkflowDefinitionRow, WorkflowLogRow } from "@opencode-ai/core/workflow/sql"
import { Glob } from "@opencode-ai/core/util/glob"
import { and, desc, eq, notInArray } from "drizzle-orm"
import { APICallError } from "ai"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Schema, SynchronizedRef } from "effect"
import type {
  WorkflowContext,
  WorkflowParallelOptions,
  WorkflowPipelineFn,
  WorkflowPipelineOptions,
  WorkflowPipelineStage,
} from "@opencode-ai/plugin/workflow"
import { WorkflowRunTable } from "./workflow.sql"
import { MetaReader } from "./meta-reader"
import { Meta } from "./meta"

// Branded id for a workflow run. Follows the repo's ID convention (cf. SessionID
// / MessageID in `session/schema.ts`): a `job_`-prefixed string carrying a
// nominal brand so a run id can never be confused with any other string at the
// type level. The brand is type-only — the `isStartsWith("job")` check is the
// same shape SessionID uses, which the OpenAPI generator emits as a plain
// `string`, so the SDK shape is unchanged. `make` mints a fresh ascending id
// (the prefix the engine already used via `Identifier.ascending("job")`).
export const RunID = Schema.String.check(Schema.isStartsWith("job")).pipe(
  Schema.brand("WorkflowRunID"),
  withStatics((schema) => ({
    ascending: (id?: string) => schema.make(Identifier.ascending("job", id)),
  })),
)
export type RunID = Schema.Schema.Type<typeof RunID>

// Meta/Argument schemas live in `./meta` (a Schema-only leaf module) so the
// static meta reader can share them without forming an import cycle. Re-exported
// here so the engine's public `Workflow.Meta` / `Workflow.Argument` API is
// unchanged.
export { Argument, Meta } from "./meta"

export const Info = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  meta: Meta,
  // `valid: false` marks a file that failed to load (bad meta / missing run /
  // syntax error). It is still returned so a single broken file never makes the
  // whole list fail; `error` carries the load failure as a human-readable
  // string. Valid entries are explicitly `valid: true` (never omitted).
  valid: Schema.Boolean,
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "WorkflowInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Definition = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  meta: Meta,
  source: Schema.optional(Schema.String),
  temporary: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "WorkflowDefinition" })
export type Definition = DeepMutable<Schema.Schema.Type<typeof Definition>>

// "interrupted" is a terminal status assigned to runs whose in-memory fiber was
// lost (crash/process restart) while the DB row still said "running". The orphan
// sweep on service start rewrites such zombie rows so the lifecycle stays honest.
export const Status = Schema.Literals(["running", "completed", "failed", "cancelled", "interrupted"])
export type Status = Schema.Schema.Type<typeof Status>

export const LogEntry = Schema.Struct({
  time: Schema.Number,
  phase: Schema.optional(Schema.String),
  message: Schema.String,
}).annotate({ identifier: "WorkflowLogEntry" })
export type LogEntry = DeepMutable<Schema.Schema.Type<typeof LogEntry>>

export const AgentRun = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["running", "completed", "failed"]),
  started_at: Schema.Number,
  completed_at: Schema.optional(Schema.Number),
  phase: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  message_id: Schema.optional(Schema.String),
  prompt: Schema.String,
  output: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Finite),
  tokens: Schema.optional(
    Schema.Struct({
      total: Schema.optional(Schema.Finite),
      input: Schema.Finite,
      output: Schema.Finite,
      reasoning: Schema.Finite,
      cache: Schema.Struct({
        read: Schema.Finite,
        write: Schema.Finite,
      }),
    }),
  ),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "WorkflowAgentRun" })
export type AgentRun = DeepMutable<Schema.Schema.Type<typeof AgentRun>>

// Compile-time SSoT bridge between the engine's runtime validators (the Effect
// schemas above) and core's persistence contract (the row types that annotate the
// workflow_run JSON columns). The engine keeps the Effect schemas as the runtime
// validators; core keeps the row types as the canonical column shapes. These
// bidirectional assignability checks fail the build the moment either side drifts
// — a field added/removed/retyped, or the AgentRun status union widened — so the
// silent drift that motivated this refactor cannot recur. Two directions are
// needed because a one-way `extends` only catches a SUPERSET on one side; both
// directions together pin the shapes to be mutually assignable (structurally
// identical for these closed object types). `void` keeps the consts from being
// reported as unused.
const _defToRow: WorkflowDefinitionRow = {} as Definition
const _defFromRow: Definition = {} as WorkflowDefinitionRow
const _logToRow: WorkflowLogRow = {} as LogEntry
const _logFromRow: LogEntry = {} as WorkflowLogRow
const _agentToRow: WorkflowAgentRow = {} as AgentRun
const _agentFromRow: AgentRun = {} as WorkflowAgentRow
void _defToRow
void _defFromRow
void _logToRow
void _logFromRow
void _agentToRow
void _agentFromRow

export const Run = Schema.Struct({
  id: RunID,
  session_id: Schema.optional(Schema.String),
  workflow: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  definition: Schema.optional(Definition),
  status: Status,
  started_at: Schema.Number,
  completed_at: Schema.optional(Schema.Number),
  current_phase: Schema.optional(Schema.String),
  logs: Schema.Array(LogEntry),
  agents: Schema.Array(AgentRun),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "WorkflowRun" })
export type Run = DeepMutable<Schema.Schema.Type<typeof Run>>

export const StartInput = Schema.Struct({
  name: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  // Optional cost cap in USD for the whole run. The unit is USD because that is
  // exactly the per-agent telemetry the engine already records (`AgentRun.cost`,
  // read from the assistant message's `cost`, the same number the dashboard
  // shows). After each agent step the remaining budget is decremented by that
  // step's cost; before each `ctx.agent` call the engine fails the step with a
  // BudgetExceededError once nothing is left. Omitted ⇒ unlimited (Infinity).
  // Must be a non-negative finite number: a negative/NaN/Infinity cap is a
  // validation error here, never a confusing runtime budget failure.
  budget: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({ identifier: "WorkflowStartInput" })
export type StartInput = Schema.Schema.Type<typeof StartInput>

export type PromptOps = {
  prompt: (input: SessionPrompt.PromptInput) => Effect.Effect<SessionV1.WithParts, unknown>
  /**
   * Aborts a running agent session (the same path TUI Esc / `POST /:id/abort`
   * use). The workflow engine calls this for every tracked child session when a
   * run is cancelled so no tokens keep burning after cancel. Optional so callers
   * that never start agents need not provide it.
   */
  cancel?: (sessionID: SessionID) => Effect.Effect<void>
}

export type StartOptions = StartInput & {
  prompt?: PromptOps
  source?: string
  temporary?: boolean
  permissionSessionID?: SessionID
}

export type WaitInput = {
  id: RunID
  timeout?: number
}

export type WaitResult = {
  run?: Run
  timedOut: boolean
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("WorkflowNotFoundError", {
  name: Schema.String,
}) {}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("WorkflowInvalidError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * Raised by an agent step that requested structured output (a `schema` was
 * passed to `ctx.agent`) when the session produced no parsed structured result —
 * either because the underlying session set a `StructuredOutputError` on the
 * assistant message, or because `structured` came back `undefined`. The engine
 * MUST NOT silently fall back to plaintext when a schema was requested: a missing
 * structured result is a genuine step failure, so this error propagates through
 * the same agent-failure path as any other agent error (node `failed`, run
 * `failed` unless the workflow module catches it).
 */
export class StructuredOutputError extends Schema.TaggedErrorClass<StructuredOutputError>()(
  "WorkflowStructuredOutputError",
  {
    message: Schema.String,
  },
) {}

/**
 * Raised at the top of `ctx.agent` (right after the abort-signal checkpoint)
 * when the run was started with a budget and that budget is exhausted
 * (`budgetRemaining <= 0`). The next agent step never starts: the engine
 * refuses to spend past the cap. Propagates through the SAME agent-failure path
 * as any other agent error (node `failed`, run `failed` unless the workflow
 * module catches it). The message names both the configured budget and the
 * amount already spent so the failure is self-explanatory.
 *
 * The cap is enforced PER STEP, best-effort: it is checked before each
 * `ctx.agent` call and the spend is settled after each step. Steps launched
 * concurrently via `ctx.parallel`/`ctx.pipeline` all pass the gate while the
 * budget is still positive, so a run can overspend by up to the combined cost
 * of the steps already in flight when the budget runs out. This is a soft cap,
 * not a hard mid-step limit.
 */
export class BudgetExceededError extends Schema.TaggedErrorClass<BudgetExceededError>()("WorkflowBudgetExceededError", {
  message: Schema.String,
  budget: Schema.Finite,
  spent: Schema.Finite,
}) {}

/**
 * Thrown by `checkpoint()` before the next `ctx.agent`/`ctx.parallel`/
 * `ctx.pipeline` task/step once the run's abort signal has fired, so the
 * follow-up step never starts. Detected in the run's failure branch and mapped
 * to `cancelled` rather than `failed`.
 *
 * Deliberately a plain `Error` (not `Schema.TaggedErrorClass`): it is thrown
 * synchronously from `checkpoint()`, a non-Effect JS callback invoked by the
 * workflow module's own code, so it cannot yield an Effect error.
 */
export class CancelledError extends Error {
  readonly _tag = "WorkflowCancelledError"
  constructor() {
    super("Workflow cancelled")
    this.name = "WorkflowCancelledError"
  }
}

export type AgentInput = {
  agent?: string
  prompt: string
  model?: string
  schema?: Record<string, unknown>
  permissionSessionID?: SessionID
}

// Pipeline/parallel option and stage shapes are the public workflow-authoring
// contract, owned by `@opencode-ai/plugin` (opencode depends on the plugin, so
// the plugin is the single source of truth). The engine re-exports them under
// its short names so workflow modules and the engine see the SAME types; any
// drift in the plugin definitions is a compile error here.
export type ParallelOptions = WorkflowParallelOptions
export type PipelineOptions = WorkflowPipelineOptions
export type PipelineStage<Prev, Item, Next> = WorkflowPipelineStage<Prev, Item, Next>
export type PipelineFn = WorkflowPipelineFn

export type ContextApi = {
  readonly budgetRemaining: number
  readonly setPhase: (phase: string) => void
  readonly log: (message: string) => void
  readonly parallel: <T>(tasks: readonly (() => Promise<T>)[], options?: ParallelOptions) => Promise<T[]>
  readonly pipeline: PipelineFn
  readonly agent: (input: AgentInput) => Promise<{ data: unknown; text: string }>
}

// `ContextApi` is the engine-side view of the run context handed to a workflow
// module; `WorkflowContext` (plugin) is the public authoring view. They must
// stay structurally assignable so a value the engine builds is a valid argument
// to a module typed against the plugin. This is asserted at compile time rather
// than via a full SSoT import because the two differ intentionally: ContextApi
// is `readonly` and is the runtime producer, WorkflowContext is the consumer
// contract. Drift in either direction fails the build below.
type _ContextApiSatisfiesWorkflowContext = ContextApi extends WorkflowContext ? true : never
const _contextApiCheck: _ContextApiSatisfiesWorkflowContext = true
void _contextApiCheck

type Module = {
  meta: Meta
  run: (args: Record<string, unknown>, ctx: ContextApi) => Promise<unknown>
}

type Active = {
  run: Run
  /**
   * The workspace directory (InstanceState.directory) this run was started in.
   * Persisted to the `directory` column so every read/delete/sweep can be scoped
   * to the owning workspace (Fund 6/17): the DB is process-global but the
   * workflow endpoints are per-directory, so a run started in A must never leak
   * into / be swept from B. Not surfaced on the public `Run` schema — it is a
   * persistence/routing concern, not part of the run's reported shape.
   */
  directory: string
  done: Deferred.Deferred<Run>
  fiber?: Fiber.Fiber<void, unknown>
  /**
   * Per-run scope into which EVERY agent/parallel/pipeline effect is forked
   * (via `Effect.forkIn(runScope)`), instead of running as a detached root
   * fiber through `Effect.runPromise`. This makes all dispatched agent work a
   * tracked child of the run: closing `runScope` on cancel/remove propagates
   * Interrupt down to in-flight agent fibers (Fund 14), including ones that
   * started but had not yet registered their child session (Fund 16), and ones
   * that would otherwise re-INSERT a deleted row after delete (Fund 3). The
   * scope is forked from the instance scope, so an instance teardown also
   * closes it.
   */
  runScope: Scope.Closeable
  /** Child agent sessions currently in flight; aborted on cancel/remove. */
  sessions: Set<string>
  /** Session-abort vector for this run (the prompt-ops `cancel`); undefined when no prompt-ops were supplied. */
  cancelSession?: (sessionID: SessionID) => Effect.Effect<void>
  /** Set once a cancel/remove has been requested so the run finishes as `cancelled`, never `failed`. */
  cancelling?: boolean
  /**
   * Tombstone set by `remove()` BEFORE the row is deleted. `persistRun` reads
   * it inside its `Effect.suspend` and NO-OPs for a removed run, so a settlement
   * write racing the delete can never re-INSERT (resurrect) the deleted row
   * (Fund 3).
   */
  removed?: boolean
  /**
   * Original cost cap (USD) the run was started with, or `Infinity` when no
   * budget was set. Kept alongside `budgetRemaining` purely so the
   * BudgetExceededError can report how much was budgeted vs. spent.
   */
  budget: number
  /**
   * Live remaining budget (USD). Starts at `budget` and is decremented after
   * each agent step by that step's `AgentRun.cost`. `Infinity` ⇒ unlimited.
   * Read by `ctx.budgetRemaining`; gated against in `ctx.agent`.
   */
  budgetRemaining: number
}

type State = {
  runs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

export interface Interface {
  // Never fails: a file that cannot be loaded is reported as an invalid Info
  // entry rather than aborting the whole list.
  readonly list: () => Effect.Effect<Info[]>
  readonly runs: () => Effect.Effect<Run[]>
  readonly get: (id: RunID) => Effect.Effect<Run | undefined>
  readonly start: (input: StartOptions) => Effect.Effect<Run, InvalidError | NotFoundError>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly cancel: (id: RunID) => Effect.Effect<Run | undefined>
  readonly remove: (id: RunID) => Effect.Effect<boolean>
  /**
   * Marks every `running` DB row that has no live registry entry as
   * `interrupted`. Runs automatically when the per-instance registry is first
   * created (process start → registry empty → all `running` rows are zombies),
   * and is exposed so callers/tests can trigger it explicitly.
   */
  readonly sweep: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Workflow") {}

const decodeMeta = Schema.decodeUnknownExit(Meta)

function snapshot(active: Active): Run {
  return {
    ...active.run,
    logs: active.run.logs.map((item) => ({ ...item })),
    agents: active.run.agents.map((item) => ({ ...item })),
  }
}

type Row = typeof WorkflowRunTable.$inferSelect

function fromRow(row: Row): Run {
  return {
    // DB->engine brand boundary: the row id is an opaque `text` column in core
    // (which cannot import the engine's brand), so it is re-branded here.
    id: RunID.make(row.id),
    session_id: row.session_id ?? undefined,
    workflow: row.workflow,
    args: row.args ?? undefined,
    definition: row.definition ?? undefined,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    current_phase: row.current_phase ?? undefined,
    logs: row.logs.map((item) => ({ ...item })),
    agents: row.agents.map((item) => ({ ...item })),
    // Fund 42: the `result` column is plain JSON text (the engine owns the codec,
    // see persistRun). SQL NULL means the result was never recorded → `undefined`;
    // any stored text is JSON-parsed, so the literal `"null"` decodes back to the
    // real `null` a workflow returned rather than being flattened to `undefined`.
    result: row.result === null ? undefined : JSON.parse(row.result),
    error: row.error ?? undefined,
  }
}

// Test seam (N2): when set, the NEXT terminal persist (the awaited write in
// `finish`) fails once, simulating a DB error on the terminal write. Used only
// by the workflow test to prove that a failing terminal persist never strands
// the run's `done` deferred (waiters must still observe the terminal state).
// A module-level one-shot flag is the minimal seam that does not require
// threading a fake DB through the whole layer graph; it is inert in production.
let failNextTerminalPersist = false
export const __testHooks = {
  failNextTerminalPersist: () => {
    failNextTerminalPersist = true
  },
}

class TerminalPersistTestError extends Error {
  constructor() {
    super("injected terminal persist failure (test seam)")
  }
}

function persistRun(db: Database.Interface["db"], active: Active, options?: { terminal?: boolean }) {
  // The snapshot MUST be built at execution time (inside Effect.suspend), not
  // at effect-construction time: progress writes are forked into the run scope
  // and may execute AFTER the awaited terminal write in `finish`. A snapshot
  // captured at construction would then revert the row to a stale state
  // (live-found regression: a completed run's row flipped back to `running`).
  // Reading `active.run` at execution time makes every write a full snapshot of
  // the CURRENT state, so any write ordering converges on the final row.
  return Effect.suspend(() => {
    // Fund 3: once a run is removed, NO write may re-create its row. A late
    // settlement write (a detached agent that settles after `remove` deleted
    // the row) would otherwise re-INSERT a zombie row, only swept to
    // `interrupted` on the next restart. The tombstone is checked at execution
    // time so it covers writes already queued before the delete.
    if (active.removed) return Effect.void
    // Test seam (N2): fail exactly the terminal write once, to prove the
    // `done` deferred still resolves around a failing terminal persist.
    if (options?.terminal && failNextTerminalPersist) {
      failNextTerminalPersist = false
      return Effect.fail(new TerminalPersistTestError())
    }
    const data = {
      id: active.run.id,
      session_id: active.run.session_id ?? null,
      directory: active.directory,
      workflow: active.run.workflow,
      status: active.run.status,
      started_at: active.run.started_at,
      completed_at: active.run.completed_at ?? null,
      current_phase: active.run.current_phase ?? null,
      args: active.run.args ?? null,
      definition: active.run.definition ?? null,
      logs: active.run.logs,
      agents: active.run.agents,
      // Fund 42: the `result` column is plain text and the engine owns its JSON
      // codec, so a real `null` result survives the roundtrip distinct from an
      // unset one. An unset result (`undefined`) is stored as SQL NULL; any other
      // value — including the literal `null` a workflow may return — is stringified
      // to JSON text (a `null` result becomes the text `"null"`, NOT SQL NULL).
      result: active.run.result === undefined ? null : JSON.stringify(active.run.result),
      error: active.run.error ?? null,
    }
    return db
      .insert(WorkflowRunTable)
      .values(data)
      .onConflictDoUpdate({
        target: WorkflowRunTable.id,
        set: { ...data, time_updated: Date.now() },
      })
      .run()
  }).pipe(Effect.orDie)
}

/**
 * Forks a progress-snapshot write as a child of the run scope, so the fiber is
 * tracked and torn down with the run (and, transitively, the instance) instead
 * of leaking as a detached root fiber. Interrupt-on-dispose is safe for these
 * writes: every `persistRun` is an idempotent full-state upsert that NO-OPs for
 * a removed run, the terminal write in `finish` is awaited inline, and the
 * startup orphan sweep heals any run whose last progress snapshot was cut short.
 */
function persistInScope(active: Active, bridge: EffectBridge.Shape, db: Database.Interface["db"]) {
  bridge.fork(persistRun(db, active).pipe(Effect.forkIn(active.runScope)))
}

/**
 * Rewrites every `running` row whose id is not in `liveIds` to `interrupted`
 * with a completion timestamp in a single bulk UPDATE. Used by the startup sweep
 * (liveIds empty) and the exposed `sweep()` method (liveIds = currently active
 * runs); genuinely-running rows owned by a live fiber are left untouched.
 *
 * `directory` scopes the sweep to the calling workspace (Fund 17): the DB is
 * process-global but every per-directory registry only knows its OWN runs, so a
 * sweep keyed off another directory's (empty) registry must NOT flip a run that
 * is genuinely live in a different workspace. Without the scope, the first
 * Workflow operation in a second directory B — whose fresh registry is empty —
 * would stamp every `running` row of every directory (including a run currently
 * executing in A) to `interrupted`.
 */
function sweepOrphans(db: Database.Interface["db"], liveIds: ReadonlySet<string>, now: number, directory: string) {
  return db
    .update(WorkflowRunTable)
    .set({ status: "interrupted", completed_at: now, time_updated: now })
    .where(
      and(
        eq(WorkflowRunTable.status, "running"),
        eq(WorkflowRunTable.directory, directory),
        liveIds.size ? notInArray(WorkflowRunTable.id, [...liveIds]) : undefined,
      ),
    )
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}

function errorText(error: unknown) {
  if (APICallError.isInstance(error)) {
    return [error.message, error.statusCode ? `status: ${error.statusCode}` : undefined, error.responseBody]
      .filter(Boolean)
      .join("\n")
  }
  if (error instanceof Error) return error.message
  return String(error)
}

function isInvalidError(error: unknown): error is InvalidError {
  return typeof error === "object" && error !== null && Reflect.get(error, "_tag") === "WorkflowInvalidError"
}

function isCancelled(value: unknown): boolean {
  return (
    value instanceof CancelledError ||
    (typeof value === "object" && value !== null && Reflect.get(value, "_tag") === "WorkflowCancelledError")
  )
}

// Fund 4: the production session runner RESOLVES a prompt on abort (it returns
// the last assistant message rather than rejecting), and that message carries
// an abort marker — either an `aborted` flag or a `MessageAbortedError` error
// (see message-v2.ts `fromError` / v1 `AbortedError`). An agent step whose
// prompt came back abort-marked did NOT succeed and must be treated as
// cancelled, never flipped to `completed`. Tolerant of the loose `WithParts`
// shape the engine sees (it only reads `info`).
function isAbortedMessage(message: SessionV1.WithParts): boolean {
  const info = message.info as { aborted?: boolean; error?: { name?: string } } | undefined
  if (!info) return false
  if (info.aborted === true) return true
  const name = info.error?.name
  return name === "MessageAbortedError" || name === "AbortError"
}

function mutableMeta(meta: Meta): Definition["meta"] {
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases ? [...meta.phases] : undefined,
    arguments: meta.arguments
      ? Object.fromEntries(Object.entries(meta.arguments).map(([name, argument]) => [name, { ...argument }]))
      : undefined,
  }
}

// loadModule writes a transient import copy ALONGSIDE the source file (same
// directory) on purpose: relative imports and the workflow module's
// node_modules resolution are anchored on the source directory, so moving the
// copy to os.tmpdir() would break module resolution. The trade-off is that a
// process killed mid-import can leave the temp copy behind — hence the orphan
// filter + sweep in discover() below, which keys off TEMP_FILE_RE.
//
// The name shape is `.<base>.<ts>.<rand>.<mts|mjs>`: a leading dot (hidden),
// the original base name, a millisecond timestamp (used by the sweep to age the
// file out), a random suffix (collision-free concurrent loads), and an .mts/.mjs
// extension that is deliberately NOT one of the discovered globs (`*.ts`/`*.js`),
// so a temp copy can never be picked up as a workflow even before the sweep runs.
const TEMP_FILE_RE = /^\.(.+)\.(\d+)\.[0-9a-f]+\.(mts|mjs)$/
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000

function tempFileName(file: string): string {
  const ext = path.extname(file)
  return `.${path.basename(file, ext)}.${Date.now()}.${Math.random().toString(16).slice(2)}${ext === ".js" ? ".mjs" : ".mts"}`
}

// Each call imports the file fresh through a unique temp-file copy, so a
// workflow edited between calls is always reloaded. We deliberately do NOT keep
// a cross-call module cache, and we do not rely on a `?mtime=` query either:
// Bun's module cache is not reliably invalidated by a query string alone, so a
// cached or query-busted import can serve a stale `run`/`meta` after an edit
// (the realtime-update bug). Correctness over micro-optimization — the
// double-load that motivated the original finding is already gone because
// start() now loads only the target module instead of calling list().
async function loadModule(file: string): Promise<Module> {
  const source = await Bun.file(file).text()
  const dir = path.dirname(file)
  const cachePath = path.join(dir, tempFileName(file))
  // Fund 40 (b): the temp copy must live in the source directory so relative
  // imports / node_modules resolution still work. If that directory is not
  // writable (read-only or external mount), fall back to importing the original
  // file directly instead of hard-failing. Caveat: a direct import is subject to
  // the runtime's module cache, so an edit between two starts of a workflow in a
  // read-only dir may serve a stale module — acceptable, since a read-only dir
  // is not being edited in place anyway.
  let importPath = cachePath
  let cleanup = () => Bun.file(cachePath).delete()
  const wrote = await Bun.write(cachePath, source).then(
    () => true,
    () => false,
  )
  if (!wrote) {
    importPath = file
    cleanup = () => Promise.resolve()
  }
  const imported = (await import(pathToFileURL(importPath).href).finally(cleanup)) as Record<string, unknown>
  const module = (
    typeof imported.default === "object" && imported.default !== null ? imported.default : imported
  ) as Record<string, unknown>
  const parsed = decodeMeta(module.meta, { errors: "all", propertyOrder: "original" })
  if (Exit.isFailure(parsed)) throw new InvalidError({ path: file, message: Cause.pretty(parsed.cause) })
  if (typeof module.run !== "function") throw new InvalidError({ path: file, message: "Missing run(args, ctx) export" })
  return {
    meta: parsed.value,
    run: module.run as Module["run"],
  }
}

function assistantText(message: SessionV1.WithParts) {
  return message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text" && part.text.trim().length > 0)
    .map((part) => part.text)
    .join("\n")
}

// Fund 40: opportunistically remove orphaned loadModule temp copies (left
// behind by a process killed mid-import) from a workflows directory, but only
// when they are older than TEMP_FILE_MAX_AGE_MS so a temp copy of a CURRENTLY
// loading workflow is never deleted out from under it. Best-effort: any error
// (missing dir, race, permission) is swallowed — a stale temp file is harmless
// since it is never discovered as a workflow (wrong extension + filter below).
async function sweepTempFiles(workflowsDir: string) {
  const names = await fs.readdir(workflowsDir).catch(() => [] as string[])
  const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS
  await Promise.all(
    names
      .filter((name) => TEMP_FILE_RE.test(name))
      .map(async (name) => {
        const full = path.join(workflowsDir, name)
        const stat = await fs.stat(full).catch(() => undefined)
        if (stat && stat.mtimeMs < cutoff) await fs.rm(full, { force: true }).catch(() => undefined)
      }),
  )
}

// Fund 2: a discovered file must really live inside its workflows directory.
// We glob WITHOUT following symlinks, but a symlinked file entry can still be
// returned, so we additionally resolve the realpath of both the file and the
// workflows directory and require the file to stay within it. A symlink that
// escapes the directory (e.g. -> /tmp/payload.ts) is dropped, so it can never
// be listed/started — a reviewer eyeballing the directory only sees the harmless
// link, never the external target. Returns true when the file is safe to keep.
async function withinWorkflowsDir(file: string, workflowsDir: string): Promise<boolean> {
  const [realFile, realDir] = await Promise.all([
    fs.realpath(file).catch(() => undefined),
    fs.realpath(workflowsDir).catch(() => undefined),
  ])
  if (!realFile || !realDir) return false
  const prefix = realDir.endsWith(path.sep) ? realDir : realDir + path.sep
  return realFile.startsWith(prefix)
}

// `directories` is ordered by precedence (project before global, see
// discoverWorkflows): the first directory that contributes a given workflow
// NAME wins, so a project workflow shadows a same-named global one. Within a
// directory the glob excludes temp copies by extension; TEMP_FILE_RE filters
// any remaining match defensively, and the symlink boundary check drops escapes.
async function discover(directories: readonly string[]) {
  const seen = new Set<string>()
  const result: { name: string; path: string }[] = []
  for (const dir of directories) {
    const workflowsDir = path.join(dir, "workflows")
    // Fire-and-forget sweep of stale temp copies in this directory.
    await sweepTempFiles(workflowsDir)
    const files = (
      await Promise.all(
        ["workflows/*.ts", "workflows/*.js"].map((pattern) =>
          Glob.scan(pattern, { cwd: dir, absolute: true, dot: true, symlink: false }),
        ),
      )
    )
      .flat()
      .filter((file) => !TEMP_FILE_RE.test(path.basename(file)))
    const kept = await Promise.all(
      files.map(async (file) => ((await withinWorkflowsDir(file, workflowsDir)) ? file : undefined)),
    )
    for (const file of kept) {
      if (!file) continue
      const name = path.basename(file, path.extname(file))
      if (seen.has(name)) continue
      seen.add(name)
      result.push({ name, path: file })
    }
  }
  return result.toSorted((a, b) => a.name.localeCompare(b.name))
}

function projectConfigDir(ctx: { directory: string; worktree: string }) {
  return path.join(ctx.worktree === "/" ? ctx.directory : ctx.worktree, ".opencode")
}

function createContext(input: {
  active: Active
  agent: (input: AgentInput) => Promise<{ data: unknown; text: string }>
  permissionSessionID?: SessionID
  persist: () => void
  /** AbortSignal of the run fiber; fires when the run is interrupted/cancelled. */
  signal: () => AbortSignal | undefined
  /**
   * Runs the parallel/pipeline task graph as a child of the run scope (not as a
   * detached root fiber): closing the run scope on cancel/remove propagates
   * Interrupt into the in-flight graph. An interrupted graph rejects as
   * CancelledError so the workflow body unwinds as `cancelled`.
   */
  dispatch: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>
}): ContextApi {
  const checkpoint = () => {
    // Also treat a landed cancel as an abort even before the run fiber's signal
    // has been observed, so a follow-up step is gated the moment cancel started.
    if (input.signal()?.aborted || input.active.cancelling) throw new CancelledError()
  }
  return {
    // Live remaining budget (USD), read on every access so a workflow can
    // observe the value shrink across agent steps. `Infinity` when the run was
    // started without a budget (unchanged default).
    get budgetRemaining() {
      return input.active.budgetRemaining
    },
    setPhase(phase: string) {
      input.active.run.current_phase = phase
      input.persist()
    },
    log(message: string) {
      input.active.run.logs.push({ time: Date.now(), phase: input.active.run.current_phase, message })
      input.persist()
    },
    parallel<T>(tasks: readonly (() => Promise<T>)[], options?: { concurrencyLimit?: number }) {
      checkpoint()
      const concurrency = Math.max(1, options?.concurrencyLimit ?? 20)
      // Each task is gated by the run's abort signal via checkpoint() before it
      // starts: once cancel has fired, not-yet-started tasks throw CancelledError
      // and never run. The whole batch runs as a child of the run scope (via
      // dispatch), so a cancel/remove that closes the run scope ALSO interrupts
      // tasks already in flight — and each agent task additionally aborts its
      // child session for real via PromptOps.cancel.
      return input.dispatch(
        Effect.forEach(
          tasks,
          (task) =>
            Effect.promise(() => {
              checkpoint()
              return task()
            }),
          { concurrency },
        ),
      )
    },
    // Real per-item pipeline (heterogeneous stages). The public type is the
    // precise overloaded `PipelineFn`; internally we plumb `unknown` because the
    // variadic stage chain cannot be expressed in a single impl signature. The
    // last argument is an optional `{ concurrencyLimit }` object (a plain object,
    // never a function) — everything before it is a stage.
    pipeline: ((items: readonly unknown[], ...rest: unknown[]) => {
      checkpoint()
      const last = rest[rest.length - 1]
      const hasOptions = typeof last === "object" && last !== null
      const options = (hasOptions ? last : undefined) as PipelineOptions | undefined
      const stages = (hasOptions ? rest.slice(0, -1) : rest) as ReadonlyArray<
        (prev: unknown, item: unknown) => Promise<unknown>
      >
      // Same clamp as parallel(): an explicit limit ≤0 is floored to 1, matching
      // parallel's `Math.max(1, …)`. Only an UNSET limit means "unbounded".
      const concurrency = options?.concurrencyLimit === undefined ? "unbounded" : Math.max(1, options.concurrencyLimit)
      // No barrier between stages: each ITEM runs the full stage SEQUENCE as its
      // own Effect, and items run under Effect.forEach concurrency — so item B may
      // be in stage 2 while item A is still in stage 1. checkpoint() gates before
      // each stage so the next stage never starts after cancel. The whole graph
      // runs as a child of the run scope (via dispatch), so a cancel/remove that
      // closes the run scope interrupts stages already in flight too; agent
      // stages additionally abort their child session for real via PromptOps.cancel.
      return input.dispatch(
        Effect.forEach(
          items,
          (item) =>
            Effect.promise(async () => {
              let current: unknown = item
              for (const stage of stages) {
                checkpoint()
                current = await stage(current, item)
              }
              return current
            }),
          { concurrency },
        ),
      )
    }) as ContextApi["pipeline"],
    agent: input.agent,
  }
}

export function fmt(list: Info[]) {
  const described = list.filter((workflow) => workflow.meta.description !== undefined)
  if (described.length === 0) return "No workflows are currently available."
  return [
    "<available_workflows>",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .flatMap((workflow) => [
        "  <workflow>",
        `    <name>${workflow.name}</name>`,
        `    <description>${workflow.meta.description}</description>`,
        `    <path>${pathToFileURL(workflow.path).href}</path>`,
        ...(workflow.meta.phases?.length ? [`    <phases>${workflow.meta.phases.join(", ")}</phases>`] : []),
        ...(workflow.meta.arguments
          ? [
              "    <arguments>",
              ...Object.entries(workflow.meta.arguments).map(
                ([name, arg]) =>
                  `      <argument name="${name}" type="${arg.type ?? "string"}">${arg.description ?? ""}</argument>`,
              ),
              "    </arguments>",
            ]
          : []),
        "  </workflow>",
      ]),
    "</available_workflows>",
  ].join("\n")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Workflow.state")(function* (ctx) {
        const runs = yield* SynchronizedRef.make(new Map<string, Active>())
        // The registry is freshly empty here: any row still marked `running`
        // belongs to a fiber that did not survive into this process, so sweep
        // every one of them to `interrupted` (honest orphan recovery on start).
        // Scoped to THIS workspace directory (Fund 17): this state is created
        // per-directory, so the startup sweep must heal only its OWN zombie rows
        // — a sibling directory's live run shares the global DB and must be left
        // running.
        yield* sweepOrphans(db, new Set(), yield* Clock.currentTimeMillis, ctx.directory)
        return {
          runs,
          scope: yield* Scope.Scope,
        }
      }),
    )

    const readRuns = Effect.fn("Workflow.readRuns")(function* () {
      const active = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      // Scope the listing to the calling workspace (Fund 6): the DB is global,
      // so without the directory filter `GET /workflow/run?directory=A` would
      // leak runs started in directory B.
      const directory = yield* InstanceState.directory
      const rows = yield* db
        .select()
        .from(WorkflowRunTable)
        .where(eq(WorkflowRunTable.directory, directory))
        .orderBy(desc(WorkflowRunTable.started_at))
        .all()
        .pipe(Effect.orDie)
      return rows
        .map(fromRow)
        .map((run) => {
          const live = active.get(run.id)
          return live ? snapshot(live) : run
        })
        .toSorted((a, b) => b.started_at - a.started_at)
    })

    // Shared discovery for list() and start(): resolves the config + project
    // directories and globs them into a sorted `{ name, path }[]`. No module is
    // loaded here — loading is the caller's concern (list loads all per-file,
    // start loads only the target).
    //
    // N4 (precedence, behavior change): the project config dir is placed FIRST,
    // ahead of config.directories() (which leads with the GLOBAL ~/.config
    // dir). discover() dedups by NAME with first-wins, so a project workflow now
    // shadows a same-named global one — previously the global file won, which
    // meant create "validated" / start ran the wrong file when both existed.
    const discoverWorkflows = Effect.fn("Workflow.discover")(function* () {
      const ctx = yield* InstanceState.context
      const directories = [...new Set([projectConfigDir(ctx), ...(yield* config.directories())])]
      return yield* Effect.promise(() => discover(directories))
    })

    const list: Interface["list"] = Effect.fn("Workflow.list")(function* () {
      const workflows = yield* discoverWorkflows()
      // Discovery NEVER executes workflow module code: meta is extracted purely
      // from each file's source text via the static AST reader. `loadModule` (a
      // real dynamic import that runs the module's top-level code) is reserved for
      // start(), AFTER the permission gate. This closes the root cause where merely
      // listing/reading/autocompleting workflows in a cloned workspace ran foreign
      // code before any prompt. Per-file error isolation is kept: a file whose meta
      // is missing, dynamic (not statically analyzable), or schema-invalid becomes
      // an `{ valid: false, error }` entry instead of aborting the whole list.
      return yield* Effect.forEach(
        workflows,
        (workflow) =>
          Effect.promise(() => Bun.file(workflow.path).text()).pipe(
            Effect.map((source): Info => {
              const result = MetaReader.read(source, workflow.path)
              return result.valid
                ? { ...workflow, meta: result.meta, valid: true }
                : // Synthesize a minimal meta so the schema stays satisfied and
                  // consumers can still show the file's name; `valid: false`
                  // signals the entry is not runnable.
                  { ...workflow, meta: { name: workflow.name }, valid: false, error: result.error }
            }),
          ),
        { concurrency: "unbounded" },
      )
    })

    const runs: Interface["runs"] = Effect.fn("Workflow.runs")(function* () {
      return yield* readRuns()
    })

    const get: Interface["get"] = Effect.fn("Workflow.get")(function* (id) {
      const active = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)).get(id)
      if (active) return snapshot(active)
      // Cold DB read is scoped to the calling workspace (Fund 6): `get(id)` from
      // directory B must not see a run that belongs to directory A even though
      // both share the global DB. The in-memory branch above is already scoped
      // because the registry is per-directory.
      const directory = yield* InstanceState.directory
      const row = yield* db
        .select()
        .from(WorkflowRunTable)
        .where(and(eq(WorkflowRunTable.id, id), eq(WorkflowRunTable.directory, directory)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return fromRow(row)
    })

    const finish = Effect.fn("Workflow.finish")(function* (
      id: RunID,
      status: Exclude<Status, "running">,
      data?: { result?: unknown; error?: string },
    ) {
      const completed_at = yield* Clock.currentTimeMillis
      const active = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)).get(id)
      if (!active) return
      if (active.run.status !== "running") return snapshot(active)
      active.run.status = status
      active.run.completed_at = completed_at
      active.run.result = data?.result
      active.run.error = data?.error
      active.fiber = undefined
      // Close out any agent that is still marked running when the run ends as
      // cancelled/failed — its session was aborted (cancel) or the run unwound,
      // so it is no longer running.
      if (status !== "completed") {
        for (const node of active.run.agents) {
          if (node.status !== "running") continue
          node.status = "failed"
          node.completed_at = completed_at
          node.error ??= status === "cancelled" ? "Cancelled" : "Workflow failed"
        }
      }
      // N2: a failing terminal persist must NEVER strand the `done` deferred —
      // `persistRun` is `orDie`, so a DB error on the terminal write used to kill
      // the finish fiber and the deferred was never resolved, hanging every
      // no-timeout `wait()` (and background jobs) forever. `Effect.exit` captures
      // ANY outcome of the persist (success, failure, or the `orDie` defect) as a
      // value, so execution ALWAYS continues to the resolve below — the persist
      // can fail and waiters still observe the terminal state (a cut-short write
      // is healed by the startup orphan sweep on next restart).
      //
      // Fund 42: the persist runs BEFORE the resolve so a successful terminal
      // write is already committed by the time a waiter wakes — a direct DB read
      // right after `wait()` sees the final row (incl. a `null` result serialized
      // as the text `"null"`) instead of racing an in-flight progress write. The
      // `Effect.exit` guard keeps this ordering safe for the failing-persist case.
      const result = snapshot(active)
      yield* persistRun(db, active, { terminal: true }).pipe(Effect.exit)
      yield* Deferred.succeed(active.done, result).pipe(Effect.ignore)
      // Free the per-run scope now that the run is terminal so it does not linger
      // (one empty child scope per run) on the instance scope until teardown. By
      // the time finish runs the body fiber has exited and all dispatched agent
      // fibers have settled, so this interrupts nothing live; on the cancel/remove
      // path abortRun already closed it and a second close is a no-op. Forked so a
      // finalizer cannot delay the terminal return.
      const inst = yield* InstanceState.get(state)
      yield* Scope.close(active.runScope, Exit.void).pipe(Effect.ignore, Effect.forkIn(inst.scope))
      return result
    })

    const start: Interface["start"] = Effect.fn("Workflow.start")(function* (input) {
      // Resolve the single target by name without loading every workflow: a
      // broken sibling file must not block starting a valid one. Only the target
      // module is imported, and a broken target fails precisely (InvalidError
      // naming the file) rather than as part of a whole-list failure.
      const discovered = yield* discoverWorkflows()
      const workflow = discovered.find((item) => item.name === input.name)
      if (!workflow) return yield* new NotFoundError({ name: input.name })
      // tryPromise so a load failure (bad meta / missing run / syntax error)
      // surfaces as a typed InvalidError naming the file, not as an unhandled
      // defect (Effect.promise would treat a rejection as a die).
      const module = yield* Effect.tryPromise({
        try: () => loadModule(workflow.path),
        catch: (error) =>
          isInvalidError(error) ? error : new InvalidError({ path: workflow.path, message: errorText(error) }),
      })
      const inst = yield* InstanceState.get(state)
      // The workspace this run belongs to. Persisted to the `directory` column so
      // every later read/delete/sweep can be scoped to it (Fund 6/17).
      const directory = yield* InstanceState.directory
      const id = RunID.ascending()
      const started_at = yield* Clock.currentTimeMillis
      const session = yield* sessions.create({ title: `Workflow: ${module.meta.name}` })
      const done = yield* Deferred.make<Run>()
      // Per-run scope forked from the instance scope. ALL agent/parallel/pipeline
      // work and all progress writes are forked into it (not into a detached
      // root fiber), so closing it on cancel/remove propagates Interrupt to the
      // in-flight agent graph; the instance teardown closes it transitively.
      const runScope = yield* Scope.fork(inst.scope)
      const active: Active = {
        run: {
          id,
          session_id: session.id,
          workflow: workflow.name,
          args: input.args ?? undefined,
          definition: {
            name: workflow.name,
            path: workflow.path,
            meta: mutableMeta(module.meta),
            source: input.source,
            temporary: input.temporary,
          },
          status: "running",
          started_at,
          logs: [],
          agents: [],
        },
        directory,
        done,
        runScope,
        sessions: new Set<string>(),
        cancelSession: input.prompt?.cancel,
        // Unset budget ⇒ Infinity ⇒ the gate never trips and the decrement is a
        // no-op, preserving the previous unlimited behavior exactly.
        budget: input.budget ?? Number.POSITIVE_INFINITY,
        budgetRemaining: input.budget ?? Number.POSITIVE_INFINITY,
      }
      yield* SynchronizedRef.update(inst.runs, (runs) => new Map(runs).set(id, active))
      yield* persistRun(db, active)
      if (input.prompt) {
        yield* input.prompt
          .prompt({
            sessionID: session.id,
            noReply: true,
            parts: [
              {
                type: "text",
                text: [
                  `Workflow started: ${module.meta.name}`,
                  `Run ID: ${id}`,
                  "",
                  module.meta.description ?? "Use the workflow dashboard to inspect phases, agent runs, and results.",
                ].join("\n"),
              },
            ],
          })
          .pipe(Effect.ignore)
      }
      const bridge = yield* EffectBridge.make()
      // AbortSignal of the run fiber; set inside Effect.promise below and fired
      // on Fiber.interrupt. Read by ctx.agent/parallel/pipeline for gating.
      let runSignal: AbortSignal | undefined

      // Runs an effect as a CHILD of the run scope and awaits it as a promise.
      // Unlike `bridge.promise` (a detached root fiber via Effect.runPromise),
      // the work is forked into `runScope`, so closing the scope on cancel/remove
      // interrupts it. An interrupt-only outcome (the scope was closed) is
      // surfaced as a CancelledError rejection so the workflow body unwinds as
      // `cancelled`; any other failure is rejected with its representative error.
      const dispatch = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
        bridge.promise(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkIn(effect, runScope)
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.die(new CancelledError())
            return yield* Effect.failCause(exit.cause)
          }),
        )

      const agent = async (agentInput: AgentInput) => {
        // Gate the step: a fired run signal OR a landed cancel both mean the run
        // is unwinding, so refuse to start another agent step (Fund 5/4).
        if (runSignal?.aborted || active.cancelling || active.removed) throw new CancelledError()
        // Budget gate — ordered right AFTER the abort-signal checkpoint so a
        // cancelled run still unwinds as `cancelled` (not `failed`) before any
        // budget verdict is reached. `Infinity` (no budget set) never trips.
        // Once the prior steps have consumed the whole budget we refuse to spend
        // again: fail the step with a BudgetExceededError, which propagates like
        // any other agent failure (node `failed`, run `failed` unless caught).
        if (active.budgetRemaining <= 0) {
          const spent = active.budget - active.budgetRemaining
          throw new BudgetExceededError({
            message: `Workflow budget exhausted: spent ${spent} of ${active.budget} (USD) budget; refusing to start another agent step`,
            budget: active.budget,
            spent,
          })
        }
        const node: AgentRun = {
          id: `${active.run.agents.length + 1}`,
          status: "running",
          started_at: Date.now(),
          phase: active.run.current_phase,
          agent: agentInput.agent,
          model: agentInput.model,
          prompt: agentInput.prompt,
        }
        active.run.agents.push(node)
        persistInScope(active, bridge, db)
        const prompt = input.prompt
        if (!prompt) throw new Error("Workflow agent execution requires prompt operations")
        return dispatch(
            Effect.gen(function* () {
              const selected = agentInput.agent ? yield* agents.get(agentInput.agent) : yield* agents.defaultInfo()
              const modelInfo = agentInput.model ? Provider.parseModel(agentInput.model) : selected.model
              const session = yield* sessions.create({
                parentID: active.run.session_id ? SessionID.make(active.run.session_id) : undefined,
                title: `${active.run.workflow} ${node.id} (@${selected.name} subagent)`,
                agent: selected.name,
                model: modelInfo ? { id: modelInfo.modelID, providerID: modelInfo.providerID } : undefined,
              })
              node.agent = selected.name
              if (modelInfo) node.model = `${modelInfo.providerID}/${modelInfo.modelID}`
              node.session_id = session.id
              // Track the child session so cancel()/remove() can abort it.
              active.sessions.add(session.id)
              // Fund 16: a cancel may have landed in the window between the start
              // gate above and registering this session. Self-abort the freshly
              // created session if so, instead of relying on a one-shot snapshot
              // in abortRun that could miss it. The scope-close path will also
              // interrupt this fiber, but aborting the session here stops the
              // model spend deterministically and is idempotent.
              if (active.cancelling || active.removed) {
                if (active.cancelSession) yield* active.cancelSession(session.id).pipe(Effect.ignore)
              }
              yield* persistRun(db, active)
              const message = yield* prompt.prompt({
                sessionID: session.id,
                permissionSessionID: agentInput.permissionSessionID ?? input.permissionSessionID,
                agent: selected.name,
                model: modelInfo,
                format: agentInput.schema ? { type: "json_schema", schema: agentInput.schema } : undefined,
                parts: [{ type: "text", text: agentInput.prompt }],
              })
              node.message_id = message.info.id
              if (message.info.role === "assistant") {
                node.model = `${message.info.providerID}/${message.info.modelID}`
                node.cost = message.info.cost
                node.tokens = message.info.tokens
              }
              // Fund 4: the production runner RESOLVES (does not reject) when a
              // session is aborted — it returns the last assistant message, which
              // carries an abort/cancelled error. If the run is cancelling/removed
              // OR the message itself is abort-marked, this step did not succeed:
              // fail it as cancelled so the body unwinds as `cancelled` and the
              // settlement callbacks below never flip the node to `completed`.
              if (active.cancelling || active.removed || isAbortedMessage(message)) {
                return yield* Effect.die(new CancelledError())
              }
              const structured = message.info.role === "assistant" ? message.info.structured : undefined
              // A schema was requested ⇒ a structured result is mandatory. When the
              // session produced none (it set a StructuredOutputError on the message
              // and/or `structured` came back undefined) we MUST fail the step rather
              // than silently fall back to plaintext: a missing structured result is
              // a genuine step failure that has to surface (node `failed`, run fails
              // unless the module catches it). Non-schema agents are unaffected.
              if (agentInput.schema && structured === undefined) {
                const sessionMessage =
                  message.info.role === "assistant" && message.info.error?.name === "StructuredOutputError"
                    ? message.info.error.data.message
                    : undefined
                node.output = assistantText(message)
                const schemaText = JSON.stringify(agentInput.schema)
                return yield* new StructuredOutputError({
                  message: [
                    "Agent was asked for structured output but produced none",
                    sessionMessage ? `(${sessionMessage})` : undefined,
                    `expected a result matching the requested schema (${schemaText.length > 200 ? schemaText.slice(0, 200) + "…" : schemaText})`,
                  ]
                    .filter(Boolean)
                    .join(" "),
                })
              }
              node.output = structured !== undefined ? JSON.stringify(structured, null, 2) : assistantText(message)
              return {
                data: structured !== undefined ? structured : node.output,
                text: node.output,
              }
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (node.session_id) active.sessions.delete(node.session_id)
                  // Decrement the live budget by whatever this step ACTUALLY cost
                  // — the SAME `cost` (USD) the dashboard shows, set on the node
                  // from the assistant message above. Done in `ensuring` (not the
                  // success branch) so failed-but-paid steps (e.g. a structured-
                  // output failure that still incurred model cost) are charged too.
                  // EXCEPT a cancelled run: an abort-resolved step did not produce
                  // a real result and must not be charged (Fund 4) — and any cost
                  // on an aborted message is the abort artifact, not real spend.
                  // A step with no cost leaves the budget untouched; unset stays Infinity.
                  if (active.cancelling || active.removed) return
                  active.budgetRemaining -= node.cost ?? 0
                }),
              ),
            ),
          )
          .then(
            (result) => {
              // Settlement guard (Fund 4): once the run is cancelling/removed or
              // already terminal, the success branch is a NO-OP for the node and
              // emits NO further write. Otherwise a resolve-on-abort step (the
              // production runner resolves on abort) would flip a cancelled node
              // to `completed` and re-persist after the awaited terminal write.
              if (active.cancelling || active.removed || active.run.status !== "running") {
                throw new CancelledError()
              }
              node.status = "completed"
              node.completed_at = Date.now()
              node.output = result.text
              persistInScope(active, bridge, db)
              return result
            },
            (error) => {
              // Same guard on the failure path: do not mutate/persist the node
              // for a run that has already moved to (or is moving to) terminal —
              // finish() owns the node's terminal state in that case.
              if (active.cancelling || active.removed || active.run.status !== "running") {
                return Promise.reject(error)
              }
              node.status = "failed"
              node.completed_at = Date.now()
              node.error = errorText(error)
              persistInScope(active, bridge, db)
              return Promise.reject(error)
            },
          )
      }

      // Fund 5 (TOCTOU): a cancel/remove can land during the startup window —
      // after the run was registered but before the body fiber exists. In that
      // window abortRun set `cancelling`/closed the run scope and finish() already
      // moved the row to `cancelled`. Forking the body anyway would run the whole
      // workflow (burning tokens) under a row that already reports `cancelled`.
      // Re-check here and skip the fork entirely if a cancel has landed: the run
      // stays cancelled and the body never runs.
      if (active.cancelling || active.removed || active.run.status !== "running") {
        yield* Deferred.succeed(active.done, snapshot(active)).pipe(Effect.ignore)
        return snapshot(active)
      }

      active.fiber = yield* Effect.promise((signal) => {
        runSignal = signal
        return module.run(
          input.args ?? {},
          createContext({
            active,
            agent,
            persist: () => void persistInScope(active, bridge, db),
            signal: () => runSignal,
            dispatch,
          }),
        )
      }).pipe(
        Effect.matchCauseEffect({
          onSuccess: (result) => finish(id, "completed", { result }),
          onFailure: (cause) =>
            // A workflow module throwing CancelledError surfaces as a failure or
            // a defect depending on the path; squash returns the representative
            // error either way, so `isCancelled(squash)` catches both.
            finish(
              id,
              active.cancelling || active.removed || Cause.hasInterruptsOnly(cause) || isCancelled(Cause.squash(cause))
                ? "cancelled"
                : "failed",
              { error: errorText(Cause.squash(cause)) },
            ),
        }),
        Effect.asVoid,
        // Fork lazily (no `startImmediately`) so this returns the fiber handle
        // immediately. With `startImmediately` the runtime drives the run body
        // synchronously into the first agent step, blocking `start` and leaving
        // `active.fiber` unassigned (which would make cancel a no-op).
        Effect.forkIn(inst.scope),
      )
      return snapshot(active)
    })

    const wait: Interface["wait"] = Effect.fn("Workflow.wait")(function* (input) {
      const run = yield* get(input.id)
      if (!run) return { timedOut: false }
      // Terminal runs (completed/failed/cancelled/interrupted) resolve at once —
      // there is no fiber left to wait on, so never report a timeout for them.
      if (run.status !== "running") return { run, timedOut: false }

      const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      const active = live.get(input.id)
      // DB still says `running` but no live fiber owns it: an orphan. Sweep it to
      // `interrupted` and report that honestly instead of a misleading timeout.
      // Pass the live registry keys so genuinely-running siblings are untouched.
      if (!active) {
        yield* sweepOrphans(db, new Set(live.keys()), yield* Clock.currentTimeMillis, yield* InstanceState.directory)
        return { run: yield* get(input.id), timedOut: false }
      }
      if (input.timeout === undefined) return { run: yield* Deferred.await(active.done), timedOut: false }
      if (input.timeout <= 0) return { run: snapshot(active), timedOut: true }

      const done = yield* Deferred.await(active.done).pipe(Effect.timeoutOption(input.timeout))
      if (done._tag === "Some") return { run: done.value, timedOut: false }
      return { run: snapshot(active), timedOut: true }
    })

    // Race-free cancel. The order matters and every step is idempotent.
    // (0) Set `cancelling` FIRST — unconditionally, even when there is no fiber
    //     yet (startup window, Fund 5): the gates in agent()/checkpoint() and the
    //     settlement guards all key off it, and start() re-checks it before
    //     forking the body, so a cancel that lands during startup still wins.
    // (1) Abort every tracked child agent session via PromptOps.cancel from a
    //     LIVE view of `active.sessions` (not a one-shot snapshot, Fund 16): this
    //     is what actually stops the in-flight agent (same path as TUI Esc / HTTP
    //     abort); the production runner then RESOLVES the prompt and the agent
    //     step is recognised as cancelled. Sessions registered during this window
    //     additionally self-abort in agent() because `cancelling` is already set.
    // (2) Close the run scope: this propagates Interrupt into EVERY agent/parallel/
    //     pipeline fiber forked into it (Fund 14) — including ones started but not
    //     yet session-registered (Fund 16) and ones that have no cancel vector
    //     (Fund 50, where the scope close is the only thing that stops them).
    // (3) Interrupt the run fiber so checkpoint() unwinds the body, then await it.
    const abortRun = Effect.fn("Workflow.abortRun")(function* (active: Active) {
      active.cancelling = true
      const cancelSession = active.cancelSession
      if (cancelSession) {
        yield* Effect.forEach([...active.sessions], (sessionID) => cancelSession(SessionID.make(sessionID)), {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.ignore)
      }
      // Closing the run scope interrupts all dispatched agent work; it is safe to
      // close even with no live fiber (startup window). Forked so a slow finalizer
      // cannot wedge cancel.
      const scope = (yield* InstanceState.get(state)).scope
      const closed = yield* Scope.close(active.runScope, Exit.void).pipe(Effect.ignore, Effect.forkIn(scope))
      const interrupted = active.fiber
        ? yield* Fiber.interrupt(active.fiber).pipe(Effect.forkIn(scope))
        : undefined
      if (interrupted) yield* Fiber.await(interrupted).pipe(Effect.ignore)
      yield* Fiber.await(closed).pipe(Effect.ignore)
      if (active.fiber) yield* Fiber.await(active.fiber).pipe(Effect.ignore)
    })

    const cancel: Interface["cancel"] = Effect.fn("Workflow.cancel")(function* (id) {
      const active = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)).get(id)
      if (!active) return
      if (active.run.status !== "running") return snapshot(active)
      yield* abortRun(active)
      return yield* finish(id, "cancelled")
    })

    const remove: Interface["remove"] = Effect.fn("Workflow.remove")(function* (id) {
      const inst = yield* InstanceState.get(state)
      const active = (yield* SynchronizedRef.get(inst.runs)).get(id)
      // A registered run is cancelled first (abort agent sessions + close the run
      // scope + interrupt the fiber) so delete cannot block on in-flight work and
      // no agent keeps running.
      if (active) {
        // Fund 3: set the tombstone BEFORE the delete. abortRun closes the run
        // scope, which interrupts dispatched agent fibers; their settlement
        // writes are forked into that same scope and may run AFTER the delete.
        // `persistRun` checks `removed` at execution time and NO-OPs, so a late
        // write can never re-INSERT (resurrect) the row.
        active.removed = true
        yield* abortRun(active)
        yield* finish(id, "cancelled").pipe(Effect.ignore)
      }
      yield* SynchronizedRef.update(inst.runs, (runs) => {
        const next = new Map(runs)
        next.delete(id)
        return next
      })
      // Scope both the existence probe and the delete to the calling workspace
      // (Fund 6): `DELETE …?directory=B` must NEVER delete a row owned by A and
      // report success. The `id` predicate alone would delete across directories
      // because the DB is global; adding the directory equality makes the delete
      // a no-op for a foreign row, and `row` (the scoped probe) stays undefined so
      // a cross-directory remove honestly reports `false`.
      const directory = yield* InstanceState.directory
      const scope = and(eq(WorkflowRunTable.id, id), eq(WorkflowRunTable.directory, directory))
      const row = yield* db.select().from(WorkflowRunTable).where(scope).get().pipe(Effect.orDie)
      yield* db.delete(WorkflowRunTable).where(scope).run().pipe(Effect.orDie)
      return !!row || !!active
    })

    const sweep: Interface["sweep"] = Effect.fn("Workflow.sweep")(function* () {
      const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      yield* sweepOrphans(db, new Set(live.keys()), yield* Clock.currentTimeMillis, yield* InstanceState.directory)
    })

    return Service.of({ list, runs, get, start, wait, cancel, remove, sweep })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as Workflow from "./workflow"
