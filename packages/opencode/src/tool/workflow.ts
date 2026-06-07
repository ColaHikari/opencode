import { BackgroundJob } from "@/background/job"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Session } from "@/session/session"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { createTwoFilesPatch } from "diff"
import path from "path"
import { Cause, Effect, Schema, Scope } from "effect"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import { trimDiff } from "./edit"
import { Workflow } from "@/workflow/workflow"
import { MetaReader } from "@/workflow/meta-reader"
import { Agent } from "@/agent/agent"

const WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const DEFAULT_TIMEOUT = 60 * 60 * 1000

const Action = Schema.Literals(["read", "start", "wait", "inspect", "create"])
const InspectView = Schema.Literals(["summary", "logs", "agents", "agent", "result", "all"])

const Parameters = Schema.Struct({
  action: Action.annotate({
    description: "Workflow operation to perform: read, start, wait, inspect, or create",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "Workflow name for read/start/create. For create, this is the file name without extension.",
  }),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Workflow input arguments as a JSON object",
  }),
  // Non-negative finite, mirroring the engine/HTTP budget schema: a plain
  // Schema.Number would accept NaN/±Infinity, and a NaN cap makes the gate
  // (budgetRemaining <= 0) silently never trip — i.e. unlimited spend.
  budget: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description:
      "Optional cost cap in USD for the whole run. Agent steps stop with a budget error once the cumulative cost reaches this cap. Omit for unlimited.",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Start the workflow asynchronously and notify this session when it finishes",
  }),
  // Non-negative finite, mirroring the budget field above: a plain Schema.Number
  // accepts NaN/±Infinity. timeout:Infinity would override the 1h DEFAULT_TIMEOUT
  // cap (wait hangs forever); NaN slips past the engine's `<=0` guard (NaN<=0 is
  // false) so wait times out at once yet still reports "still running". Rejecting
  // both at the argument boundary keeps the wait bound honest.
  timeout: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Maximum milliseconds to wait for foreground start/wait before returning the running state",
  }),
  run_id: Schema.optional(Schema.String).annotate({
    description: "Workflow run id for wait/inspect",
  }),
  view: Schema.optional(InspectView).annotate({
    description: "Which part of the run to inspect: summary, logs, agents, agent, result, or all",
  }),
  agent_id: Schema.optional(Schema.String).annotate({
    description: "Agent run id to inspect when view is agent",
  }),
  source: Schema.optional(Schema.String).annotate({
    description: "Complete TypeScript workflow source for create",
  }),
  overwrite: Schema.optional(Schema.Boolean).annotate({ description: "Overwrite an existing workflow file" }),
  resume_of: Schema.optional(Schema.String).annotate({
    description:
      "Resume a previous (paused/interrupted) workflow run by its run id; the engine replays that run's completed agent journal instead of re-running them.",
  }),
  invalidate_agents: Schema.optional(Schema.Array(Schema.Int)).annotate({
    description:
      "Agent indices (0-based, in the source run's order) to force live re-execution of during a resume. Only meaningful with resume_of.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Metadata = Record<string, unknown>

const DESCRIPTION = [
  "Manage project-local workflows through one action-based tool.",
  "Do not use workflows by default. Use this only when the user explicitly asks for a workflow, asks to create one, or confirms workflow automation.",
  "Actions:",
  "- read: return workflow metadata, arguments, phases, and path; use before start if behavior is unclear.",
  "- start: start an existing workflow. Foreground waits for completion by default; background=true returns immediately and injects a completion message later.",
  "- wait: wait for a running workflow by run_id.",
  "- inspect: inspect workflow history, logs, agents, a specific agent, result, or all details.",
  "- create: write a persistent .opencode/workflows/<name>.ts workflow file.",
].join("\n")

function promptOps(ctx: Tool.Context) {
  const ops = ctx.extra?.promptOps
  if (typeof ops === "object" && ops !== null && typeof Reflect.get(ops, "prompt") === "function") {
    return ops as Workflow.PromptOps
  }
  throw new Error("Workflow tools require prompt operations in the current session")
}

function workflowError(error: Workflow.InvalidError | Workflow.NotFoundError) {
  if (error._tag === "WorkflowInvalidError") return new Error(`Invalid workflow ${error.path}: ${error.message}`)
  return new Error(`Workflow not found: ${error.name}`)
}

// Fund 56: the inspect/result/agents/logs output is a pseudo-XML envelope built
// by string interpolation, and several interpolated fields are model- or
// attacker-controlled (a subagent's prompt/output/error, the workflow result,
// run args, log messages, the workflow source). Without escaping, a crafted
// value containing literal `</output></agents><result>…` could forge the
// envelope structure (prompt-injection of the reader).
//
// TEXT content only needs `& < >` escaped — the forging vector relies on `<`/`>`
// to open/close tags, and `&` is escaped so the escaping itself is unambiguous.
// `"`/`'` are deliberately left intact in text so embedded JSON (args/result)
// stays readable.
function escapeXmlText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

// ATTRIBUTE values additionally escape the quote characters so an untrusted value
// can never break out of the `="…"` it sits in.
function escapeXmlAttr(value: string) {
  return escapeXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}

// Untrusted structured values (args/result/tokens) are JSON-stringified, then the
// rendering is escaped as text so the serialized output cannot break the envelope
// while keeping its quotes readable.
function formatUnknown(value: unknown) {
  if (value === undefined) return ""
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value))
  return escapeXmlText(text)
}

