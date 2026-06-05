import { describe, expect } from "bun:test"
import { Workflow } from "@/workflow/workflow"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { Effect, Layer } from "effect"
import path from "path"

const it = testEffect(Layer.mergeAll(Workflow.defaultLayer))

async function writeWorkflow(dir: string, name: string, body: string, ext = "js") {
  await Bun.write(path.join(dir, ".opencode", "workflows", `${name}.${ext}`), body)
}

describe("Workflow", () => {
  it.instance("discovers workflow files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "hello",
          `export const meta = { name: "Hello", description: "Test workflow", phases: ["start"] }
export async function run(args, ctx) { ctx.setPhase("start"); ctx.log("hello"); return { ok: true } }
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      expect(list.map((item) => item.name)).toContain("hello")
      expect(list.find((item) => item.name === "hello")?.meta.name).toBe("Hello")
    }),
  )

  it.instance("starts and records a workflow run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "hello",
          `export const meta = { name: "Hello" }
export async function run(args, ctx) { ctx.setPhase("run"); ctx.log("running"); return { value: args.value } }
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: "hello", args: { value: 42 } })
      expect(run.status).toBe("running")
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("workflow did not finish")))
      expect(done.current_phase).toBe("run")
      expect(done.logs.map((item) => item.message)).toContain("running")
      expect(done.args).toEqual({ value: 42 })
      expect(done.definition?.name).toBe("hello")
      expect(done.definition?.path.endsWith("hello.js")).toBe(true)
      expect(done.result).toEqual({ value: 42 })
    }),
  )

  it.instance("preserves temporary workflow source in run definition", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const source = `export const meta = { name: "Temporary" }
export async function run(args, ctx) { ctx.setPhase("run"); return { value: args.value } }
`
      yield* Effect.promise(() => writeWorkflow(test.directory, "temporary", source))
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: "temporary", args: { value: 99 }, source, temporary: true })
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("workflow did not finish")))
      expect(done.definition?.temporary).toBe(true)
      expect(done.definition?.source).toBe(source)
      expect(done.result).toEqual({ value: 99 })
    }),
  )

  it.instance("loads TypeScript workflow default exports", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "typed",
          `export default {
  meta: { name: "Typed Workflow", phases: ["run"] },
  async run(args, ctx) { ctx.setPhase("run"); ctx.log("typed"); return { value: args.value } }
}
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      expect(list.map((item) => item.name)).toContain("typed")
      const run = yield* workflow.start({ name: "typed", args: { value: 7 } })

      const done = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current?.status === "completed" ? current : undefined
        }),
        "workflow never completed",
      )
      expect(done.result).toEqual({ value: 7 })
    }),
  )

  it.instance("reloads workflow implementation after file changes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "reload",
          `export const meta = { name: "Reload One" }
export async function run() { return { value: "one" } }
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const first = yield* workflow.start({ name: "reload" })
      const firstWaited = yield* workflow.wait({ id: first.id })
      const firstDone = firstWaited.run ?? (yield* Effect.fail(new Error("first workflow did not finish")))
      expect(firstDone.definition?.meta.name).toBe("Reload One")
      expect(firstDone.result).toEqual({ value: "one" })

      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "reload",
          `export const meta = { name: "Reload Two" }
export async function run() { return { value: "two" } }
`,
          "ts",
        ),
      )

      const second = yield* workflow.start({ name: "reload" })
      const secondWaited = yield* workflow.wait({ id: second.id })
      const secondDone = secondWaited.run ?? (yield* Effect.fail(new Error("second workflow did not finish")))
      expect(secondDone.definition?.meta.name).toBe("Reload Two")
      expect(secondDone.result).toEqual({ value: "two" })
    }),
  )
})
