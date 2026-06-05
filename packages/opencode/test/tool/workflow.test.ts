import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import type { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { WorkflowTool } from "@/tool/workflow"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageID, SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { SessionPrompt } from "@/session/prompt"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { PartID } from "@/session/schema"

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, CrossSpawnSpawner.defaultLayer))

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
        const result = yield* tool.execute(
          { action: "start", name: "ask" },
          recorder.ctx,
        )

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

  it.live("background start returns immediately and wait reaches the terminal state", () =>
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
        const started = yield* tool.execute({ action: "start", name: "hello", background: true }, recorder.ctx)

        expect(started.output).toContain('state="running"')
        expect(started.output).toContain("Workflow started in background.")
        expect(started.metadata.background).toBe(true)
        expect(started.metadata.jobId).toBeTruthy()

        const waited = yield* tool.execute(
          { action: "wait", run_id: started.metadata.runId as string, timeout: 10_000 },
          recorder.ctx,
        )
        expect(waited.metadata.timedOut).toBe(false)
        expect(waited.output).toContain('state="completed"')
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
})