function formatWorkflow(info: Workflow.Info) {
  return [
    `<workflow name="${escapeXmlAttr(info.name)}">`,
    `<path>${escapeXmlText(info.path)}</path>`,
    `<display_name>${escapeXmlText(info.meta.name)}</display_name>`,
    info.meta.description ? `<description>${escapeXmlText(info.meta.description)}</description>` : undefined,
    info.meta.whenToUse ? `<when_to_use>${escapeXmlText(info.meta.whenToUse)}</when_to_use>` : undefined,
    info.meta.phases?.length
      ? `<phases>${escapeXmlText(info.meta.phases.map((phase) => phase.title).join(", "))}</phases>`
      : undefined,
    "<arguments>",
    ...Object.entries(info.meta.arguments ?? {}).map(
      ([name, arg]) =>
        `  <argument name="${escapeXmlAttr(name)}" type="${escapeXmlAttr(arg.type ?? "string")}"${arg.default === undefined ? "" : ` default=${escapeXmlAttr(JSON.stringify(arg.default))}`}>${escapeXmlText(arg.description ?? "")}</argument>`,
    ),
    "</arguments>",
    "</workflow>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

// QW7: the live agent roster the engine can dispatch as workflow steps. Surfaced
// in read/create output so the model authors `ctx.agent({ agent })` steps against
// agents that actually exist, instead of guessing builtin names.
function formatAgentRoster(list: Agent.Info[]) {
  // Only subagents the engine can dispatch via ctx.agent({agent}) — hidden and
  // primary-only agents are not selectable as workflow steps. Sorted for a
  // stable, scannable list.
  const usable = list
    .filter((agent) => agent.hidden !== true && agent.mode !== "primary")
    .toSorted((a, b) => a.name.localeCompare(b.name))
  if (usable.length === 0) return "<available_agents>No dispatchable agents are available.</available_agents>"
  return [
    "<available_agents>",
    ...usable.map(
      (agent) => `  <agent name="${escapeXmlAttr(agent.name)}">${escapeXmlText(agent.description ?? "")}</agent>`,
    ),
    "</available_agents>",
  ].join("\n")
}

function formatRunSummary(run: Workflow.Run) {
  return [
    `<workflow_run id="${escapeXmlAttr(run.id)}" state="${run.status}">`,
    `<workflow>${escapeXmlText(run.workflow)}</workflow>`,
    run.definition ? `<path>${escapeXmlText(run.definition.path)}</path>` : undefined,
    run.definition?.temporary ? "<temporary>true</temporary>" : undefined,
    `<started_at>${new Date(run.started_at).toISOString()}</started_at>`,
    run.completed_at ? `<completed_at>${new Date(run.completed_at).toISOString()}</completed_at>` : undefined,
    run.current_phase ? `<current_phase>${escapeXmlText(run.current_phase)}</current_phase>` : undefined,
    run.args ? `<args>${formatUnknown(run.args)}</args>` : undefined,
    run.error ? `<error>${escapeXmlText(run.error)}</error>` : undefined,
    "</workflow_run>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function formatLogs(run: Workflow.Run) {
  if (run.logs.length === 0) return "<logs>No logs recorded.</logs>"
  return [
    "<logs>",
    ...run.logs.map((log) => {
      const phase = log.phase ? ` phase="${escapeXmlAttr(log.phase)}"` : ""
      return `  <log time="${new Date(log.time).toISOString()}"${phase}>${escapeXmlText(log.message)}</log>`
    }),
    "</logs>",
  ].join("\n")
}

function formatAgents(run: Workflow.Run, includeOutput: boolean) {
  if (run.agents.length === 0) return "<agents>No agents were run.</agents>"
  return [
    "<agents>",
    ...run.agents.flatMap((agent) => [
      `  <agent id="${escapeXmlAttr(agent.id)}" state="${agent.status}"${agent.agent ? ` name="${escapeXmlAttr(agent.agent)}"` : ""}>`,
      agent.phase ? `    <phase>${escapeXmlText(agent.phase)}</phase>` : undefined,
      agent.session_id ? `    <session_id>${escapeXmlText(agent.session_id)}</session_id>` : undefined,
      agent.model ? `    <model>${escapeXmlText(agent.model)}</model>` : undefined,
      agent.tokens?.total ? `    <tokens>${agent.tokens.total}</tokens>` : undefined,
      agent.cost ? `    <cost>${agent.cost}</cost>` : undefined,
      includeOutput ? `    <prompt>${escapeXmlText(agent.prompt)}</prompt>` : undefined,
      includeOutput && agent.output ? `    <output>${escapeXmlText(agent.output)}</output>` : undefined,
      agent.error ? `    <error>${escapeXmlText(agent.error)}</error>` : undefined,
      "  </agent>",
    ]),
    "</agents>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function formatAgent(run: Workflow.Run, id?: string) {
  if (!id) throw new Error("agent_id is required when view is agent")
  const agent = run.agents.find((item) => item.id === id)
  if (!agent) throw new Error(`Workflow agent run not found: ${id}`)
  return [
    `<workflow_agent run_id="${escapeXmlAttr(run.id)}" id="${escapeXmlAttr(agent.id)}" state="${agent.status}">`,
    agent.phase ? `<phase>${escapeXmlText(agent.phase)}</phase>` : undefined,
    agent.agent ? `<agent>${escapeXmlText(agent.agent)}</agent>` : undefined,
    agent.session_id ? `<session_id>${escapeXmlText(agent.session_id)}</session_id>` : undefined,
    agent.message_id ? `<message_id>${escapeXmlText(agent.message_id)}</message_id>` : undefined,
    agent.model ? `<model>${escapeXmlText(agent.model)}</model>` : undefined,
    agent.tokens ? `<tokens>${formatUnknown(agent.tokens)}</tokens>` : undefined,
    agent.cost ? `<cost>${agent.cost}</cost>` : undefined,
    `<prompt>${escapeXmlText(agent.prompt)}</prompt>`,
    agent.output ? `<output>${escapeXmlText(agent.output)}</output>` : undefined,
    agent.error ? `<error>${escapeXmlText(agent.error)}</error>` : undefined,
    "</workflow_agent>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function formatResult(run: Workflow.Run) {
  return run.result === undefined
    ? "<result>No result recorded.</result>"
    : `<result>${formatUnknown(run.result)}</result>`
}

function formatSource(run: Workflow.Run) {
  if (!run.definition?.source) return "<source>No source recorded.</source>"
  return `<source path="${escapeXmlAttr(run.definition.path)}">${escapeXmlText(run.definition.source)}</source>`
}

function formatInspect(run: Workflow.Run, view: Schema.Schema.Type<typeof InspectView>, agentID?: string) {
  if (view === "logs") return [formatRunSummary(run), formatLogs(run)].join("\n")
  if (view === "agents") return [formatRunSummary(run), formatAgents(run, false)].join("\n")
  if (view === "agent") return formatAgent(run, agentID)
  if (view === "result") return [formatRunSummary(run), formatResult(run)].join("\n")
  if (view === "all") {
    return [formatRunSummary(run), formatLogs(run), formatAgents(run, true), formatResult(run), formatSource(run)].join(
      "\n",
    )
  }
  return [formatRunSummary(run), formatAgents(run, false), formatResult(run)].join("\n")
}

function backgroundStarted(run: Workflow.Run) {
  return [
    `<workflow_run id="${escapeXmlAttr(run.id)}" state="running">`,
    "<summary>Workflow started in background.</summary>",
    "<instructions>You will be notified automatically when it finishes; do not poll unless the user asks for progress.</instructions>",
    "</workflow_run>",
  ].join("\n")
}

// `text` is intentionally NOT escaped: on the completed path it is the already-
// built (and already-escaped) terminalOutput envelope, and on the error path it
// is a Cause.pretty diagnostic — both belong verbatim inside the result/error tag.
function backgroundMessage(run: Workflow.Run, state: "completed" | "error", text: string) {
  return [
    `<workflow_run id="${escapeXmlAttr(run.id)}" state="${state}">`,
    `<summary>Background workflow ${state}: ${escapeXmlText(run.workflow)}</summary>`,
    state === "completed" ? "<workflow_result>" : "<workflow_error>",
    text,
    state === "completed" ? "</workflow_result>" : "</workflow_error>",
    "</workflow_run>",
  ].join("\n")
}

function sanitizeWorkflowName(name: string) {
  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    throw new Error("Workflow names may only contain letters, numbers, underscores, and dashes")
  }
  return name
}

function workflowPath(directory: string, name: string) {
  return path.join(directory, ".opencode", "workflows", `${sanitizeWorkflowName(name)}.ts`)
}

function projectRoot(instance: { directory: string; worktree: string }) {
  return instance.worktree === "/" ? instance.directory : instance.worktree
}

function terminalOutput(run: Workflow.Run) {
  return [formatRunSummary(run), formatLogs(run), formatAgents(run, false), formatResult(run)].join("\n")
}

// Any non-"completed" TERMINAL status is a failure the tool must surface — not
// only failed/cancelled but also "interrupted" (a crashed/orphaned run swept on
// restart). Returning undefined only for the genuinely-completed run keeps every
// path (foreground/wait/background) from cheerfully reporting "completed" for a
// run that did not actually succeed.
function runFailure(run: Workflow.Run) {
  if (run.status === "completed") return undefined
  return new Error(run.error ?? `Workflow ${run.status}: ${run.id}`)
}

// Fund 7: `run_id` is unconstrained LLM input (Schema.optional(Schema.String)),
// but `Workflow.RunID.make` runs the brand's `isStartsWith("job")` check and
// THROWS synchronously for any id without the "job" prefix. With the trailing
// `.pipe(Effect.orDie)` on the execute body that throw became an unrecoverable
// defect carrying a cryptic Schema message instead of the intended clean
// `Effect.fail("Workflow run not found: <id>")`. Guarding on the prefix first
// keeps a malformed id on the not-found path (every non-existent run reads the
// same regardless of shape).
function decodeRunId(raw: string) {
  return raw.startsWith("job") ? Workflow.RunID.make(raw) : undefined
}

function waitForWorkflow(workflow: Workflow.Interface, run: Workflow.Run, timeout?: number) {
  return workflow
    .wait({ id: run.id, timeout })
    .pipe(Effect.map((waited) => ({ run: waited.run ?? run, timedOut: waited.timedOut })))
}

// Resolves the moment `ctx.abort` fires (or immediately if already aborted).
// Mirrors the shell tool's abort observer (tool/shell.ts).
function awaitAbort(abort: AbortSignal) {
  return Effect.callback<void>((resume) => {
    if (abort.aborted) return resume(Effect.void)
    const handler = () => resume(Effect.void)
    abort.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => abort.removeEventListener("abort", handler))
  })
}

// N10: a FOREGROUND wait must honor the parent turn's abort signal. Without this
// a TUI Esc / `POST /:id/abort` during a foreground workflow would leave the tool
// blocked (up to the 1h wait timeout) AND the run executing (model cost keeps
// burning). We race the wait against the abort: when abort wins, cancel the run
// (stopping its agent spend) and return the cancelled state so the tool unblocks
// immediately. The wait branch is unchanged when no abort fires.
function waitForWorkflowHonoringAbort(
  workflow: Workflow.Interface,
  run: Workflow.Run,
  abort: AbortSignal,
  timeout?: number,
) {
  return Effect.raceFirst(
    waitForWorkflow(workflow, run, timeout),
    awaitAbort(abort).pipe(
      Effect.andThen(
        workflow.cancel(run.id).pipe(Effect.map((cancelled) => ({ run: cancelled ?? run, timedOut: false }))),
      ),
    ),
  )
}

function workflowMetadata(run: Workflow.Run, background: boolean) {
  return {
    runId: run.id,
    sessionId: run.session_id,
    workflow: run.workflow,
    background,
  }
}

function startWorkflow(input: {
  workflow: Workflow.Interface
  background: BackgroundJob.Interface
  sessions: Session.Interface
  scope: Scope.Scope
  params: Params
  name: string
  source?: string
  temporary?: boolean
  resumeOf?: Workflow.RunID
  invalidateAgents?: number[]
  ctx: Tool.Context
}) {
  return Effect.gen(function* () {
    const ops = promptOps(input.ctx)
    const run = yield* input.workflow
      .start({
        name: input.name,
        args: input.params.args,
        budget: input.params.budget,
        prompt: ops,
        permissionSessionID: input.ctx.sessionID,
        // Pass the caller's identity so every subagent the run spawns inherits
        // this session's deny/external_directory rules and this agent's edit-class
        // denies (Plan Mode) — the same ruleset the task tool derives (#26514).
        caller: { sessionID: input.ctx.sessionID, agent: input.ctx.agent },
        source: input.source,
        temporary: input.temporary,
        resume_of: input.resumeOf,
        invalidate_agents: input.invalidateAgents,
      })
      .pipe(Effect.mapError(workflowError))

    yield* input.ctx.metadata({
      title: run.definition?.meta.name ?? run.workflow,
      metadata: workflowMetadata(run, input.params.background === true),
    })

    if (input.params.background) {
      const job = yield* input.background.start({
        id: run.id,
        type: "workflow",
        title: run.workflow,
        metadata: {
          ...workflowMetadata(run, true),
          parentSessionId: input.ctx.sessionID,
        },
        run: waitForWorkflow(input.workflow, run).pipe(
          Effect.flatMap((waited) => {
            const error = runFailure(waited.run)
            return error ? Effect.fail(error) : Effect.succeed(terminalOutput(waited.run))
          }),
          Effect.tap((output) =>
            input.sessions.get(input.ctx.sessionID).pipe(
              Effect.flatMap((session) =>
                ops.prompt({
                  sessionID: input.ctx.sessionID,
                  agent: session.agent ?? input.ctx.agent,
                  parts: [
                    {
                      type: "text",
                      synthetic: true,
                      text: backgroundMessage(run, "completed", output),
                    },
                  ],
                }),
              ),
              Effect.ignore,
              Effect.forkIn(input.scope, { startImmediately: true }),
            ),
          ),
          Effect.catchCause((cause) =>
            input.sessions.get(input.ctx.sessionID).pipe(
              Effect.flatMap((session) =>
                ops.prompt({
                  sessionID: input.ctx.sessionID,
                  agent: session.agent ?? input.ctx.agent,
                  parts: [
                    {
                      type: "text",
                      synthetic: true,
                      text: backgroundMessage(run, "error", Cause.pretty(cause)),
                    },
                  ],
                }),
              ),
              Effect.ignore,
              Effect.forkIn(input.scope, { startImmediately: true }),
              Effect.andThen(Effect.failCause(cause)),
            ),
          ),
        ),
      })

      return {
        title: `Workflow started: ${run.workflow}`,
        metadata: { ...workflowMetadata(run, true), jobId: job.id, timedOut: false },
        output: backgroundStarted(run),
      }
    }

    const waited = yield* waitForWorkflowHonoringAbort(
      input.workflow,
      run,
      input.ctx.abort,
      input.params.timeout ?? DEFAULT_TIMEOUT,
    )
    // Fund 30: a TERMINAL non-completed run (failed/cancelled/interrupted) must fail
    // the tool here too, consistent with the background path — never report
    // "Workflow finished" for a run that did not succeed. A timed-out run is still
    // running, so it is reported as such, not failed.
    //
    // N10 carve-out: when the PARENT TURN aborted (ctx.abort), the run was cancelled
    // as the deliberate, graceful response to that abort — not a workflow failure.
    // Returning the cancelled state as success (rather than failing) keeps the abort
    // flow clean; failing here would surface a spurious "Workflow cancelled" error
    // for a user-initiated stop. A run that failed/cancelled/interrupted on its own
    // (no abort) still fails the tool.
    if (!waited.timedOut && !input.ctx.abort.aborted) {
      const failure = runFailure(waited.run)
      if (failure) return yield* Effect.fail(failure)
    }
    return {
      title: waited.timedOut ? `Workflow still running: ${run.workflow}` : `Workflow finished: ${run.workflow}`,
      metadata: { ...workflowMetadata(run, false), jobId: "", timedOut: waited.timedOut },
      output: waited.timedOut
        ? [
            formatRunSummary(waited.run),
            '<instructions>Use the workflow tool with action="wait" and this run_id to wait for completion.</instructions>',
          ].join("\n")
        : terminalOutput(waited.run),
    }
  })
}

export const WorkflowTool = Tool.define(
  "workflow",
  Effect.gen(function* () {
    const workflow = yield* Workflow.Service
    const agents = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const scope = yield* Scope.Scope
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          if (params.action === "read") {
            if (!params.name) return yield* Effect.fail(new Error("name is required for action=read"))
            const workflows = yield* workflow.list()
            const info = workflows.find((item) => item.name === params.name)
            if (!info) return yield* Effect.fail(new Error(`Workflow not found: ${params.name}`))
            // A discovered-but-broken file must surface its load error, not a
            // misleadingly empty <workflow> block.
            if (info.valid === false) {
              return yield* Effect.fail(new Error(`Invalid workflow ${info.path}: ${info.error ?? "invalid workflow"}`))
            }
            return {
              title: `Workflow: ${info.name}`,
              metadata: { name: info.name, path: info.path },
              output: [formatWorkflow(info), formatAgentRoster(yield* agents.list())].join("\n"),
            }
          }

          if (params.action === "start") {
            if (!params.name) return yield* Effect.fail(new Error("name is required for action=start"))
            // QW3: a malformed resume_of is surfaced as a clean not-found (using the
            // same prefix guard wait/inspect use) rather than a Schema defect through
            // the trailing orDie.
            const resumeOf = params.resume_of ? decodeRunId(params.resume_of) : undefined
            if (params.resume_of && !resumeOf)
              return yield* Effect.fail(new Error(`Workflow run not found: ${params.resume_of}`))
            // N15 (security, behavior change): the name reaching the permission
            // pattern/`always` MUST be glob-metacharacter-free. A discovered
            // workflow name is just a file basename (discover() does
            // path.basename without any charset limit), so a file like `*.ts`
            // would yield name `*`. The permission layer matches `always` rules
            // via Wildcard.match, where `*` expands to `.*` — so an unsanitized
            // `always: ["*"]` "allow" would silently grant EVERY future workflow.
            // We reuse create's sanitizer so start accepts exactly the same name
            // shape create writes; an illegal name fails here instead of becoming
            // an over-broad rule.
            const safeName = sanitizeWorkflowName(params.name)
            // Existence + validity pre-check via the static list. This is
            // side-effect-free (static meta extraction, NO module execution), so it
            // is safe to run BEFORE the permission ask: an unknown name fails with a
            // clear "not found", and — Fund 55 — a discovered-but-unloadable workflow
            // (bad meta / non-literal / schema-invalid) fails here exactly like read,
            // rather than firing the interactive workflow prompt only to fail deep
            // inside the engine afterwards. The actual module load (which DOES run
            // code) still happens later, AFTER the ask below.
            const workflows = yield* workflow.list()
            const info = workflows.find((item) => item.name === params.name)
            if (!info) return yield* Effect.fail(new Error(`Workflow not found: ${params.name}`))
            if (info.valid === false) {
              return yield* Effect.fail(new Error(`Invalid workflow ${info.path}: ${info.error ?? "invalid workflow"}`))
            }
            // Permission gate before any module LOAD/execution. The check above is
            // side-effect-free, so the ask still gates every line of foreign code: an
            // untrusted workspace can never drive any workflow execution ahead of the
            // user's consent.
            yield* ctx.ask({
              permission: "workflow",
              patterns: [safeName],
              always: [safeName],
              metadata: { name: safeName, args: params.args ?? {}, background: params.background === true },
            })
            // Fund 54: populate definition.source from the workflow file so inspect
            // view="all" renders the real <source> (the engine persists it on the
            // run, and the TUI reads it too). Best-effort: a read failure just leaves
            // source unset, falling back to "No source recorded." rather than failing
            // the start.
            const source = yield* fs.readFileStringSafe(info.path)
            return yield* startWorkflow({
              workflow,
              background,
              sessions,
              scope,
              params,
              name: params.name,
              source: source ?? undefined,
              resumeOf,
              invalidateAgents: params.invalidate_agents ? [...params.invalidate_agents] : undefined,
              ctx,
            })
          }

          if (params.action === "wait") {
            if (!params.run_id) return yield* Effect.fail(new Error("run_id is required for action=wait"))
            const runId = decodeRunId(params.run_id)
            if (!runId) return yield* Effect.fail(new Error(`Workflow run not found: ${params.run_id}`))
            // N10: honor ctx.abort here too — a wait action that blocks during a
            // turn abort must unblock and cancel the run rather than hang.
            const waited = yield* Effect.raceFirst(
              workflow.wait({ id: runId, timeout: params.timeout ?? DEFAULT_TIMEOUT }),
              awaitAbort(ctx.abort).pipe(
                Effect.andThen(workflow.cancel(runId).pipe(Effect.map((run) => ({ run, timedOut: false })))),
              ),
            )
            if (!waited.run) return yield* Effect.fail(new Error(`Workflow run not found: ${params.run_id}`))
            // Fund 30: a terminal non-completed run (failed/cancelled/interrupted)
            // fails the wait too, consistent with foreground/background — never
            // report "Workflow finished" for a run that did not succeed. A timed-out
            // run is still running, so it is reported, not failed. N10 carve-out: a
            // cancellation caused by THIS turn's abort is the graceful abort response,
            // not a workflow failure, so it returns the cancelled state as success.
            if (!waited.timedOut && !ctx.abort.aborted) {
              const failure = runFailure(waited.run)
              if (failure) return yield* Effect.fail(failure)
            }
            return {
              title: waited.timedOut
                ? `Workflow still running: ${params.run_id}`
                : `Workflow finished: ${params.run_id}`,
              metadata: { runId: params.run_id, timedOut: waited.timedOut },
              output: waited.timedOut
                ? [
                    formatRunSummary(waited.run),
                    "<instructions>The workflow is still running. Wait again later if the user needs the final result.</instructions>",
                  ].join("\n")
                : terminalOutput(waited.run),
            }
          }

          if (params.action === "inspect") {
            if (!params.run_id) return yield* Effect.fail(new Error("run_id is required for action=inspect"))
            const runId = decodeRunId(params.run_id)
            if (!runId) return yield* Effect.fail(new Error(`Workflow run not found: ${params.run_id}`))
            const run = yield* workflow.get(runId)
            if (!run) return yield* Effect.fail(new Error(`Workflow run not found: ${params.run_id}`))
            const view = params.view ?? "summary"
            return {
              title: `Workflow run: ${run.id}`,
              metadata: { ...workflowMetadata(run, false), view },
              output: formatInspect(run, view, params.agent_id),
            }
          }

          if (params.action === "create") {
            if (!params.name) return yield* Effect.fail(new Error("name is required for action=create"))
            if (!params.source) return yield* Effect.fail(new Error("source is required for action=create"))
            // Fund 8 (security): the same name-sanitization start uses (N15/3b) gates
            // the workflow permission pattern below, so a glob-metacharacter name can
            // never produce an over-broad `always` rule. workflowPath sanitizes too,
            // so an illegal name fails identically on either path.
            const safeName = sanitizeWorkflowName(params.name)
            const instance = yield* InstanceState.context
            const filepath = workflowPath(projectRoot(instance), params.name)
            yield* assertExternalDirectoryEffect(ctx, filepath)
            const exists = yield* fs.existsSafe(filepath)
            if (exists && !params.overwrite) {
              return yield* Effect.fail(
                new Error(`Workflow already exists: ${params.name}. Set overwrite=true to replace it.`),
              )
            }
            // Fund 8 (security, behavior change): creating a workflow writes a
            // project-local module that a later start will LOAD and execute, so create
            // is itself a privileged operation. Gate it behind the SAME `workflow`
            // permission start uses (consistent pattern/`always` shape), in addition to
            // the `edit` gate for the write. The ask comes BEFORE any write, so a denial
            // dies before fs.writeWithDirs and the file is never created.
            yield* ctx.ask({
              permission: "workflow",
              patterns: [safeName],
              always: [safeName],
              metadata: { name: safeName, args: params.args ?? {}, background: params.background === true },
            })
            const previous = exists ? ((yield* fs.readFileStringSafe(filepath)) ?? "") : ""
            yield* ctx.ask({
              permission: "edit",
              patterns: [path.relative(instance.worktree, filepath)],
              always: ["*"],
              metadata: { filepath, diff: trimDiff(createTwoFilesPatch(filepath, filepath, previous, params.source)) },
            })
            yield* fs.writeWithDirs(filepath, params.source)
            yield* format.file(filepath).pipe(Effect.ignore)
            yield* events.publish(FileSystem.Event.Edited, { file: filepath })
            yield* events.publish(Watcher.Event.Updated, { file: filepath, event: exists ? "change" : "add" })
            yield* lsp.touchFile(filepath, "document")
            // Fund 8 (security): validate the freshly written source STATICALLY via the
            // meta-reader (AST-only meta extraction). This must never dynamically import
            // the file — importing would execute the LLM/attacker-authored top-level code
            // right after the write, the exact root cause Task 3a removed from discovery.
            // A bad meta (non-literal / schema-invalid / missing) is reported as a precise
            // load failure instead of claiming the file was "created and validated".
            const validated = MetaReader.read(params.source, filepath)
            if (validated.valid === false) {
              return yield* Effect.fail(new Error(`Invalid workflow ${filepath}: ${validated.error}`))
            }
            return {
              title: `Workflow created: ${params.name}`,
              metadata: { name: params.name, path: filepath, exists },
              output: [
                "Workflow file created and validated.",
                "",
                formatWorkflow({ name: params.name, path: filepath, meta: validated.meta, valid: true }),
                formatAgentRoster(yield* agents.list()),
              ].join("\n"),
            }
          }
          return yield* Effect.fail(new Error(`Unsupported workflow action: ${params.action}`))
        }).pipe(Effect.orDie),
    }
  }),
)
