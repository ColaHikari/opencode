import { describe, expect } from "bun:test"
import { Workflow } from "@/workflow/workflow"
import type { SessionPrompt } from "@/session/prompt"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowRunTable } from "@opencode-ai/core/workflow/sql"
import { eq } from "drizzle-orm"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { Deferred, Effect, Layer } from "effect"
import path from "path"

// Database.defaultLayer is merged so the orphan-sweep tests can seed a row
// directly through the same in-memory SQLite connection the engine uses.
const it = testEffect(Layer.mergeAll(Workflow.defaultLayer, Database.defaultLayer))

const HELLO_FIXTURE = "hello"

// Seeds a workflow_run row in status="running" with NO live registry entry,
// the exact shape an orphaned (crashed/restarted) run leaves behind.
function seedRunningRow(id: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(WorkflowRunTable)
      .values({
        id,
        workflow: HELLO_FIXTURE,
        status: "running",
        started_at: Date.now(),
        logs: [],
        agents: [],
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function fetchRunRow(id: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select()
      .from(WorkflowRunTable)
      .where(eq(WorkflowRunTable.id, id))
      .get()
      .pipe(Effect.orDie)
    return row ?? (yield* Effect.fail(new Error(`row ${id} not found`)))
  })
}

// Seeds a fully finished run (with log + agent telemetry) straight into the DB.
// Because it never went through start(), it has NO live registry entry, so
// get() is forced through the DB->fromRow path — no test-only seam required.
function seedCompletedRow(id: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db
      .insert(WorkflowRunTable)
      .values({
        id,
        workflow: HELLO_FIXTURE,
        status: "completed",
        started_at: now,
        completed_at: now,
        current_phase: "run",
        logs: [{ time: now, phase: "run", message: "running" }],
        agents: [
          {
            id: "1",
            status: "completed",
            started_at: now,
            completed_at: now,
            phase: "run",
            prompt: "do the thing",
            output: "did the thing",
          },
        ],
        result: { ok: true },
      })
      .run()
      .pipe(Effect.orDie)
  })
}

async function writeWorkflow(dir: string, name: string, body: string, ext = "js") {
  await Bun.write(path.join(dir, ".opencode", "workflows", `${name}.${ext}`), body)
}

const STEP2_MARKER = "step-2-reached"
const SLOW_FIXTURE = "slow"

// Fixture-Workflow: ein absichtlich blockierender Agent-Schritt, danach ein
// zweiter Schritt (STEP2_MARKER), der bei korrekter Cancellation NIE läuft.
const SLOW_WORKFLOW = `export const meta = { name: "${SLOW_FIXTURE}", phases: ["agent", "after"] }
export async function run(args, ctx) {
  ctx.setPhase("agent")
  ctx.log("step-1-started")
  await ctx.agent({ prompt: "hang" })
  ctx.setPhase("after")
  ctx.log("${STEP2_MARKER}")
  return { ok: true }
}
`

function assistantReply(): SessionV1.WithParts {
  return { info: { role: "assistant" }, parts: [] } as unknown as SessionV1.WithParts
}

// Test-Prompt-Ops, die das echte Session-Abort-Verhalten nachbilden:
// - die initiale "Workflow started"-Nachricht (noReply) wird sofort beantwortet,
//   damit start() zurückkehrt;
// - jeder Agent-Prompt blockiert (langer, unterbrechbarer Lauf), bis cancel()
//   die Session abbricht; cancel() protokolliert die abgebrochene Child-Session
//   und unterbricht den laufenden Prompt (wie SessionPrompt.cancel -> Abort).
function hangingPromptOps() {
  const aborted = new Set<string>()
  const started = new Set<string>()
  const gates = new Map<string, Deferred.Deferred<void>>()
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        const gate = yield* Deferred.make<void>()
        gates.set(input.sessionID, gate)
        started.add(input.sessionID)
        // Läuft, bis die Session per cancel() abgebrochen wird (Gate -> Interrupt)
        // oder der lange Lauf endet. Der Timer hält die Suspension unterbrechbar.
        yield* Effect.race(
          Effect.sleep("30 seconds"),
          Deferred.await(gate).pipe(Effect.flatMap(() => Effect.interrupt)),
        )
        return assistantReply()
      }),
    cancel: (sessionID) =>
      Effect.gen(function* () {
        aborted.add(sessionID)
        const gate = gates.get(sessionID)
        if (gate) yield* Deferred.succeed(gate, undefined)
      }),
  }
  return { ops, aborted, started }
}

