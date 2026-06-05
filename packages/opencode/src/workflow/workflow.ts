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
import type {
  WorkflowAgentRow,
  WorkflowDefinitionRow,
  WorkflowLogRow,
} from "@opencode-ai/core/workflow/sql"
import { Glob } from "@opencode-ai/core/util/glob"
import { and, desc, eq, notInArray } from "drizzle-orm"
import { APICallError } from "ai"
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

export const Argument = Schema.Struct({
  type: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
}).annotate({ identifier: "WorkflowArgument" })
export type Argument = Schema.Schema.Type<typeof Argument>

export const Meta = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  phases: Schema.optional(Schema.Array(Schema.String)),
  arguments: Schema.optional(Schema.Record(Schema.String, Argument)),
}).annotate({ identifier: "WorkflowMeta" })
export type Meta = Schema.Schema.Type<typeof Meta>

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
export class BudgetExceededError extends Schema.TaggedErrorClass<BudgetExceededError>()(
  "WorkflowBudgetExceededError",
  {
    message: Schema.String,
    budget: Schema.Finite,
    spent: Schema.Finite,
  },
) {}

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
  done: Deferred.Deferred<Run>
  fiber?: Fiber.Fiber<void, unknown>
  /** Child agent sessions currently in flight; aborted on cancel/remove. */
  sessions: Set<string>
  /** Session-abort vector for this run (the prompt-ops `cancel`); undefined when no prompt-ops were supplied. */
  cancelSession?: (sessionID: SessionID) => Effect.Effect<void>
  /** Set once a cancel/remove has been requested so the run finishes as `cancelled`, never `failed`. */
  cancelling?: boolean
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
    result: row.result ?? undefined,
    error: row.error ?? undefined,
  }
}

function persistRun(db: Database.Interface["db"], active: Active) {
  // The snapshot MUST be built at execution time (inside Effect.suspend), not
  // at effect-construction time: progress writes are forked into the instance
  // scope and may execute AFTER the awaited terminal write in `finish`. A
  // snapshot captured at construction would then revert the row to a stale
  // state (live-found regression: a completed run's row flipped back to
  // `running`). Reading `active.run` at execution time makes every write a
  // full snapshot of the CURRENT state, so any write ordering converges on
  // the final row.
  return Effect.suspend(() => {
    const data = {
      id: active.run.id,
      session_id: active.run.session_id ?? null,
      workflow: active.run.workflow,
      status: active.run.status,
      started_at: active.run.started_at,
      completed_at: active.run.completed_at ?? null,
      current_phase: active.run.current_phase ?? null,
      args: active.run.args ?? null,
      definition: active.run.definition ?? null,
      logs: active.run.logs,
      agents: active.run.agents,
      result: active.run.result ?? null,
      error: active.run.error ?? null,
    }
    return db.insert(WorkflowRunTable).values(data).onConflictDoUpdate({
      target: WorkflowRunTable.id,
      set: { ...data, time_updated: Date.now() },
    }).run()
  }).pipe(Effect.orDie)
}

/**
 * Forks a progress-snapshot write as a child of the instance scope, so the
 * fiber is tracked and torn down with the instance instead of leaking as a
 * detached root fiber. Interrupt-on-dispose is safe for these writes: every
 * `persistRun` is an idempotent full-state upsert, the terminal write in
 * `finish` is awaited inline, and the startup orphan sweep heals any run whose
 * last progress snapshot was cut short.
 */
function persistInScope(
  scope: Scope.Scope,
  bridge: EffectBridge.Shape,
  db: Database.Interface["db"],
  active: Active,
) {
  bridge.fork(persistRun(db, active).pipe(Effect.forkIn(scope)))
}

/**
 * Rewrites every `running` row whose id is not in `liveIds` to `interrupted`
 * with a completion timestamp in a single bulk UPDATE. Used by the startup sweep
 * (liveIds empty) and the exposed `sweep()` method (liveIds = currently active
 * runs); genuinely-running rows owned by a live fiber are left untouched.
 */
