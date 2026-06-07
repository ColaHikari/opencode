import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { WorkflowTool } from "@/tool/workflow"
import { Workflow } from "@/workflow/workflow"
import { Session } from "@/session/session"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { MessageID, SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { SessionPrompt } from "@/session/prompt"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { PartID } from "@/session/schema"

// Session.defaultLayer is merged so a test can create a REAL caller session and
// drive ctx.sessionID with its id. Effect layer memoization shares the single
// Session service the ToolRegistry already builds internally, so a session
// created here is the same one the workflow tool's background completion path
// reads via `sessions.get(ctx.sessionID)` before delivering its message.
// Workflow.defaultLayer is merged so a test can read the engine's run state via
// `Workflow.Service` (e.g. asserting a started run carries resume_of). Effect
// layer memoization shares the single Workflow service the ToolRegistry already
// builds internally, so a run started through the tool is the same run this
// service reads back — mirroring why Session.defaultLayer is merged here.
const it = testEffect(
  Layer.mergeAll(ToolRegistry.defaultLayer, Session.defaultLayer, Workflow.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  extra: {
    promptOps: {
      prompt: () => Effect.succeed({ parts: [] } as never),
    },
  },
}

async function writeWorkflow(dir: string, name: string, source: string) {
  const workflows = path.join(dir, ".opencode", "workflows")
  await fs.mkdir(workflows, { recursive: true })
  await Bun.write(path.join(workflows, `${name}.ts`), source)
}

function requestRecorder() {
  const requests: Parameters<Tool.Context["ask"]>[0][] = []
  const prompts: SessionPrompt.PromptInput[] = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
    extra: {
      promptOps: {
        prompt: (input: SessionPrompt.PromptInput) =>
          Effect.sync(() => {
            prompts.push(input)
            return {
              info: {
                id: MessageID.ascending(),
                role: "assistant",
                parentID: input.messageID ?? MessageID.ascending(),
                sessionID: input.sessionID,
                mode: input.agent ?? "general",
                agent: input.agent ?? "general",
                cost: 0,
                path: { cwd: "/tmp", root: "/tmp" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: input.model?.modelID ?? ModelV2.ID.make("gpt-5"),
                providerID: input.model?.providerID ?? ProviderV2.ID.opencode,
                time: { created: Date.now() },
                finish: "stop",
              },
              parts: [
                {
                  id: PartID.ascending(),
                  messageID: MessageID.ascending(),
                  sessionID: input.sessionID,
                  type: "text",
                  text: "ok",
                },
              ],
            } as SessionV1.WithParts
          }),
      },
    },
  }
  return { ctx, requests, prompts }
}

function workflowTool() {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const tool = (yield* registry.tools({
      providerID: ProviderV2.ID.opencode,
      modelID: ModelV2.ID.make("gpt-5"),
      agent: { name: "build", mode: "primary", permission: [], options: {} },
    })).find((tool) => tool.id === WorkflowTool.id)
    if (!tool) return yield* Effect.fail(new Error(`Tool not found: ${WorkflowTool.id}`))
    return tool
  })
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.workflow", () => {
  it.live("reads workflow metadata without source", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "hello",
            `export const meta = {
  name: "Hello",
  description: "Say hello.",
  phases: ["run"],
  arguments: { value: { type: "number", description: "Value to echo." } }
}
export async function run(args, ctx) { ctx.setPhase("run"); return { value: args.value } }
`,
          ),
        )

        const tool = yield* workflowTool()
        const result = yield* tool.execute({ action: "read", name: "hello" }, requestRecorder().ctx)
        expect(result.output).toContain(`<workflow name="hello">`)
        expect(result.output).toContain("Say hello.")
        expect(result.output).toContain(`<argument name="value" type="number">Value to echo.</argument>`)
        expect(result.output).not.toContain("export async function run")
      }),
    ),
  )

  it.live("read renders whenToUse from meta (QW4)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "deploy",
            `export const meta = {
  name: "Deploy",
  description: "Deploy the app.",
  whenToUse: "When the user asks to ship to production."
}
export async function run(args, ctx) { return { ok: true } }
`,
          ),
        )
        const tool = yield* workflowTool()
        const result = yield* tool.execute({ action: "read", name: "deploy" }, requestRecorder().ctx)
        expect(result.output).toContain("<when_to_use>When the user asks to ship to production.</when_to_use>")
      }),
    ),
  )

  it.live("read output includes the live agent roster (QW7)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "hello",
            `export const meta = { name: "Hello", description: "Say hi." }
export async function run(args, ctx) { return { ok: true } }
`,
          ),
        )
        const tool = yield* workflowTool()
        const result = yield* tool.execute({ action: "read", name: "hello" }, requestRecorder().ctx)
        // The roster block exists and lists at least the always-present "general"
        // subagent the engine can dispatch (agent.ts default subagents).
        expect(result.output).toContain("<available_agents>")
        expect(result.output).toContain(`<agent name="general"`)
      }),
    ),
  )

  it.live("starts workflow and asks reusable workflow permission", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "hello",
            `export const meta = { name: "Hello", description: "Echo a value." }
export async function run(args, ctx) { ctx.setPhase("run"); ctx.log("running"); return { value: args.value } }
`,
          ),
        )

        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const result = yield* tool.execute({ action: "start", name: "hello", args: { value: 42 } }, recorder.ctx)

        expect(recorder.requests.length).toBe(1)
        expect(recorder.requests[0].permission).toBe("workflow")
        expect(recorder.requests[0].patterns).toEqual(["hello"])
        expect(recorder.requests[0].always).toEqual(["hello"])
        expect(result.output).toContain(`<workflow_run id="${result.metadata.runId}" state="completed">`)
        expect(result.output).toContain('"value": 42')
      }),
    ),
  )

  it.live("start forwards resume_of + invalidate_agents to workflow.start", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // The workflow hangs when args.hang is set so we can deterministically catch
        // the source run `running` and PAUSE it (the engine only resumes paused or
        // interrupted runs, never completed ones); without the flag it returns
        // synchronously so the resumed run settles on its own.
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "echo",
            `export const meta = { name: "Echo", description: "Echo." }
export async function run(args, ctx) { if (args.hang) await new Promise(() => {}); return { value: args.value } }
`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const workflow = yield* Workflow.Service
        // Start a hanging source run in the background, then pause it so it parks as
        // a resumable `paused` source.
        const first = yield* tool.execute(
          { action: "start", name: "echo", args: { value: 1, hang: true }, background: true },
          recorder.ctx,
        )
        const sourceId = first.metadata.runId as string
        const paused = yield* pollWithTimeout(
          workflow
            .pause(Workflow.RunID.make(sourceId))
            .pipe(Effect.map((run) => (run?.status === "paused" ? run : undefined))),
          "source run never paused",
        )
        expect(paused.status).toBe("paused")

        // Resume start: pass resume_of + invalidate_agents. The engine replays the
        // (directory-scoped) source journal; what we assert is the parameters reached
        // workflow.start (the new run carries resume_of) and the run still completes.
        const resumed = yield* tool.execute(
          { action: "start", name: "echo", args: { value: 1 }, resume_of: sourceId, invalidate_agents: [0] },
          recorder.ctx,
        )
        const run = yield* workflow.get(Workflow.RunID.make(resumed.metadata.runId as string))
        expect(run?.resume_of as string | undefined).toBe(sourceId)
        expect(resumed.output).toContain(`state="completed"`)
      }),
    ),
  )

  it.live("routes workflow agent permission asks to the caller session", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "ask",
            `export const meta = { name: "Ask" }
export async function run(args, ctx) {
  return await ctx.agent({ prompt: "Need permission" })
}
`,
          ),
        )

        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const result = yield* tool.execute({ action: "start", name: "ask" }, recorder.ctx)

        expect(result.output).toContain(`<workflow_run id="${result.metadata.runId}" state="completed">`)
        expect(recorder.prompts.some((prompt) => prompt.permissionSessionID === recorder.ctx.sessionID)).toBe(true)
      }),
    ),
  )

  it.live("creates a workflow file, asks edit permission, and validates the result", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const source = `export const meta = { name: "Made", description: "Created by test." }
export async function run(args, ctx) { return "ok" }
`
        const result = yield* tool.execute({ action: "create", name: "made", source }, recorder.ctx)

        expect(recorder.requests.some((req) => req.permission === "edit")).toBe(true)
        expect(result.output).toContain("Workflow file created and validated.")
        expect(result.output).toContain(`<workflow name="made">`)
        const written = yield* Effect.promise(() =>
          fs.readFile(path.join(dir, ".opencode", "workflows", "made.ts"), "utf8"),
        )
        expect(written).toContain(`name: "Made"`)
        // The created file is discoverable and valid through the read action.
        const read = yield* tool.execute({ action: "read", name: "made" }, recorder.ctx)
        expect(read.output).toContain("Created by test.")
      }),
    ),
  )

  it.live("create output includes the live agent roster (QW7)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const source = `export const meta = { name: "Made", description: "Created by test." }
export async function run(args, ctx) { return "ok" }
`
        const result = yield* tool.execute({ action: "create", name: "made", source }, recorder.ctx)
        expect(result.output).toContain("<available_agents>")
        expect(result.output).toContain(`<agent name="general"`)
      }),
    ),
  )

  it.live("inspects a finished run: summary carries args, result, and logs view works", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "hello",
            `export const meta = { name: "Hello" }
export async function run(args, ctx) { ctx.log("running"); return { value: args.value } }
`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "hello", args: { value: 7 } }, recorder.ctx)
        const runId = started.metadata.runId as string

        const inspected = yield* tool.execute({ action: "inspect", run_id: runId }, recorder.ctx)
        expect(inspected.output).toContain(`<workflow_run id="${runId}"`)
        expect(inspected.output).toContain('"value": 7')
        expect(inspected.output).toContain("<result>")

        const logs = yield* tool.execute({ action: "inspect", run_id: runId, view: "logs" }, recorder.ctx)
        expect(logs.output).toContain("<logs>")
        expect(logs.output).toContain("running")
      }),
    ),
  )

  // Fund 27: every inspect VIEW must round-trip. A run that dispatched an agent
  // step exercises the agents/agent views (the `formatAgents`/`formatAgent`
  // formatters at workflow.ts:172-214) and the agent-id guards at :194-197; the
  // result view exercises `formatResult`. The recorder's fake prompt-ops resolve
  // every ctx.agent call to a completed assistant message, so the run finishes
  // with exactly one terminal agent node whose id is "1".
  it.live("inspect view=agents and view=agent render the run's agent nodes", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "withagent",
            `export const meta = { name: "WithAgent" }
export async function run(args, ctx) { await ctx.agent({ prompt: "do it" }); return { ok: true } }
`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "withagent" }, recorder.ctx)
        const runId = started.metadata.runId as string

        // view="agents": the summary plus the multi-agent listing.
        const agents = yield* tool.execute({ action: "inspect", run_id: runId, view: "agents" }, recorder.ctx)
        expect(agents.output).toContain("<agents>")
        expect(agents.output).toContain('<agent id="1"')
        expect(agents.metadata.view).toBe("agents")

        // view="agent" with a valid agent_id: the single-agent detail block,
        // including the agent's prompt (always rendered by formatAgent).
        const agent = yield* tool.execute(
          { action: "inspect", run_id: runId, view: "agent", agent_id: "1" },
          recorder.ctx,
        )
        expect(agent.output).toContain("<workflow_agent")
        expect(agent.output).toContain('id="1"')
        expect(agent.output).toContain("<prompt>do it</prompt>")

        // view="result": the summary plus the recorded result.
        const result = yield* tool.execute({ action: "inspect", run_id: runId, view: "result" }, recorder.ctx)
        expect(result.output).toContain("<result>")
        expect(result.output).toContain('"ok": true')
      }),
    ),
  )

  // Fund 27: view="agent" WITHOUT agent_id must fail at the formatAgent guard
  // (workflow.ts:195), not silently render an empty block. The tool body's
  // trailing `Effect.orDie` turns the thrown guard into a defect, so the
  // execute fails.
  it.live("inspect view=agent without agent_id fails", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "hello",
            `export const meta = { name: "Hello" }\nexport async function run() { return "ok" }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "hello" }, recorder.ctx)
        const exit = yield* Effect.exit(
          tool.execute({ action: "inspect", run_id: started.metadata.runId as string, view: "agent" }, recorder.ctx),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("agent_id is required")
      }),
    ),
  )

  // Fund 27: view="agent" with an UNKNOWN agent_id must fail at the second
  // formatAgent guard (workflow.ts:197), naming the missing agent run id — the
  // run has no agent node "999".
  it.live("inspect view=agent with an unknown agent_id fails as not-found", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "hello",
            `export const meta = { name: "Hello" }\nexport async function run() { return "ok" }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "hello" }, recorder.ctx)
        const exit = yield* Effect.exit(
          tool.execute(
            { action: "inspect", run_id: started.metadata.runId as string, view: "agent", agent_id: "999" },
            recorder.ctx,
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("Workflow agent run not found: 999")
      }),
    ),
  )

  it.live("wait times out on a still-running workflow and reports the running state", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // A pending promise without timers: hangs forever, holds no event-loop
        // handle, and is cleaned up when afterEach disposes the instance scope.
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "slow",
            `export const meta = { name: "Slow" }
export async function run() { await new Promise(() => {}) }
`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "slow", background: true }, recorder.ctx)

        const waited = yield* tool.execute(
          { action: "wait", run_id: started.metadata.runId as string, timeout: 100 },
          recorder.ctx,
        )
        expect(waited.metadata.timedOut).toBe(true)
        expect(waited.output).toContain('state="running"')
        expect(waited.output).toContain("still running")
      }),
    ),
  )

  it.live("denied workflow permission prevents the run from starting", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "hello",
            `export const meta = { name: "Hello" }
export async function run() { return "done" }
`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const metadataCalls: unknown[] = []
        const ctx: Tool.Context = {
          ...recorder.ctx,
          // Real permission denial surfaces as a defect through the tool's orDie
          // (ask's error channel is `never`), so the fake dies the same way.
          ask: () => Effect.die(new Error("Permission denied: workflow")),
          metadata: (input) =>
            Effect.sync(() => {
              metadataCalls.push(input)
            }),
        }

        const exit = yield* Effect.exit(tool.execute({ action: "start", name: "hello" }, ctx))
        expect(Exit.isFailure(exit)).toBe(true)
        // The workflow never started: no run metadata was recorded and no agent
        // prompt went out.
        expect(metadataCalls.length).toBe(0)
        expect(recorder.prompts.length).toBe(0)
      }),
    ),
  )

  // N15 (Security): Ein Workflow-Dateiname mit Glob-Metazeichen (z. B. "*")
  // darf NIE als roher Permission-Pattern/`always`-Wert durchgereicht werden —
  // sonst erzeugt ein "always allow" eine über-breite Regel (Wildcard.match
  // behandelt "*" als ".*", also "alles erlauben").
  it.live("a workflow name with glob metacharacters never produces an over-broad permission rule", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // Datei mit Glob-Metazeichen im Basename (-> discovered name = "*").
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "*",
            `export const meta = { name: "Star" }
export async function run() { return "done" }
`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()

        const exit = yield* Effect.exit(tool.execute({ action: "start", name: "*" }, recorder.ctx))
        // Der Start scheitert (Name ist kein gültiger Workflow-Name) ...
        expect(Exit.isFailure(exit)).toBe(true)
        // ... und es wurde KEINE über-breite Permission-Regel erzeugt: kein
        // pattern/always darf ein wirksames "*"-Wildcard enthalten.
        for (const req of recorder.requests) {
          expect(req.patterns ?? []).not.toContain("*")
          expect(req.always ?? []).not.toContain("*")
        }
      }),
    ),
  )

  // N10 (medium): Wird der Parent-Turn abgebrochen (ctx.abort) während ein
  // FOREGROUND-Workflow läuft, muss (1) der Tool-Call zügig zurückkehren statt
  // bis zum 1h-Timeout zu blockieren und (2) der Run gecancelt werden (keine
  // weiterlaufenden Modellkosten).
  it.live(
    "foreground workflow tool honors ctx.abort: returns promptly and cancels the run",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          // Ein Agent-Schritt, der hängt, bis seine Session abgebrochen wird.
          yield* Effect.promise(() =>
            writeWorkflow(
              dir,
              "hang",
              `export const meta = { name: "Hang" }
export async function run(args, ctx) { await ctx.agent({ prompt: "hang" }); return "done" }
`,
            ),
          )
          const tool = yield* workflowTool()
          const recorder = requestRecorder()
          const controller = new AbortController()
          // prompt-ops, die den Agent-Prompt hängen lassen und bei cancel die
          // Session abbrechen (resolve-on-abort) — wie der echte Runner.
          const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
          const ctx: Tool.Context = {
            ...recorder.ctx,
            abort: controller.signal,
            extra: {
              promptOps: {
                prompt: (input: SessionPrompt.PromptInput) =>
                  Effect.gen(function* () {
                    if (input.noReply)
                      return {
                        info: { id: MessageID.ascending(), role: "assistant" },
                        parts: [],
                      } as unknown as SessionV1.WithParts
                    const gate = Promise.withResolvers<void>()
                    gates.set(input.sessionID, gate)
                    yield* Effect.promise(() => gate.promise)
                    return {
                      info: {
                        id: MessageID.ascending(),
                        role: "assistant",
                        error: { name: "MessageAbortedError", data: {} },
                      },
                      parts: [],
                    } as unknown as SessionV1.WithParts
                  }),
                cancel: (sessionID: SessionID) =>
                  Effect.sync(() => {
                    gates.get(sessionID)?.resolve()
                  }),
              },
            },
          }

          // Foreground-Start in einer Fiber; nach kurzer Zeit ctx.abort feuern.
          const fiber = yield* Effect.forkScoped(tool.execute({ action: "start", name: "hang" }, ctx))
          yield* Effect.sleep("300 millis")
          controller.abort()

          // Der Tool-Call kehrt zügig zurück (nicht erst nach dem 1h-Timeout).
          const exit = yield* awaitWithTimeout(Fiber.await(fiber), "tool did not return after ctx.abort", "8 seconds")
          expect(Exit.isSuccess(exit)).toBe(true)
          const result = Exit.isSuccess(exit) ? exit.value : undefined
          const runId = result?.metadata.runId as string
          expect(runId).toBeTruthy()

          // Und der Run wurde gecancelt (läuft nicht weiter).
          const inspected = yield* tool.execute({ action: "inspect", run_id: runId }, ctx)
          expect(inspected.output).toContain('state="cancelled"')
        }),
      ),
    30_000,
  )

  it.live("denied workflow permission never imports the module (no top-level side effect runs)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const marker = path.join(os.tmpdir(), `tool-workflow-deny-${Math.random().toString(16).slice(2)}`)
        // Top-level marker write: the module must NOT be imported when the
        // permission is denied, because the ask gate comes BEFORE any load.
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "hello",
            `await Bun.write(${JSON.stringify(marker)}, "executed")
export const meta = { name: "Hello" }
export async function run() { return "done" }
`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const ctx: Tool.Context = {
          ...recorder.ctx,
          ask: () => Effect.die(new Error("Permission denied: workflow")),
        }

        const exit = yield* Effect.exit(tool.execute({ action: "start", name: "hello" }, ctx))
        expect(Exit.isFailure(exit)).toBe(true)
        // The module was never imported: its top-level side effect never ran.
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
    ),
  )

  // Fund 7 (HIGH): wait/inspect take a raw, LLM-supplied run_id. RunID.make has an
  // isStartsWith("job") guard that THROWS synchronously for any non-"job" id; with
  // the trailing `.pipe(Effect.orDie)` that throw became an unrecoverable defect
  // with a cryptic Schema message instead of the intended clean "not found".
  it.live("wait on a malformed run_id fails cleanly as not-found (no schema defect)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const exit = yield* Effect.exit(
          tool.execute({ action: "wait", run_id: "not-a-job-id", timeout: 100 }, recorder.ctx),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
        expect(pretty).toContain("Workflow run not found: not-a-job-id")
        // Not the raw RunID schema failure leaking through.
        expect(pretty).not.toContain("isStartsWith")
      }),
    ),
  )

  it.live("inspect on a malformed run_id fails cleanly as not-found (no schema defect)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const exit = yield* Effect.exit(tool.execute({ action: "inspect", run_id: "garbage" }, recorder.ctx))
        expect(Exit.isFailure(exit)).toBe(true)
        const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
        expect(pretty).toContain("Workflow run not found: garbage")
        expect(pretty).not.toContain("isStartsWith")
      }),
    ),
  )

  // Fund 53: a well-formed but unknown ("job"-prefixed) run_id must also surface a
  // clean not-found, on both wait and inspect.
  it.live("wait/inspect on an unknown job id report a clean not-found", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const missing = "job_doesnotexist0000000000000000"
        const waitExit = yield* Effect.exit(
          tool.execute({ action: "wait", run_id: missing, timeout: 100 }, recorder.ctx),
        )
        expect(Exit.isFailure(waitExit)).toBe(true)
        expect(Exit.isFailure(waitExit) ? Cause.pretty(waitExit.cause) : "").toContain(
          `Workflow run not found: ${missing}`,
        )
        const inspectExit = yield* Effect.exit(tool.execute({ action: "inspect", run_id: missing }, recorder.ctx))
        expect(Exit.isFailure(inspectExit)).toBe(true)
        expect(Exit.isFailure(inspectExit) ? Cause.pretty(inspectExit.cause) : "").toContain(
          `Workflow run not found: ${missing}`,
        )
      }),
    ),
  )

  // Fund 29 (medium): timeout was Schema.optional(Schema.Number) and accepted
  // NaN/±Infinity. timeout:Infinity overran the 1h cap (wait hangs forever); NaN
  // slipped past the engine's `<=0` guard (NaN<=0 is false) so wait timed out at
  // once yet still reported "still running". A finite, non-negative schema rejects
  // both at the argument boundary (surfaces as a tool failure via decode→orDie).
  it.live("timeout=Infinity is rejected by the parameter schema", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "slow",
            `export const meta = { name: "Slow" }\nexport async function run() { await new Promise(() => {}) }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "slow", background: true }, recorder.ctx)
        const exit = yield* Effect.exit(
          tool.execute({ action: "wait", run_id: started.metadata.runId as string, timeout: Infinity }, recorder.ctx),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  it.live("timeout=NaN is rejected by the parameter schema", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "slow",
            `export const meta = { name: "Slow" }\nexport async function run() { await new Promise(() => {}) }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "slow", background: true }, recorder.ctx)
        const exit = yield* Effect.exit(
          tool.execute({ action: "wait", run_id: started.metadata.runId as string, timeout: NaN }, recorder.ctx),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  // Fund 29 (medium): a NEGATIVE timeout is the third out-of-range value the
  // schema's `isGreaterThanOrEqualTo(0)` check must reject at the argument
  // boundary, alongside Infinity and NaN above. Without the lower bound a
  // negative timeout would slip past the schema and hit the engine's `<=0`
  // branch (instant timeout) yet read as "still running".
  it.live("timeout=-5 is rejected by the parameter schema", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "slow",
            `export const meta = { name: "Slow" }\nexport async function run() { await new Promise(() => {}) }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "slow", background: true }, recorder.ctx)
        const exit = yield* Effect.exit(
          tool.execute({ action: "wait", run_id: started.metadata.runId as string, timeout: -5 }, recorder.ctx),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  // Fund 30/31 (medium): a foreground start of a FAILED workflow must surface as a
  // tool FAILURE, not a cheerful "Workflow finished". The background path already
  // failed via runFailure(); foreground/wait must be consistent.
  it.live("foreground start of a failing workflow fails the tool", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "boom",
            `export const meta = { name: "Boom" }\nexport async function run() { throw new Error("kaboom") }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const exit = yield* Effect.exit(tool.execute({ action: "start", name: "boom" }, recorder.ctx))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("kaboom")
      }),
    ),
  )

  it.live("wait on a failed run fails the tool (honest failure reporting)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "boom",
            `export const meta = { name: "Boom" }\nexport async function run() { throw new Error("kaboom") }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "boom", background: true }, recorder.ctx)
        const exit = yield* Effect.exit(
          tool.execute({ action: "wait", run_id: started.metadata.runId as string, timeout: 10_000 }, recorder.ctx),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("kaboom")
      }),
    ),
  )

  // Fund 30/31 (medium): a run that ends `cancelled` ON ITS OWN — here because the
  // workflow body throws a WorkflowCancelledError, which the engine maps to the
  // `cancelled` terminal status (workflow.ts finish() onFailure → isCancelled) —
  // must FAIL a subsequent wait, exactly like failed/interrupted. This is distinct
  // from the N10 carve-out above (a cancellation caused by THIS turn's ctx.abort,
  // which returns the cancelled state as success): here ctx.abort never fires, so
  // runFailure surfaces the self-cancellation as an honest tool failure.
  it.live("wait on a self-cancelled run (no ctx.abort) fails the tool", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // The thrown error carries `_tag: "WorkflowCancelledError"` so the engine's
        // isCancelled() check maps the run to `cancelled` rather than `failed`.
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "selfcancel",
            `export const meta = { name: "SelfCancel" }
export async function run() {
  const e = new Error("self-cancelled by workflow")
  e._tag = "WorkflowCancelledError"
  throw e
}
`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "selfcancel", background: true }, recorder.ctx)
        const exit = yield* Effect.exit(
          tool.execute({ action: "wait", run_id: started.metadata.runId as string, timeout: 10_000 }, recorder.ctx),
        )
        // ctx.abort never fired, so the self-cancellation is a tool failure (not the
        // graceful N10 abort-success path).
        expect(recorder.ctx.abort.aborted).toBe(false)
        expect(Exit.isFailure(exit)).toBe(true)
        const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
        expect(pretty).toContain("self-cancelled by workflow")
      }),
    ),
  )

  // Fund 30/31 (medium): the BACKGROUND completion MESSAGE for a non-completed run
  // must report an error, never "completed". A background run is delivered via a
  // synthetic prompt built by backgroundMessage(); for any terminal non-completed
  // status runFailure() drives the catchCause branch → state="error". We exercise
  // it with a self-cancelled run (the only non-completed terminal state reachable
  // through the public tool surface — `interrupted` is produced solely by the
  // orphan sweep on a registry-absent row, which a live background run never is).
  // The completion path reads the REAL caller session via sessions.get(ctx.sessionID)
  // before delivering the message, so the caller must be a real session; the prompt
  // is forked, so we poll the recorder for it.
  it.live("background completion message reports an error for a non-completed run", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "selfcancel",
            `export const meta = { name: "SelfCancel" }
export async function run() {
  const e = new Error("self-cancelled by workflow")
  e._tag = "WorkflowCancelledError"
  throw e
}
`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        // A real caller session: the background completion path looks it up before
        // building the message, so a fake id would short-circuit the delivery.
        const sessions = yield* Session.Service
        const caller = yield* sessions.create({ title: "caller" })
        const ctx: Tool.Context = { ...recorder.ctx, sessionID: caller.id }
        yield* tool.execute({ action: "start", name: "selfcancel", background: true }, ctx)

        // The completion prompt is forked into the run scope; poll until the
        // synthetic background message lands in the recorder (no fixed sleep).
        const message = yield* pollWithTimeout(
          Effect.sync(() =>
            recorder.prompts.find((prompt) =>
              prompt.parts?.some(
                (part) =>
                  part.type === "text" && part.text.includes("<workflow_run") && part.text.includes("Background"),
              ),
            ),
          ),
          "background completion message was never delivered",
        )
        const text = message.parts.find((part): part is { type: "text"; text: string } => part.type === "text")!.text
        // The completion message reports an error envelope, NOT a completed one.
        expect(text).toContain('state="error"')
        expect(text).toContain("<workflow_error>")
        expect(text).not.toContain('state="completed"')
      }),
    ),
  )

  // Fund 52 (low): a real non-blocking proof. A workflow that hangs on a pending
  // promise must let background-start return immediately WHILE a subsequent
  // inspect still reports state="running" (the run did not complete inline).
  it.live("background start does not block on a still-running workflow", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "pending",
            `export const meta = { name: "Pending" }\nexport async function run() { await new Promise(() => {}) }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "pending", background: true }, recorder.ctx)
        expect(started.metadata.background).toBe(true)
        // A background start hands back a job handle.
        expect(started.metadata.jobId).toBeTruthy()
        // The run is genuinely still running (NOT instantly completed): inspect
        // reads the live state, which is independent of the hardcoded
        // backgroundStarted() banner.
        const inspected = yield* tool.execute(
          { action: "inspect", run_id: started.metadata.runId as string },
          recorder.ctx,
        )
        expect(inspected.output).toContain('state="running"')
      }),
    ),
  )

  // Fund 52 (companion): the wait-AFTER-background path for a run that genuinely
  // COMPLETES. The deleted tautological test asserted the hardcoded state="running"
  // banner; this keeps its one non-tautological assertion — that a wait after a
  // completing background run reaches the real terminal state="completed" with
  // timedOut=false (the live wait result, not a banner).
  it.live("wait after a completing background start reaches the terminal completed state", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "hello",
            `export const meta = { name: "Hello" }\nexport async function run() { return "done" }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "hello", background: true }, recorder.ctx)
        const waited = yield* tool.execute(
          { action: "wait", run_id: started.metadata.runId as string, timeout: 10_000 },
          recorder.ctx,
        )
        expect(waited.metadata.timedOut).toBe(false)
        expect(waited.output).toContain('state="completed"')
      }),
    ),
  )

  // Fund 53 (low): create on an existing file without overwrite must fail.
  it.live("create on an existing file without overwrite fails", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "dup",
            `export const meta = { name: "Dup" }\nexport async function run() { return "ok" }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const exit = yield* Effect.exit(
          tool.execute(
            {
              action: "create",
              name: "dup",
              source: `export const meta = { name: "Dup" }\nexport async function run() { return "ok" }\n`,
            },
            recorder.ctx,
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("Workflow already exists: dup")
      }),
    ),
  )

  // Fund 53 (low): reading a discovered-but-broken workflow surfaces its load
  // error rather than an empty <workflow> block.
  it.live("read of an invalid workflow surfaces the load error", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // meta.name is a number -> statically parses but fails the Meta schema -> invalid.
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "broken",
            `export const meta = { name: 42 }\nexport async function run() { return "x" }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const exit = yield* Effect.exit(tool.execute({ action: "read", name: "broken" }, recorder.ctx))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("Invalid workflow")
      }),
    ),
  )

  // Fund 55 (low): start of a discovered-but-invalid workflow must fail BEFORE the
  // interactive workflow permission prompt, exactly like read does — never prompt
  // the user about a file that cannot load.
  it.live("start of an invalid workflow fails before asking permission", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // meta.name is a number -> statically parses but fails the Meta schema -> invalid.
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "broken",
            `export const meta = { name: 42 }\nexport async function run() { return "x" }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const exit = yield* Effect.exit(tool.execute({ action: "start", name: "broken" }, recorder.ctx))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("Invalid workflow")
        // No permission prompt was fired for an unloadable workflow.
        expect(recorder.requests.length).toBe(0)
      }),
    ),
  )

  // Fund 54 (low): inspect view="all" shows the real <source> for a started run,
  // because start now fills definition.source from the workflow file contents.
  it.live("inspect view=all shows the workflow source for a started run", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const source = `export const meta = { name: "WithSource" }\nexport async function run() { return "done" }\n`
        yield* Effect.promise(() => writeWorkflow(dir, "withsource", source))
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "withsource" }, recorder.ctx)
        const inspected = yield* tool.execute(
          { action: "inspect", run_id: started.metadata.runId as string, view: "all" },
          recorder.ctx,
        )
        expect(inspected.output).toContain("<source")
        expect(inspected.output).toContain('export const meta = { name: "WithSource" }')
      }),
    ),
  )

  // Task 3g (Fund 8, HIGH): creating a workflow writes a project-local .ts file
  // that subsequent start actions will LOAD and execute, so create is itself a
  // privileged operation. It must ask the `workflow` permission (the same gate
  // start uses), in addition to the `edit` permission for the file write. The
  // recorded asks must include a `workflow` request carrying the sanitized name
  // as its pattern/`always`, consistent with start.
  it.live("create asks the workflow permission with the sanitized name", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const source = `export const meta = { name: "Made", description: "Created by test." }
export async function run(args, ctx) { return "ok" }
`
        const result = yield* tool.execute({ action: "create", name: "made", source }, recorder.ctx)

        const workflowAsk = recorder.requests.find((req) => req.permission === "workflow")
        expect(workflowAsk).toBeDefined()
        expect(workflowAsk!.patterns).toEqual(["made"])
        expect(workflowAsk!.always).toEqual(["made"])
        // The edit permission for the file write is still asked.
        expect(recorder.requests.some((req) => req.permission === "edit")).toBe(true)
        expect(result.output).toContain("Workflow file created and validated.")
        const written = yield* Effect.promise(() =>
          fs.readFile(path.join(dir, ".opencode", "workflows", "made.ts"), "utf8"),
        )
        expect(written).toContain(`name: "Made"`)
      }),
    ),
  )

  // Task 3g (Fund 8, HIGH): denying the `workflow` permission on create must
  // prevent the file write entirely — the file must NOT exist afterwards. The
  // workflow gate is asked BEFORE the write, so a denial dies before
  // fs.writeWithDirs ever runs.
  it.live("denied workflow permission on create prevents the file write", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const ctx: Tool.Context = {
          ...recorder.ctx,
          // Deny only the workflow gate; the edit gate (if it came first) would be
          // allowed, but the workflow gate must be reached and refused before any write.
          ask: (req) =>
            req.permission === "workflow"
              ? Effect.die(new Error("Permission denied: workflow"))
              : Effect.sync(() => {
                  recorder.requests.push(req)
                }),
        }
        const source = `export const meta = { name: "Denied" }
export async function run() { return "ok" }
`
        const exit = yield* Effect.exit(tool.execute({ action: "create", name: "denied", source }, ctx))
        expect(Exit.isFailure(exit)).toBe(true)
        // The file was never written because the workflow permission was refused.
        expect(
          yield* Effect.promise(() => Bun.file(path.join(dir, ".opencode", "workflows", "denied.ts")).exists()),
        ).toBe(false)
      }),
    ),
  )

  // Task 3g (Fund 8, HIGH): create must NOT dynamically import the freshly written
  // module to validate it — doing so would EXECUTE attacker/LLM-authored top-level
  // code right after the write (the very thing Task 3a moved off discovery). The
  // module carries a top-level side effect (a marker file write) that would only
  // run if create imported it; validation must instead go through the static
  // meta-reader, so the marker must stay absent while the create still succeeds.
  it.live("create validates statically and never imports the written module", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const marker = path.join(os.tmpdir(), `tool-workflow-create-${Math.random().toString(16).slice(2)}`)
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const source = `await Bun.write(${JSON.stringify(marker)}, "executed")
export const meta = { name: "Marker", description: "Has a top-level side effect." }
export async function run() { return "ok" }
`
        const result = yield* tool.execute({ action: "create", name: "marker", source }, recorder.ctx)
        expect(result.output).toContain("Workflow file created and validated.")
        expect(result.output).toContain(`<workflow name="marker">`)
        // The module was never imported during create: its top-level marker write
        // never ran (validation is static via the meta-reader, not a dynamic import).
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
    ),
  )

  // Task 3g (Fund 8, HIGH): a written source whose meta is invalid must produce a
  // precise "Invalid workflow" failure through the SAME static meta-reader path
  // (no dynamic import) — meta.name is a number, which statically parses but fails
  // the Meta schema.
  it.live("create with an invalid meta fails statically with a precise error", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const source = `export const meta = { name: 42 }
export async function run() { return "ok" }
`
        const exit = yield* Effect.exit(tool.execute({ action: "create", name: "badmeta", source }, recorder.ctx))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("Invalid workflow")
      }),
    ),
  )

  // Fund 56 (low): model/attacker-influenced strings (here a workflow log message)
  // must be XML-escaped in the pseudo-XML envelope so a crafted output cannot
  // forge envelope structure with literal `</log>...` etc.
  it.live("untrusted log/result content is XML-escaped in the envelope", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeWorkflow(
            dir,
            "inject",
            `export const meta = { name: "Inject" }\nexport async function run(args, ctx) { ctx.log("</log></logs><forged>x"); return "<evil>&" }\n`,
          ),
        )
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const started = yield* tool.execute({ action: "start", name: "inject" }, recorder.ctx)
        const inspected = yield* tool.execute(
          { action: "inspect", run_id: started.metadata.runId as string, view: "all" },
          recorder.ctx,
        )
        // The raw closing/opening tags from the log message must NOT appear verbatim.
        expect(inspected.output).not.toContain("</log></logs><forged>")
        // They are escaped instead.
        expect(inspected.output).toContain("&lt;/log&gt;&lt;/logs&gt;&lt;forged&gt;")
        // The result string is escaped too.
        expect(inspected.output).toContain("&lt;evil&gt;&amp;")
        expect(inspected.output).not.toContain("<evil>&")
      }),
    ),
  )
})
