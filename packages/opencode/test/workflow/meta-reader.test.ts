import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { MetaReader } from "@/workflow/meta-reader"

const FAKE_PATH = path.join(os.tmpdir(), "fake-workflow.ts")

describe("MetaReader", () => {
  test("extracts literal meta from named exports (export const meta / export function run)", () => {
    const source = `export const meta = {
  name: "Hello",
  description: "Test workflow",
  phases: ["start", "end"],
  arguments: { value: { type: "number", description: "A value" } }
}
export async function run(args, ctx) { return { ok: true } }
`
    const result = MetaReader.read(source, FAKE_PATH)
    expect(result.valid).toBe(true)
    if (!result.valid) throw new Error("expected valid")
    expect(result.meta.name).toBe("Hello")
    expect(result.meta.description).toBe("Test workflow")
    expect(result.meta.phases).toEqual(["start", "end"])
    expect(result.meta.arguments).toEqual({ value: { type: "number", description: "A value" } })
  })

  test("extracts literal meta from a default object literal (export default { meta, run })", () => {
    const source = `export default {
  meta: { name: "Typed Workflow", phases: ["run"] },
  async run(args, ctx) { return { ok: true } }
}
`
    const result = MetaReader.read(source, FAKE_PATH)
    expect(result.valid).toBe(true)
    if (!result.valid) throw new Error("expected valid")
    expect(result.meta.name).toBe("Typed Workflow")
    expect(result.meta.phases).toEqual(["run"])
  })

  test("extracts literal meta from an export default workflow({ ... }) call", () => {
    const source = `import { workflow } from "@opencode-ai/plugin/workflow"
export default workflow({
  name: "Called",
  description: "Built via helper",
  phases: ["one"],
  arguments: { x: { type: "string" } },
  async run(args, ctx) { return { ok: true } }
})
`
    const result = MetaReader.read(source, FAKE_PATH)
    expect(result.valid).toBe(true)
    if (!result.valid) throw new Error("expected valid")
    expect(result.meta.name).toBe("Called")
    expect(result.meta.description).toBe("Built via helper")
    expect(result.meta.phases).toEqual(["one"])
    expect(result.meta.arguments).toEqual({ x: { type: "string" } })
  })

  test("does NOT execute module top-level code (no import, no side effects)", async () => {
    const marker = path.join(os.tmpdir(), `meta-reader-marker-${Math.random().toString(16).slice(2)}`)
    // Top-level await with a real side effect: if the reader were to import/run
    // the module, this marker file would be written. Static extraction must not.
    const source = `await Bun.write(${JSON.stringify(marker)}, "executed")
export const meta = { name: "SideEffect" }
export async function run(args, ctx) { return { ok: true } }
`
    const result = MetaReader.read(source, FAKE_PATH)
    expect(result.valid).toBe(true)
    if (!result.valid) throw new Error("expected valid")
    expect(result.meta.name).toBe("SideEffect")
    // The marker must NOT exist: top-level code was never run.
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test("non-statically-analyzable meta is reported invalid (no throw)", () => {
    const source = `export const meta = { name: process.env.SECRET_NAME }
export async function run(args, ctx) { return { ok: true } }
`
    const result = MetaReader.read(source, FAKE_PATH)
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("expected invalid")
    expect(result.error).toContain("statically analyzable")
  })

  test("computed property name (name: someFn()) is reported invalid", () => {
    const source = `function compute() { return "x" }
export const meta = { name: compute() }
export async function run(args, ctx) { return { ok: true } }
`
    const result = MetaReader.read(source, FAKE_PATH)
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("expected invalid")
    expect(result.error).toContain("statically analyzable")
  })

  test("meta that fails the schema (missing name) is reported invalid", () => {
    const source = `export const meta = { description: "no name here" }
export async function run(args, ctx) { return { ok: true } }
`
    const result = MetaReader.read(source, FAKE_PATH)
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("expected invalid")
    expect(result.error).toBeTruthy()
  })

  test("a file with no default export and no meta export is reported invalid", () => {
    const source = `export async function run(args, ctx) { return { ok: true } }
`
    const result = MetaReader.read(source, FAKE_PATH)
    expect(result.valid).toBe(false)
    if (result.valid) throw new Error("expected invalid")
    expect(result.error).toBeTruthy()
  })

  test("negative and boolean literals are extracted faithfully", () => {
    const source = `export const meta = {
  name: "Literals",
  arguments: { flag: { type: "boolean", default: false }, n: { type: "number", default: -3 } }
}
export async function run(args, ctx) { return { ok: true } }
`
    const result = MetaReader.read(source, FAKE_PATH)
    expect(result.valid).toBe(true)
    if (!result.valid) throw new Error("expected valid")
    expect(result.meta.arguments).toEqual({
      flag: { type: "boolean", default: false },
      n: { type: "number", default: -3 },
    })
  })
})
