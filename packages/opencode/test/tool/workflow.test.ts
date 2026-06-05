import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
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
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
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
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
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
})