// Schema-Fixtures: Workflows, deren run(ctx) den Agenten MIT Schema aufruft
// (strukturierte Ausgabe angefordert). Der Promtp-Ops-Fake (unten) steuert, ob
// die Session strukturierte Daten, undefined oder einen StructuredOutputError
// liefert. Jeder gibt das geparste Objekt im Ergebnis zurück, damit der
// Positivpfad das Objekt durchreichen kann.
const SCHEMA_SUCCESS_FIXTURE = "schema-success"
const SCHEMA_UNDEFINED_FIXTURE = "schema-undefined"
const SCHEMA_FAILING_FIXTURE = "schema-failing"
const SCHEMA_OBJECT = { value: 123 }

function schemaWorkflow(name: string) {
  return `export const meta = { name: "${name}", phases: ["agent"] }
export async function run(args, ctx) {
  ctx.setPhase("agent")
  const result = await ctx.agent({ prompt: "produce structured", schema: { type: "object" } })
  return { data: result.data }
}
`
}

// Prompt-Ops-Fake, der die SESSION-Schicht nachbildet (nicht die Engine): die
// initiale noReply-Nachricht wird sofort beantwortet; der Agent-Prompt liefert
// eine Assistant-Nachricht, deren `structured`/`error`-Feld der Modus bestimmt:
// - "structured": message.info.structured ist gesetzt (Erfolgspfad);
// - "undefined": structured fehlt trotz angefordertem Schema (stiller Fallback,
//   der jetzt scheitern muss);
// - "error": die Session hat einen StructuredOutputError auf message.info.error
//   gesetzt (genau wie packages/opencode/src/session/prompt.ts es tut), gibt aber
//   weiterhin erfolgreich eine WithParts zurück.
function structuredPromptOps(mode: "structured" | "undefined" | "error") {
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        const info: Record<string, unknown> = {
          role: "assistant",
          providerID: "test",
          modelID: "test-model",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        if (mode === "structured") info.structured = SCHEMA_OBJECT
        if (mode === "error")
          info.error = {
            name: "StructuredOutputError",
            data: { message: "Model did not produce structured output", retries: 0 },
          }
        const parts =
          mode === "undefined" || mode === "error" ? [{ type: "text", text: "here is some plaintext" }] : []
        return { info: { ...info, id: "msg_test" }, parts } as unknown as SessionV1.WithParts
      }),
    cancel: () => Effect.void,
  }
  return ops
}

// Budget-Fixtures. Der Engine liest die Agent-Kosten aus `message.info.cost`
// (USD) — exakt wie der echte Session-Pfad und das TUI-Dashboard. Dieser Fake
// bildet GENAU diese Telemetrie-Form nach: jede beantwortete Agent-Nachricht
// trägt `cost` (und `tokens`, wie die echte Session), sodass der Engine pro
// Step das Restbudget korrekt dekrementieren kann.
function costPromptOps(cost: number) {
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        return {
          info: {
            id: "msg_test",
            role: "assistant",
            providerID: "test",
            modelID: "test-model",
            cost,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{ type: "text", text: "ok" }],
        } as unknown as SessionV1.WithParts
      }),
    cancel: () => Effect.void,
  }
  return ops
}

