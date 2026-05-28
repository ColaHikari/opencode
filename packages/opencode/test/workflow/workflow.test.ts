import { describe, expect } from "bun:test"
import { Workflow } from "@/workflow/workflow"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"

const it = testEffect(Layer.mergeAll(Workflow.defaultLayer))

async function writeWorkflow(dir: string, name: string, body: string) {
  const workflows = path.join(dir, ".opencode", "workflows")
  await fs.mkdir(workflows, { recursive: true })
  await fs.writeFile(path.join(workflows, `${name}.js`), body)
}

async function writeTsWorkflow(dir: string, name: string, body: string) {
  const workflows = path.join(dir, ".opencode", "workflows")
  await fs.mkdir(workflows, { recursive: true })
  await fs.writeFile(path.join(workflows, `${name}.ts`), body)
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
      function wait(): Effect.Effect<Workflow.Run> {
        return Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          if (current?.status === "completed") return current
          yield* Effect.sleep("10 millis")
          return yield* wait()
        })
      }
      const done = yield* wait()
      expect(done.current_phase).toBe("run")
      expect(done.logs.map((item) => item.message)).toContain("running")
      expect(done.result).toEqual({ value: 42 })
    }),
  )

  it.instance("loads TypeScript workflow default exports", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeTsWorkflow(
          test.directory,
          "typed",
          `export default {
  meta: { name: "Typed Workflow", phases: ["run"] },
  async run(args, ctx) { ctx.setPhase("run"); ctx.log("typed"); return { value: args.value } }
}
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      expect(list.map((item) => item.name)).toContain("typed")
      const run = yield* workflow.start({ name: "typed", args: { value: 7 } })

      function wait(): Effect.Effect<Workflow.Run> {
        return Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          if (current?.status === "completed") return current
          yield* Effect.sleep("10 millis")
          return yield* wait()
        })
      }

      const done = yield* wait()
      expect(done.result).toEqual({ value: 7 })
    }),
  )
})
