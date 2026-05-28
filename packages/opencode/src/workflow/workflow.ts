import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { Database, desc } from "@/storage/db"
import type { DeepMutable } from "@opencode-ai/core/schema"
import { Glob } from "@opencode-ai/core/util/glob"
import { eq } from "drizzle-orm"
import { APICallError } from "ai"
import path from "path"
import { pathToFileURL } from "url"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
  Schema,
  SynchronizedRef,
} from "effect"
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

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("WorkflowNotFoundError", {
  name: Schema.String,
}) {}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("WorkflowInvalidError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export type AgentInput = {
  agent?: string
  prompt: string
  model?: string
  schema?: Record<string, unknown>
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
  args?: Record<string, unknown>
  fiber?: Fiber.Fiber<void, unknown>
}

type State = {
  runs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[], InvalidError>
  readonly runs: () => Effect.Effect<Run[]>
  readonly get: (id: string) => Effect.Effect<Run | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Run, InvalidError | NotFoundError>
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

function persistRun(active: Active) {
  Database.use((db) =>
    db
      .insert(WorkflowRunTable)
      .values({
        id: active.run.id,
        session_id: active.run.session_id ?? null,
        workflow: active.run.workflow,
        status: active.run.status,
        started_at: active.run.started_at,
        completed_at: active.run.completed_at ?? null,
        current_phase: active.run.current_phase ?? null,
        args: active.args ?? null,
        logs: active.run.logs,
        agents: active.run.agents,
        result: active.run.result ?? null,
        error: active.run.error ?? null,
      })
      .onConflictDoUpdate({
        target: WorkflowRunTable.id,
        set: {
          workflow: active.run.workflow,
          session_id: active.run.session_id ?? null,
          status: active.run.status,
          started_at: active.run.started_at,
          completed_at: active.run.completed_at ?? null,
          current_phase: active.run.current_phase ?? null,
          args: active.args ?? null,
          logs: active.run.logs,
          agents: active.run.agents,
          result: active.run.result ?? null,
          error: active.run.error ?? null,
          time_updated: Date.now(),
        },
      })
      .run(),
  )
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

async function loadModule(file: string): Promise<Module> {
  const imported = (await import(
    `${pathToFileURL(file).href}?mtime=${(await Bun.file(file).stat()).mtimeMs}`
  )) as Record<string, unknown>
  const module = (typeof imported.default === "object" && imported.default !== null ? imported.default : imported) as Record<
    string,
    unknown
  >
  const parsed = decodeMeta(module.meta, { errors: "all", propertyOrder: "original" })
  if (Exit.isFailure(parsed)) throw new InvalidError({ path: file, message: Cause.pretty(parsed.cause) })
  if (typeof module.run !== "function")
    throw new InvalidError({ path: file, message: "Missing run(args, ctx) export" })
  return {
    meta: parsed.value,
    run: module.run as Module["run"],
  }
}

function assistantText(message: MessageV2.WithParts) {
  return message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && part.text.trim().length > 0)
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
        .flat()
        .map((file) => ({
          dir,
          file,
        })),
    ),
  )
  return entries
    .flat()
    .map((entry) => ({
      name: path.basename(entry.file, path.extname(entry.file)),
      path: entry.file,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

function createContext(input: {
  active: Active
  agent: (input: AgentInput) => Promise<{ data: unknown; text: string }>
  persist: () => void
}): ContextApi {
  const limit = 4
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
    async parallel<T>(tasks: readonly (() => Promise<T>)[], options?: { concurrencyLimit?: number }) {
      const concurrency = Math.max(1, options?.concurrencyLimit ?? limit)
      const results: T[] = []
      let index = 0
      await Promise.all(
        Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
          while (index < tasks.length) {
            const current = index++
            results[current] = await tasks[current]()
          }
        }),
      )
      return results
    },
    async pipeline<T>(items: readonly T[], steps: readonly ((item: T) => Promise<T>)[]) {
      return Promise.all(
        items.map(async (item) => {
          let current = item
          for (const step of steps) current = await step(current)
          return current
        }),
      )
    },
    agent: input.agent,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
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
      const rows = Database.use((db) =>
        db.select().from(WorkflowRunTable).orderBy(desc(WorkflowRunTable.started_at)).all(),
      )
      return rows
        .map(fromRow)
        .map((run) => {
          const live = active.get(run.id)
          return live ? snapshot(live) : run
        })
        .toSorted((a, b) => b.started_at - a.started_at)
    })

    const list: Interface["list"] = Effect.fn("Workflow.list")(function* () {
      const directories = yield* config.directories()
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
      const row = Database.use((db) => db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, id)).get())
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
      persistRun(active)
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
      const s = yield* InstanceState.get(state)
      const id = Identifier.ascending("job")
      const started_at = yield* Clock.currentTimeMillis
      const session = yield* sessions.create({ title: `Workflow: ${module.meta.name}` })
      const done = yield* Deferred.make<Run>()
      const active: Active = {
        run: {
          id,
          session_id: session.id,
          workflow: workflow.name,
          status: "running",
          started_at,
          logs: [],
          agents: [],
        },
        done,
        args: input.args ?? undefined,
      }
      yield* SynchronizedRef.update(s.runs, (runs) => new Map(runs).set(id, active))
      persistRun(active)
      yield* prompts
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
      const bridge = yield* EffectBridge.make()

      const agent = (agentInput: AgentInput) => {
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
        persistRun(active)
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
              persistRun(active)
              const message = yield* prompts.prompt({
                sessionID: session.id,
                agent: selected.name,
                model: modelInfo,
                format: agentInput.schema ? { type: "json_schema", schema: agentInput.schema } : undefined,
                parts: [{ type: "text", text: agentInput.prompt }],
              })
              node.message_id = message.info.id
              node.output = message.info.role === "assistant" && message.info.structured !== undefined ? JSON.stringify(message.info.structured, null, 2) : assistantText(message)
              if (message.info.role === "assistant") {
                node.model = `${message.info.providerID}/${message.info.modelID}`
                node.cost = message.info.cost
                node.tokens = message.info.tokens
              }
              return {
                data: message.info.role === "assistant" && message.info.structured !== undefined ? message.info.structured : node.output,
                text: node.output,
              }
            }),
          )
          .then(
            (result) => {
              node.status = "completed"
              node.completed_at = Date.now()
              node.output = result.text
              persistRun(active)
              return result
            },
            (error) => {
              node.status = "failed"
              node.completed_at = Date.now()
              node.error = errorText(error)
              persistRun(active)
              return Promise.reject(error)
            },
          )
      }

      active.fiber = yield* Effect.promise(() =>
        module.run(input.args ?? {}, createContext({ active, agent, persist: () => persistRun(active) })),
      ).pipe(
        Effect.matchCauseEffect({
          onSuccess: (result) => finish(id, "completed", { result }),
          onFailure: (cause) =>
            finish(id, Cause.hasInterruptsOnly(cause) ? "cancelled" : "failed", {
              error: errorText(Cause.squash(cause)),
            }),
        }),
        Effect.asVoid,
        Effect.forkIn(s.scope, { startImmediately: true }),
      )
      return snapshot(active)
    })

    const cancel: Interface["cancel"] = Effect.fn("Workflow.cancel")(function* (id) {
      const active = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)).get(id)
      if (!active) return
      if (active.run.status !== "running") return snapshot(active)
      if (active.fiber) {
        yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore)
        yield* Fiber.await(active.fiber).pipe(Effect.ignore)
      }
      return yield* finish(id, "cancelled")
    })

    const remove: Interface["remove"] = Effect.fn("Workflow.remove")(function* (id) {
      const s = yield* InstanceState.get(state)
      const active = (yield* SynchronizedRef.get(s.runs)).get(id)
      if (active?.fiber) {
        yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore)
        yield* Fiber.await(active.fiber).pipe(Effect.ignore)
      }
      yield* SynchronizedRef.update(s.runs, (runs) => {
        const next = new Map(runs)
        next.delete(id)
        return next
      })
      const row = Database.use((db) => db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, id)).get())
      Database.use((db) => db.delete(WorkflowRunTable).where(eq(WorkflowRunTable.id, id)).run())
      return !!row || !!active
    })

    return Service.of({ list, runs, get, start, cancel, remove })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionPrompt.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as Workflow from "./workflow"