// Zwei sequentielle ctx.agent-Aufrufe; bei kleinem Budget muss der zweite
// Aufruf am Budget-Gate scheitern (Restbudget <= 0 nach dem ersten Step).
const BUDGET_FIXTURE = "budget-two-steps"
const BUDGET_WORKFLOW = `export const meta = { name: "${BUDGET_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "step one" })
  await ctx.agent({ prompt: "step two" })
  return { ok: true }
}
`

// Schreibt ctx.budgetRemaining vor und nach einem Agent-Step ins Resultat,
// damit der Test die Live-Dekrementierung beobachten kann.
const BUDGET_REMAINING_FIXTURE = "budget-remaining"
const BUDGET_REMAINING_WORKFLOW = `export const meta = { name: "${BUDGET_REMAINING_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const before = ctx.budgetRemaining
  await ctx.agent({ prompt: "spend" })
  const after = ctx.budgetRemaining
  return { before, after }
}
`

// Liest ctx.budgetRemaining OHNE gesetztes Budget — muss Infinity sein.
const BUDGET_UNLIMITED_FIXTURE = "budget-unlimited"
const BUDGET_UNLIMITED_WORKFLOW = `export const meta = { name: "${BUDGET_UNLIMITED_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const remaining = ctx.budgetRemaining
  await ctx.agent({ prompt: "spend" })
  return { unlimited: remaining === Infinity }
}
`

// Pipeline-Fixture: zwei Items ("A","B"), zwei Stages. Stage 2 ändert den Typ
// (string -> { a, b }). Item A wird in Stage 1 künstlich verlangsamt, damit Item
// B Stage 2 erreichen kann, BEVOR Item A Stage 1 verlässt — der Nachweis, dass
// es KEINE Barriere zwischen den Stages gibt (Items laufen unabhängig durch die
// Stage-Sequenz). Reihenfolge-Marker und Ergebnis werden über ctx.log bzw. das
// Workflow-Resultat beobachtbar gemacht; das Resultat enthält die Marker-Folge
// und das Stage-2-Resultat in Item-Reihenfolge.
const PIPELINE_FIXTURE = "pipeline"
const PIPELINE_WORKFLOW = `export const meta = { name: "${PIPELINE_FIXTURE}", phases: ["pipeline"] }
export async function run(args, ctx) {
  ctx.setPhase("pipeline")
  const order = []
  const slow = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const result = await ctx.pipeline(
    ["A", "B"],
    async (item) => {
      order.push(item + ":stage1:start")
      // Item A trödelt in Stage 1, damit B in Stage 2 vorrückt.
      if (item === "A") await slow(80)
      order.push(item + ":stage1:done")
      return { item, n: item === "A" ? 1 : 2 }
    },
    async (prev, item) => {
      order.push(item + ":stage2")
      return { a: prev.n, b: prev.item === "A" ? "x" : "y" }
    },
  )
  for (const marker of order) ctx.log(marker)
  return { order, result }
}
`

// Parallel-Fixture: sechs Tasks à ~40ms, concurrencyLimit aus den args. Jede
// Task meldet Start/Ende über zwei globale Zähler (auf globalThis, weil das
// Workflow-Modul in seinem eigenen ESM-Realm läuft); der Workflow gibt die
// beobachtete Spitzen-Parallelität und die Task-Resultate zurück.
const PARALLEL_FIXTURE = "parallel-limit"
const PARALLEL_WORKFLOW = `export const meta = { name: "${PARALLEL_FIXTURE}", phases: ["parallel"] }
export async function run(args, ctx) {
  ctx.setPhase("parallel")
  let active = 0
  let peak = 0
  const slow = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const tasks = Array.from({ length: 6 }, (_, i) => async () => {
    active++
    peak = Math.max(peak, active)
    await slow(40)
    active--
    return i
  })
  const result = await ctx.parallel(tasks, { concurrencyLimit: args.concurrencyLimit })
  return { peak, result }
}
`

