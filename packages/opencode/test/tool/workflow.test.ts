import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import type { Permission } from "@/permission"
import type { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { WorkflowTool } from "@/tool/workflow"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"

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
  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { ctx, requests }
}

function workflowTool() {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const tool = (yield* registry.tools({
      providerID: ProviderID.opencode,
      modelID: ModelID.make("gpt-5"),
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

  it.live("runs temporary workflow, removes file, and preserves source in history", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const source = `export const meta = { name: "Temporary", description: "One shot." }
export async function run(args, ctx) { ctx.setPhase("run"); return { value: args.value } }
`
        const tool = yield* workflowTool()
        const recorder = requestRecorder()
        const result = yield* tool.execute({ action: "run_temporary", source, args: { value: 7 } }, recorder.ctx)
        const runID = typeof result.metadata.runId === "string" ? result.metadata.runId : ""
        const details = yield* tool.execute({ action: "inspect", run_id: runID, view: "all" }, recorder.ctx)
        const files = yield* Effect.promise(() => fs.readdir(path.join(dir, ".opencode", "workflows")))

        expect(recorder.requests[0].permission).toBe("workflow")
        expect(recorder.requests[0].patterns).toEqual(["temporary"])
        expect(details.output).toContain("<temporary>true</temporary>")
        expect(details.output).toContain(source)
        expect(files).toEqual([])
        expect(result.output).toContain('"value": 7')
      }),
    ),
  )
})
