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
import type { DeepMutable } from "@opencode-ai/core/schema"
import { Glob } from "@opencode-ai/core/util/glob"
import { desc, eq } from "drizzle-orm"
import { APICallError } from "ai"
import path from "path"
import { pathToFileURL } from "url"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Schema, SynchronizedRef } from "effect"
import { WorkflowRunTable } from "./workflow.sql"

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

export const Status = Schema.Literals(["running", "completed", "failed", "cancelled"])
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

export const Run = Schema.Struct({
  id: Schema.String,
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
  id: string
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
 * Thrown inside a workflow module when the run has been cancelled. It unwinds
 * `module.run` (and any in-flight `ctx.parallel`/`ctx.pipeline` step) so the
 * follow-up step never starts. Surfaced as an interrupt-only cause so the run
 * is finished as `cancelled` rather than `failed`.
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

export type ContextApi = {
  readonly budgetRemaining: number
  readonly setPhase: (phase: string) => void
  readonly log: (message: string) => void
  readonly parallel: <T>(tasks: readonly (() => Promise<T>)[], options?: { concurrencyLimit?: number }) => Promise<T[]>
  readonly pipeline: <T>(items: readonly T[], steps: readonly ((item: T) => Promise<T>)[]) => Promise<T[]>
  readonly agent: (input: AgentInput) => Promise<{ data: unknown; text: string }>
}

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
}

type State = {
  runs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[], InvalidError>
  readonly runs: () => Effect.Effect<Run[]>
  readonly get: (id: string) => Effect.Effect<Run | undefined>
  readonly start: (input: StartOptions) => Effect.Effect<Run, InvalidError | NotFoundError>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly cancel: (id: string) => Effect.Effect<Run | undefined>
  readonly remove: (id: string) => Effect.Effect<boolean>
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
    id: row.id,
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
  return db
    .insert(WorkflowRunTable)
    .values(data)
    .onConflictDoUpdate({
      target: WorkflowRunTable.id,
      set: { ...data, time_updated: Date.now() },
    })
    .run()
    .pipe(Effect.orDie)
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

function isCancelledCause(cause: Cause.Cause<unknown>): boolean {
  // A workflow module throwing CancelledError surfaces as a failure or a defect
  // depending on the path; squash returns the representative error either way.
  return isCancelled(Cause.squash(cause))
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

async function loadModule(file: string): Promise<Module> {
  const imported = (await import(
    `${pathToFileURL(file).href}?mtime=${(await Bun.file(file).stat()).mtimeMs}`
  )) as Record<string, unknown>
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
  /** Runs an Effect on the run fiber's runtime (used for Effect concurrency). */
  bridge: EffectBridge.Shape
}): ContextApi {
  const checkpoint = () => {
    if (input.signal()?.aborted) throw new CancelledError()
  }
  return {
    budgetRemaining: Number.POSITIVE_INFINITY,
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
      // Run on Effect concurrency inside the run fiber's runtime so interruption
      // propagates; each task is gated by the run's abort signal before it runs.
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
    pipeline<T>(items: readonly T[], steps: readonly ((item: T) => Promise<T>)[]) {
      checkpoint()
      return input.bridge.promise(
        Effect.forEach(
          items,
          (item) =>
            Effect.promise(async () => {
              let current = item
              for (const step of steps) {
                checkpoint()
                current = await step(current)
              }
              return current
            }),
          { concurrency: "unbounded" },
        ),
      )
    },
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
        return {
          runs: yield* SynchronizedRef.make(new Map()),
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

    const list: Interface["list"] = Effect.fn("Workflow.list")(function* () {
      const ctx = yield* InstanceState.context
      const directories = [...new Set([...(yield* config.directories()), projectConfigDir(ctx)])]
      const workflows = yield* Effect.promise(() => discover(directories))
      return yield* Effect.forEach(
        workflows,
        (workflow) =>
          Effect.promise(() => loadModule(workflow.path)).pipe(
            Effect.map((module) => ({ ...workflow, meta: module.meta })),
            Effect.mapError((error) =>
              isInvalidError(error) ? error : new InvalidError({ path: workflow.path, message: errorText(error) }),
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
      id: string,
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
      const workflows = yield* list()
      const workflow = workflows.find((item) => item.name === input.name)
      if (!workflow) return yield* new NotFoundError({ name: input.name })
      const module = yield* Effect.promise(() => loadModule(workflow.path)).pipe(
        Effect.mapError((error) =>
          isInvalidError(error) ? error : new InvalidError({ path: workflow.path, message: errorText(error) }),
        ),
      )
      const inst = yield* InstanceState.get(state)
      const id = Identifier.ascending("job")
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
        bridge.fork(persistRun(db, active))
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
              node.output =
                message.info.role === "assistant" && message.info.structured !== undefined
                  ? JSON.stringify(message.info.structured, null, 2)
                  : assistantText(message)
              if (message.info.role === "assistant") {
                node.model = `${message.info.providerID}/${message.info.modelID}`
                node.cost = message.info.cost
                node.tokens = message.info.tokens
              }
              return {
                data:
                  message.info.role === "assistant" && message.info.structured !== undefined
                    ? message.info.structured
                    : node.output,
                text: node.output,
              }
            }).pipe(Effect.ensuring(Effect.sync(() => node.session_id && active.sessions.delete(node.session_id)))),
          )
          .then(
            (result) => {
              node.status = "completed"
              node.completed_at = Date.now()
              node.output = result.text
              bridge.fork(persistRun(db, active))
              return result
            },
            (error) => {
              node.status = "failed"
              node.completed_at = Date.now()
              node.error = errorText(error)
              bridge.fork(persistRun(db, active))
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
            persist: () => void bridge.fork(persistRun(db, active)),
            signal: () => runSignal,
            bridge,
          }),
        )
      }).pipe(
        Effect.matchCauseEffect({
          onSuccess: (result) => finish(id, "completed", { result }),
          onFailure: (cause) =>
            finish(
              id,
              active.cancelling || Cause.hasInterruptsOnly(cause) || isCancelledCause(cause) ? "cancelled" : "failed",
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
      if (run.status !== "running") return { run, timedOut: false }

      const active = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)).get(input.id)
      if (!active) return { run, timedOut: true }
      if (input.timeout === undefined) return { run: yield* Deferred.await(active.done), timedOut: false }
      if (input.timeout <= 0) return { run: snapshot(active), timedOut: true }

      const done = yield* Deferred.await(active.done).pipe(Effect.timeoutOption(input.timeout))
      if (done._tag === "Some") return { run: done.value, timedOut: false }
      return { run: snapshot(active), timedOut: true }
    })

    // Two-stage interruption: (1) interrupt the run fiber so its AbortSignal
    // fires (gates ctx steps), then (2) abort every tracked child agent session
    // via the prompt-ops cancel — that unblocks the detached agent promise so
    // module.run can unwind and the fiber actually completes. Only after both
    // do we await the fiber.
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

    return Service.of({ list, runs, get, start, wait, cancel, remove })
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