function sweepOrphans(db: Database.Interface["db"], liveIds: ReadonlySet<string>, now: number) {
  return db
    .update(WorkflowRunTable)
    .set({ status: "interrupted", completed_at: now, time_updated: now })
    .where(
      and(
        eq(WorkflowRunTable.status, "running"),
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

// Each call imports the file fresh, keyed by its current mtime, so a workflow
// edited between calls is always reloaded. We deliberately do NOT keep a
// cross-call module cache: Bun's module cache is not reliably invalidated by a
// `?mtime=` query alone, so caching the imported module by mtime can serve a
// stale `run`/`meta` after an edit (the realtime-update bug). Correctness over
// micro-optimization — the double-load that motivated Befund #4 is already gone
// because start() now loads only the target module instead of calling list().
async function loadModule(file: string): Promise<Module> {
  const mtimeMs = (await Bun.file(file).stat()).mtimeMs
  const imported = (await import(`${pathToFileURL(file).href}?mtime=${mtimeMs}`)) as Record<string, unknown>
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

async function discover(directories: readonly string[]) {
  const entries = await Promise.all(
    directories.map(async (dir) =>
      (
        await Promise.all(
          ["workflows/*.ts", "workflows/*.js"].map((pattern) =>
            Glob.scan(pattern, { cwd: dir, absolute: true, dot: true, symlink: true }),
          ),
        )
      )
        .flat(),
    ),
  )
  return entries
    .flat()
    .map((file) => ({
      name: path.basename(file, path.extname(file)),
      path: file,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
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
  /** Bridge used to run the task/step graph via Effect.forEach concurrency. */
  bridge: EffectBridge.Shape
}): ContextApi {
  const checkpoint = () => {
    if (input.signal()?.aborted) throw new CancelledError()
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
      // and never run. Note: a task already in flight is NOT force-interrupted —
      // it runs to completion (or, if it is an agent step, is aborted for real
      // via PromptOps.cancel on its child session). This is deliberate: the
      // bridge runs each task as its own root fiber, not a child of active.fiber.
      return input.bridge.promise(
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
      // each stage so the next stage never starts after cancel; a stage already in
      // flight runs to completion (agent stages are additionally aborted for real
      // via PromptOps.cancel) — the bridge runs the work as a root fiber, not a
      // child of active.fiber, so interruption does not propagate down the tree.
      return input.bridge.promise(
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
      Effect.fn("Workflow.state")(function* () {
        const runs = yield* SynchronizedRef.make(new Map<string, Active>())
        // The registry is freshly empty here: any row still marked `running`
        // belongs to a fiber that did not survive into this process, so sweep
        // every one of them to `interrupted` (honest orphan recovery on start).
        yield* sweepOrphans(db, new Set(), yield* Clock.currentTimeMillis)
        return {
          runs,
          scope: yield* Scope.Scope,
        }
      }),
    )

    const readRuns = Effect.fn("Workflow.readRuns")(function* () {
      const active = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      const rows = yield* db.select().from(WorkflowRunTable).orderBy(desc(WorkflowRunTable.started_at)).all().pipe(Effect.orDie)
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
    const discoverWorkflows = Effect.fn("Workflow.discover")(function* () {
      const ctx = yield* InstanceState.context
      const directories = [...new Set([...(yield* config.directories()), projectConfigDir(ctx)])]
      return yield* Effect.promise(() => discover(directories))
    })

    const list: Interface["list"] = Effect.fn("Workflow.list")(function* () {
      const workflows = yield* discoverWorkflows()
      // Per-file error isolation: each file is loaded inside Effect.result so a
      // failure becomes an `{ valid: false, error }` entry instead of aborting
      // the whole list. One broken file (bad meta / missing run / syntax error)
      // therefore never makes the entire list — and, transitively, every
      // workflow — unloadable. loadModule rejects with InvalidError on bad meta /
      // missing run and with the raw load error on a syntax error.
      return yield* Effect.forEach(
        workflows,
        (workflow) =>
          Effect.tryPromise({
            try: () => loadModule(workflow.path),
            catch: (error) =>
              isInvalidError(error) ? error : new InvalidError({ path: workflow.path, message: errorText(error) }),
          }).pipe(
            Effect.result,
            Effect.map((result): Info =>
              result._tag === "Success"
                ? { ...workflow, meta: result.success.meta, valid: true }
                : {
                    ...workflow,
                    // Synthesize a minimal meta so the schema stays satisfied and
                    // consumers can still show the file's name; `valid: false`
                    // signals the entry is not runnable.
                    meta: { name: workflow.name },
                    valid: false,
                    error: result.failure.message,
                  },
            ),
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
      const row = yield* db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, id)).get().pipe(Effect.orDie)
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
      yield* persistRun(db, active)
      yield* Deferred.succeed(active.done, snapshot(active)).pipe(Effect.ignore)
      return snapshot(active)
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
      const id = RunID.ascending()
      const started_at = yield* Clock.currentTimeMillis
      const session = yield* sessions.create({ title: `Workflow: ${module.meta.name}` })
      const done = yield* Deferred.make<Run>()
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
        done,
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

      const agent = async (agentInput: AgentInput) => {
        if (runSignal?.aborted) throw new CancelledError()
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
        persistInScope(inst.scope, bridge, db, active)
        const prompt = input.prompt
        if (!prompt) throw new Error("Workflow agent execution requires prompt operations")
        return bridge
          .promise(
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
              const structured =
                message.info.role === "assistant" ? message.info.structured : undefined
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
              node.output =
                structured !== undefined ? JSON.stringify(structured, null, 2) : assistantText(message)
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
                  // output failure that still incurred model cost) and interrupted
                  // steps are charged too. A step with no cost (cost undefined)
                  // leaves the budget untouched; an unset budget stays Infinity.
                  active.budgetRemaining -= node.cost ?? 0
                }),
              ),
            ),
          )
          .then(
            (result) => {
              node.status = "completed"
              node.completed_at = Date.now()
              node.output = result.text
              persistInScope(inst.scope, bridge, db, active)
              return result
            },
            (error) => {
              node.status = "failed"
              node.completed_at = Date.now()
              node.error = errorText(error)
              persistInScope(inst.scope, bridge, db, active)
              return Promise.reject(error)
            },
          )
      }

      active.fiber = yield* Effect.promise((signal) => {
        runSignal = signal
        return module.run(
          input.args ?? {},
          createContext({
            active,
            agent,
            persist: () => void persistInScope(inst.scope, bridge, db, active),
            signal: () => runSignal,
            bridge,
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
              active.cancelling || Cause.hasInterruptsOnly(cause) || isCancelled(Cause.squash(cause))
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
        yield* sweepOrphans(db, new Set(live.keys()), yield* Clock.currentTimeMillis)
        return { run: yield* get(input.id), timedOut: false }
      }
      if (input.timeout === undefined) return { run: yield* Deferred.await(active.done), timedOut: false }
      if (input.timeout <= 0) return { run: snapshot(active), timedOut: true }

      const done = yield* Deferred.await(active.done).pipe(Effect.timeoutOption(input.timeout))
      if (done._tag === "Some") return { run: done.value, timedOut: false }
      return { run: snapshot(active), timedOut: true }
    })

    // Two-stage cancel. (1) Interrupt the run fiber: this fires its AbortSignal,
    // which makes checkpoint() throw CancelledError before the NEXT ctx step, so
    // no follow-up step starts. It does NOT reach the in-flight agent — that runs
    // as a detached root fiber via bridge.promise, not a child of active.fiber.
    // (2) Abort every tracked child agent session via PromptOps.cancel; that is
    // what actually stops the in-flight agent (same path as TUI Esc / HTTP abort)
    // and unblocks its promise so module.run can unwind and the fiber completes.
    // Only after both do we await the fiber.
    const abortRun = Effect.fn("Workflow.abortRun")(function* (active: Active) {
      if (!active.fiber) return
      active.cancelling = true
      const scope = (yield* InstanceState.get(state)).scope
      const interrupted = yield* Fiber.interrupt(active.fiber).pipe(Effect.forkIn(scope))
      const cancelSession = active.cancelSession
      if (cancelSession) {
        yield* Effect.forEach([...active.sessions], (sessionID) => cancelSession(SessionID.make(sessionID)), {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.ignore)
      }
      yield* Fiber.await(interrupted).pipe(Effect.ignore)
      yield* Fiber.await(active.fiber).pipe(Effect.ignore)
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
      // A running run is cancelled first (interrupt + abort agent sessions) so
      // delete cannot block on the in-flight run and no agent keeps running.
      if (active?.fiber) {
        yield* abortRun(active)
        yield* finish(id, "cancelled").pipe(Effect.ignore)
      }
      yield* SynchronizedRef.update(inst.runs, (runs) => {
        const next = new Map(runs)
        next.delete(id)
        return next
      })
      const row = yield* db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, id)).get().pipe(Effect.orDie)
      yield* db.delete(WorkflowRunTable).where(eq(WorkflowRunTable.id, id)).run().pipe(Effect.orDie)
      return !!row || !!active
    })

    const sweep: Interface["sweep"] = Effect.fn("Workflow.sweep")(function* () {
      const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      yield* sweepOrphans(db, new Set(live.keys()), yield* Clock.currentTimeMillis)
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