describe("Workflow", () => {
  it.instance("pipeline runs stages per item without a barrier and supports heterogeneous types", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PIPELINE_FIXTURE, PIPELINE_WORKFLOW))
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: PIPELINE_FIXTURE, args: {} })
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("pipeline did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as { order: string[]; result: Array<{ a: number; b: string }> }
      // Kein Barrier: Item B erreicht Stage 2, bevor Item A Stage 1 verlässt.
      expect(result.order.indexOf("B:stage2")).toBeLessThan(result.order.indexOf("A:stage1:done"))
      // Stage 2 ändert den Typ; Ergebnis in Item-Reihenfolge.
      expect(result.result).toEqual([
        { a: 1, b: "x" },
        { a: 2, b: "y" },
      ])
    }),
  )

  it.instance("parallel respects concurrencyLimit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PARALLEL_FIXTURE, PARALLEL_WORKFLOW))
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: PARALLEL_FIXTURE, args: { concurrencyLimit: 2 } })
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("parallel did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as { peak: number; result: number[] }
      expect(result.result).toHaveLength(6)
      expect(result.peak).toBeLessThanOrEqual(2)
      // Untergrenze: 6 Tasks à ~40ms bei Limit 2 erreichen zuverlässig peak 2 —
      // schützt gegen versehentliches Über-Clamping des Limits auf 1.
      expect(result.peak).toBeGreaterThanOrEqual(2)
    }),
  )

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

  it.instance("a broken workflow file does not break list(); it is reported invalid", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          HELLO_FIXTURE,
          `export const meta = { name: "Hello", description: "Test workflow", phases: ["start"] }
export async function run(args, ctx) { ctx.setPhase("start"); ctx.log("hello"); return { ok: true } }
`,
        ),
      )
      // Syntaxfehler: unvollständiges Objektliteral -> Modul-Load schlägt fehl.
      yield* Effect.promise(() => writeWorkflow(test.directory, "broken", "export const meta = {"))
      const workflow = yield* Workflow.Service

      const all = yield* workflow.list()
      const broken = all.find((item) => item.name === "broken")
      expect(broken?.valid).toBe(false)
      expect(broken?.error).toBeTruthy()
      // Die gute Datei bleibt trotz der kaputten weiterhin gelistet und gültig.
      expect(all.some((item) => item.name === HELLO_FIXTURE && item.valid !== false)).toBe(true)
    }),
  )

  it.instance("start loads only the target module and fails precisely for broken target", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          HELLO_FIXTURE,
          `export const meta = { name: "Hello" }
export async function run(args, ctx) { ctx.setPhase("run"); ctx.log("running"); return { ok: true } }
`,
        ),
      )
      yield* Effect.promise(() => writeWorkflow(test.directory, "broken", "export const meta = {"))
      const workflow = yield* Workflow.Service

      // Ein kaputtes Ziel scheitert präzise (InvalidError, der die Datei/den Namen nennt).
      const failed = yield* workflow.start({ name: "broken", args: {} }).pipe(Effect.flip)
      expect(failed._tag).toBe("WorkflowInvalidError")
      // Narrow the start() error union (InvalidError | NotFoundError) to the
      // precise InvalidError so its `path` is accessible and typed.
      const invalid =
        failed instanceof Workflow.InvalidError ? failed : (yield* Effect.fail(new Error("expected InvalidError")))
      expect(invalid.path).toContain("broken")

      // Die gültige Datei ist trotz broken.ts startbar (kein voller list()-Abbruch).
      const ok = yield* workflow.start({ name: HELLO_FIXTURE, args: {} })
      expect(ok.id).toBeTruthy()
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

  it.instance("cancel interrupts a running workflow and aborts its agent sessions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SLOW_FIXTURE, SLOW_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, aborted, started } = hangingPromptOps()

      const run = yield* workflow.start({ name: SLOW_FIXTURE, args: {}, prompt: ops })

      // Warten bis der erste Agent läuft und seine Child-Session erzeugt hat.
      const live = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current && current.agents.some((a) => a.status === "running" && a.session_id) ? current : undefined
        }),
        "agent never started",
      )
      expect(live.agents.some((a) => a.status === "running")).toBe(true)

      yield* workflow.cancel(run.id)

      const after = yield* workflow.get(run.id)
      const done = after ?? (yield* Effect.fail(new Error("run vanished")))
      expect(done.status).toBe("cancelled")
      // Kein Agent darf nach Cancel noch laufen.
      expect(done.agents.every((a) => a.status !== "running")).toBe(true)
      // Folge-Step darf nie gestartet sein.
      expect(done.logs.some((l) => l.message?.includes(STEP2_MARKER))).toBe(false)
      // Kern-Assertion: die Child-Session wurde echt abgebrochen.
      const childSession = done.agents[0]?.session_id
      expect(childSession).toBeDefined()
      expect(started.has(childSession!)).toBe(true)
      expect(aborted.has(childSession!)).toBe(true)
    }),
  )

  it.instance("remove on a running run cancels it first, then deletes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SLOW_FIXTURE, SLOW_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, aborted } = hangingPromptOps()

      const run = yield* workflow.start({ name: SLOW_FIXTURE, args: {}, prompt: ops })

      const live = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current && current.agents.some((a) => a.status === "running" && a.session_id) ? current : undefined
        }),
        "agent never started",
      )
      const childSession = live.agents[0]?.session_id
      expect(childSession).toBeDefined()

      yield* workflow.remove(run.id)

      // Run ist gelöscht.
      const gone = yield* workflow.get(run.id)
      expect(gone).toBeUndefined()
      // Und die Child-Session wurde vor dem Löschen abgebrochen.
      expect(aborted.has(childSession!)).toBe(true)
    }),
  )

  // Orphan-Mechanismus: Die In-Memory-Test-DB (OPENCODE_DB=:memory:) überlebt
  // keine frische Layer-Instanz, daher wird der Orphan simuliert, indem wir eine
  // running-Zeile OHNE Registry-Eintrag direkt über die SQL-Schicht einfügen und
  // anschließend NUR den Sweep auslösen (engine.sweep()), so wie er beim
  // Service-Start läuft (leere Registry -> alle running-Zeilen werden gefegt).
  it.instance("orphaned running rows are marked interrupted on service start", () =>
    Effect.gen(function* () {
      const workflow = yield* Workflow.Service
      const orphanId = "job_orphan_sweep"
      yield* seedRunningRow(orphanId)

      yield* workflow.sweep()

      const row = yield* fetchRunRow(orphanId)
      expect(row.status).toBe("interrupted")
      expect(row.completed_at).toBeGreaterThan(0)
    }),
  )

  it.instance("persisted run round-trips through fromRow", () =>
    Effect.gen(function* () {
      const workflow = yield* Workflow.Service
      const persistedId = "job_roundtrip"
      // Persist a finished run directly via the SQL layer (no live registry
      // entry), so get() must read it back through DB->fromRow.
      yield* seedCompletedRow(persistedId)

      const viaDb = yield* workflow.get(persistedId)
      const persisted = viaDb ?? (yield* Effect.fail(new Error("run not persisted")))
      expect(persisted).toMatchObject({ id: persistedId, status: "completed" })
      // Telemetrie überlebt den Roundtrip durch fromRow.
      expect(persisted.logs.map((item) => item.message)).toContain("running")
      expect(persisted.agents.length).toBeGreaterThan(0)
      expect(persisted.agents[0]?.output).toBe("did the thing")
    }),
  )

  it.instance("wait on interrupted run resolves immediately as interrupted (not timedOut)", () =>
    Effect.gen(function* () {
      const workflow = yield* Workflow.Service
      const orphanId = "job_orphan_wait"
      yield* seedRunningRow(orphanId)
      yield* workflow.sweep()

      const res = yield* workflow.wait({ id: orphanId, timeout: 50 })
      expect(res.run?.status).toBe("interrupted")
      expect(res.timedOut).not.toBe(true)
    }),
  )

  it.instance("schema agent failure is recorded as failed, never silently completed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, SCHEMA_FAILING_FIXTURE, schemaWorkflow(SCHEMA_FAILING_FIXTURE)),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({
        name: SCHEMA_FAILING_FIXTURE,
        args: {},
        prompt: structuredPromptOps("error"),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("failed")
      expect(done.run?.agents.some((a) => a.status === "failed")).toBe(true)
      // Kein stiller Plaintext-Fallback: der Agent darf NICHT completed sein.
      expect(done.run?.agents.some((a) => a.status === "completed")).toBe(false)
    }),
  )

  it.instance("schema agent with undefined structured result fails instead of plaintext fallback", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, SCHEMA_UNDEFINED_FIXTURE, schemaWorkflow(SCHEMA_UNDEFINED_FIXTURE)),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({
        name: SCHEMA_UNDEFINED_FIXTURE,
        args: {},
        prompt: structuredPromptOps("undefined"),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("failed")
      expect(done.run?.agents.some((a) => a.status === "failed")).toBe(true)
    }),
  )

  it.instance("schema agent success returns the parsed object and completes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, SCHEMA_SUCCESS_FIXTURE, schemaWorkflow(SCHEMA_SUCCESS_FIXTURE)),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({
        name: SCHEMA_SUCCESS_FIXTURE,
        args: {},
        prompt: structuredPromptOps("structured"),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      // Positivpfad: das geparste Objekt wird durch ctx.agent (result.data) und
      // damit das Workflow-Resultat hindurchgereicht.
      expect(done.run?.result).toEqual({ data: SCHEMA_OBJECT })
      expect(done.run?.agents.every((a) => a.status === "completed")).toBe(true)
    }),
  )

  it.instance("agent calls beyond exhausted budget fail the run with a budget error", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, BUDGET_FIXTURE, BUDGET_WORKFLOW))
      const workflow = yield* Workflow.Service
      // Budget 1.0 USD, jeder Step kostet 1.0 — nach Step 1 ist das Budget
      // erschöpft (Rest 0), also scheitert der zweite ctx.agent am Gate.
      const run = yield* workflow.start({
        name: BUDGET_FIXTURE,
        args: {},
        prompt: costPromptOps(1),
        budget: 1,
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("failed")
      expect(done.run?.error ?? "").toMatch(/budget/i)
      // Erster Step lief, zweiter Step scheiterte am Gate.
      expect(done.run?.agents.filter((a) => a.status === "completed").length).toBe(1)
      expect(done.run?.agents.some((a) => a.status === "failed")).toBe(true)
    }),
  )

  it.instance("budgetRemaining reflects real spend during the run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, BUDGET_REMAINING_FIXTURE, BUDGET_REMAINING_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({
        name: BUDGET_REMAINING_FIXTURE,
        args: {},
        prompt: costPromptOps(0.25),
        budget: 1,
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      const result = done.run?.result as { before: number; after: number }
      expect(result.before).toBe(1)
      // Nach einem Step à 0.25 USD bleibt 0.75 übrig.
      expect(result.after).toBe(0.75)
      expect(result.after).toBeLessThan(result.before)
    }),
  )

  it.instance("no budget set means unlimited (Infinity) — unchanged default", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, BUDGET_UNLIMITED_FIXTURE, BUDGET_UNLIMITED_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({
        name: BUDGET_UNLIMITED_FIXTURE,
        args: {},
        prompt: costPromptOps(5),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      expect((done.run?.result as { unlimited: boolean }).unlimited).toBe(true)
    }),
  )
})
