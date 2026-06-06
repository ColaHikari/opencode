import { describe, expect } from "bun:test"
import { Workflow } from "@/workflow/workflow"
import type { SessionPrompt } from "@/session/prompt"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowRunTable } from "@opencode-ai/core/workflow/sql"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { eq, sql } from "drizzle-orm"
import { TestInstance, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import path from "path"

// Database.defaultLayer is merged so the orphan-sweep tests can seed a row
// directly through the same in-memory SQLite connection the engine uses.
const it = testEffect(Layer.mergeAll(Workflow.defaultLayer, Database.defaultLayer, CrossSpawnSpawner.defaultLayer))

const HELLO_FIXTURE = "hello"

// Seeds a workflow_run row in status="running" with NO live registry entry,
// the exact shape an orphaned (crashed/restarted) run leaves behind. The row is
// owned by the calling workspace `directory` so the directory-scoped sweep/get
// (Fund 6/17) recognises it as a local zombie rather than a foreign run.
function seedRunningRow(id: string, directory: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(WorkflowRunTable)
      .values({
        id,
        workflow: HELLO_FIXTURE,
        status: "running",
        started_at: Date.now(),
        directory,
        logs: [],
        agents: [],
      })
      .run()
      .pipe(Effect.orDie)
  })
}

// Seeds a `running` row that ALSO carries a still-`running` agent node — the
// shape an orphaned run leaves behind once it had dispatched an agent. The sweep
// must normalise BOTH the run row (→ interrupted) and the zombie agent node
// (→ failed with completed_at + error), so the TUI never renders a live agent
// icon on a terminal run (Fund 15).
function seedRunningRowWithAgent(id: string, directory: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db
      .insert(WorkflowRunTable)
      .values({
        id,
        workflow: HELLO_FIXTURE,
        status: "running",
        started_at: now,
        directory,
        current_phase: "run",
        logs: [],
        agents: [
          { id: "1", status: "running", started_at: now, phase: "run", prompt: "hang" },
          { id: "2", status: "completed", started_at: now, completed_at: now, phase: "run", prompt: "done" },
        ],
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function fetchRunRow(id: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, id)).get().pipe(Effect.orDie)
    return row ?? (yield* Effect.fail(new Error(`row ${id} not found`)))
  })
}

// Reads the RAW `result` column text (bypassing any json decode) so a test can
// prove how the engine serialised it: SQL-NULL (never set) vs the literal JSON
// text `"null"` (a real null result) — the distinction Fund 42 turns on.
function fetchRawResult(id: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select({ raw: sql<string | null>`${WorkflowRunTable.result}` })
      .from(WorkflowRunTable)
      .where(eq(WorkflowRunTable.id, id))
      .get()
      .pipe(Effect.orDie)
    return row?.raw ?? null
  })
}

// Seeds a fully finished run (with log + agent telemetry) straight into the DB.
// Because it never went through start(), it has NO live registry entry, so
// get() is forced through the DB->fromRow path — no test-only seam required.
function seedCompletedRow(id: string, directory: string) {
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
        directory,
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
        // The `result` column is plain text and the engine owns its JSON codec
        // (Fund 42), so a seed must serialize exactly like persistRun does — a raw
        // object would fail the bind. The roundtrip test reads this back through
        // fromRow, which JSON-parses it.
        result: JSON.stringify({ ok: true }),
      })
      .run()
      .pipe(Effect.orDie)
  })
}

async function writeWorkflow(dir: string, name: string, body: string, ext = "js") {
  await Bun.write(path.join(dir, ".opencode", "workflows", `${name}.${ext}`), body)
}

import os from "os"

// A workflow whose TOP-LEVEL body writes a marker file the moment the module is
// imported and executed. list()/discover() must NEVER produce this marker
// (static meta extraction only); start() must, because it really imports the
// target module after the permission gate.
const SIDE_EFFECT_FIXTURE = "side-effect"
function sideEffectWorkflow(markerPath: string) {
  return `await Bun.write(${JSON.stringify(markerPath)}, "executed")
export const meta = { name: "SideEffect", description: "writes a marker on import" }
export async function run(args, ctx) { return { ok: true } }
`
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

// N11-Fixture: Der Body startet einen Agenten OHNE ihn zu awaiten (fire-and-
// forget) — der hängende ctx.agent-Promise settelt nie vor Body-Ende — und
// returnt sofort. Die Pause gibt dem dispatchten Agent-Fiber Zeit, seine
// Child-Session zu erzeugen/registrieren und am hängenden Prompt zu blockieren,
// BEVOR der Body zurückkehrt und der Run als `completed` finished. So bleibt ein
// Agent-Node beim Terminal-Übergang noch `running` OHNE Autor-Fehlverhalten.
//
// Die Session-Erzeugung läuft als geforkter Fiber im run-Scope (asynchron, NACH
// dem synchronen Node-Push). Unter Last (volle Suite parallel) kann ein zu
// kurzes Fenster diesen Fiber verhungern lassen, bevor node.session_id gesetzt
// ist — dann fände finish() den Node zwar noch `running`, aber ohne Session zum
// Abbrechen, und die Session-Assertion des Tests flackerte. 400ms gibt dem Fork
// auch unter Contention zuverlässig Zeit; der hängende Prompt (30s-Race im Fake)
// stellt sicher, dass der Node beim Body-Ende dennoch `running` ist.
const DETACHED_AGENT_FIXTURE = "detached-agent"
const DETACHED_AGENT_WORKFLOW = `export const meta = { name: "${DETACHED_AGENT_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  // Bewusst NICHT awaiten: der Promise hängt am Prompt, der Body returnt davor.
  void ctx.agent({ prompt: "hang" }).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 400))
  return { ok: true }
}
`

// Fund 42-Fixtures: ein Workflow, der explizit `null` returnt, und einer, der
// gar nichts returnt (undefined). Beide müssen den DB-Roundtrip unterscheidbar
// überleben: null bleibt null, undefined bleibt undefined.
const NULL_RESULT_FIXTURE = "null-result"
const NULL_RESULT_WORKFLOW = `export const meta = { name: "${NULL_RESULT_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) { ctx.setPhase("run"); return null }
`
const VOID_RESULT_FIXTURE = "void-result"
const VOID_RESULT_WORKFLOW = `export const meta = { name: "${VOID_RESULT_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) { ctx.setPhase("run") }
`

// N2/N13-Fixture: ein Workflow, dessen Rückgabewert NICHT strukturell klonbar ist
// (eine Funktion ist weder JSON-serialisierbar noch structuredClone-fähig). Der
// frühere structuredClone-Snapshot warf hier (DOMException) und strandete jeden
// no-timeout-wait() / verhinderte den Terminal-Persist. Der Engine normalisiert
// das result jetzt über denselben JSON-Codec wie der Persist: Funktionen werden
// (wie bei JSON.stringify) still verworfen, der Run schließt sauber ab, und
// Live-Snapshot wie DB-Row tragen dieselbe (entfunktionalisierte) Form.
const UNSERIALIZABLE_RESULT_FIXTURE = "unserializable-result"
const UNSERIALIZABLE_RESULT_WORKFLOW = `export const meta = { name: "${UNSERIALIZABLE_RESULT_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) { ctx.setPhase("run"); return { kept: 1, cb: () => {} } }
`

// N2/N13-Fixture: ein Workflow, dessen Rückgabewert eine ZIRKULÄRE Referenz hat —
// JSON.stringify wirft darauf (TypeError). Der mit Effect.try abgesicherte
// Normalisierungspfad muss den Run dennoch terminal abschließen und das result
// auf den $unserializable-Platzhalter setzen, statt zu hängen.
const CIRCULAR_RESULT_FIXTURE = "circular-result"
const CIRCULAR_RESULT_WORKFLOW = `export const meta = { name: "${CIRCULAR_RESULT_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) { ctx.setPhase("run"); const r = { a: 1 }; r.self = r; return r }
`

function assistantReply(): SessionV1.WithParts {
  return { info: { role: "assistant" }, parts: [] } as unknown as SessionV1.WithParts
}

// Startup-Fenster-Fixture: schreibt eine Marker-Datei, SOBALD der Body läuft.
// Wird der Run im Startup-Fenster (vor dem Body-Fork) gecancelt, darf dieser
// Marker NIE erscheinen — der Body läuft dann nie.
const STARTUP_FIXTURE = "startup-window"
function startupWorkflow(markerPath: string) {
  return `export const meta = { name: "${STARTUP_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  await Bun.write(${JSON.stringify(markerPath)}, "body-ran")
  ctx.setPhase("run")
  await ctx.agent({ prompt: "hang" })
  return { ok: true }
}
`
}

// Parallel-Hang-Fixture: drei parallele Agent-Tasks, jede startet einen Agenten
// (eigene Child-Session). Ein vierter, SEQUENTIELLER Step nach dem Batch
// schreibt einen Marker, der bei korrektem Cancel nie laufen darf.
const PARALLEL_HANG_FIXTURE = "parallel-hang"
const PARALLEL_HANG_MARKER = "parallel-after-reached"
const PARALLEL_HANG_WORKFLOW = `export const meta = { name: "${PARALLEL_HANG_FIXTURE}", phases: ["fan-out", "after"] }
export async function run(args, ctx) {
  ctx.setPhase("fan-out")
  ctx.log("fan-out-started")
  await ctx.parallel([
    () => ctx.agent({ prompt: "task A" }),
    () => ctx.agent({ prompt: "task B" }),
    () => ctx.agent({ prompt: "task C" }),
  ])
  ctx.setPhase("after")
  ctx.log("${PARALLEL_HANG_MARKER}")
  return { ok: true }
}
`

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

// Resolve-on-abort-Prompt-Ops: bilden den ECHTEN Produktions-Runner nach.
// Wird eine laufende Agent-Session abgebrochen (cancel -> Abort), RESOLVED der
// Prompt mit dem letzten Assistant-Stand (eine WithParts, deren info.error ein
// abgebrochenes Ergebnis markiert) — er REJECTED NICHT. Genau dieses Verhalten
// (session/prompt.ts: Effect.onInterrupt -> lastAssistant) ist der Kern mehrerer
// Cancel-Bugs: die Erfolgsverzweigung der Settlement-Callbacks lief sonst und
// flippte cancelled->completed.
//
// `delayMs` verzögert die Beantwortung der initialen noReply-Nachricht, damit
// Tests im Startup-Fenster (vor dem Body-Fork) cancellen können.
function resolveOnAbortPromptOps(options?: { delayMs?: number }) {
  const aborted = new Set<string>()
  const started = new Set<string>()
  const gates = new Map<string, Deferred.Deferred<void>>()
  const abortedReply = (): SessionV1.WithParts =>
    ({ info: { role: "assistant", error: { name: "MessageAbortedError", data: {} } }, parts: [] }) as unknown as SessionV1.WithParts
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) {
          if (options?.delayMs) yield* Effect.sleep(options.delayMs)
          return assistantReply()
        }
        const gate = yield* Deferred.make<void>()
        gates.set(input.sessionID, gate)
        started.add(input.sessionID)
        // Race: entweder der lange Lauf endet, oder cancel() öffnet das Gate ->
        // der Prompt RESOLVED (nicht interrupt!) mit dem abort-Assistant-Stand,
        // wie der echte Runner. Der Timer hält die Suspension unterbrechbar, so
        // dass ein Scope-Close die Session-Fiber dennoch hart interrupten kann.
        return yield* Effect.race(
          Effect.sleep("30 seconds").pipe(Effect.map(() => assistantReply())),
          Deferred.await(gate).pipe(Effect.map(() => abortedReply())),
        )
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

// N13-Fixture (tokens-Alias): der Agent-Prompt RESOLVED sofort mit echter
// Token-Telemetrie (nicht-null, damit eine Mutation beobachtbar ist), so dass
// der Engine den Node mit `tokens`/`cache` befüllt. Danach hält der Body den Run
// LIVE (langer, unterbrechbarer Timer), so dass get() einen Live-Snapshot liefert
// (nicht den fromRow-Pfad nach der N1-Eviction). cancel() bricht den Timer ab.
function tokensPromptOps() {
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
            cost: 0,
            tokens: { input: 11, output: 22, reasoning: 0, cache: { read: 33, write: 44 } },
          },
          parts: [{ type: "text", text: "ok" }],
        } as unknown as SessionV1.WithParts
      }),
    cancel: () => Effect.void,
  }
  return ops
}

// Body: ein Agent-Step (setzt tokens) und danach ein langer Timer, der den Run
// LIVE in der Registry hält, bis der Test cancelt.
const AGENT_THEN_HANG_FIXTURE = "agent-then-hang"
const AGENT_THEN_HANG_WORKFLOW = `export const meta = { name: "${AGENT_THEN_HANG_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "produce tokens" })
  await new Promise((resolve) => setTimeout(resolve, 30000))
  return { ok: true }
}
`

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
// `cost` mirrors the real telemetry (`message.info.cost`, USD) so a step that
// FAILS structured-output can still report what it actually cost — exactly the
// failed-but-paid case the budget must charge for. Defaults to 0 to leave the
// existing structured-output callers unchanged.
function structuredPromptOps(mode: "structured" | "undefined" | "error", cost = 0) {
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        const info: Record<string, unknown> = {
          role: "assistant",
          providerID: "test",
          modelID: "test-model",
          cost,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        if (mode === "structured") info.structured = SCHEMA_OBJECT
        if (mode === "error")
          info.error = {
            name: "StructuredOutputError",
            data: { message: "Model did not produce structured output", retries: 0 },
          }
        const parts = mode === "undefined" || mode === "error" ? [{ type: "text", text: "here is some plaintext" }] : []
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

// Failed-but-paid-Fixture: ein Agent MIT Schema, der scheitert (kein
// strukturiertes Ergebnis), aber laut Telemetrie echte Kosten verursacht hat.
// Der Workflow fängt den Fehler ab und gibt das Restbudget zurück, damit der
// Test beweisen kann, dass das Budget TROTZ des Fehlers belastet wurde.
const BUDGET_FAILED_PAID_FIXTURE = "budget-failed-paid"
const BUDGET_FAILED_PAID_WORKFLOW = `export const meta = { name: "${BUDGET_FAILED_PAID_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  let failed = false
  try {
    await ctx.agent({ prompt: "produce structured", schema: { type: "object" } })
  } catch (e) {
    failed = true
  }
  return { failed, remaining: ctx.budgetRemaining }
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

  it.instance("list() statically extracts meta and never executes module top-level code; start() does", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const marker = path.join(os.tmpdir(), `workflow-side-effect-${Math.random().toString(16).slice(2)}`)
      yield* Effect.promise(() => writeWorkflow(test.directory, SIDE_EFFECT_FIXTURE, sideEffectWorkflow(marker)))
      const workflow = yield* Workflow.Service

      const list = yield* workflow.list()
      const info = list.find((item) => item.name === SIDE_EFFECT_FIXTURE)
      // Meta was extracted statically (valid + literal values present)...
      expect(info?.valid).toBe(true)
      expect(info?.meta.name).toBe("SideEffect")
      expect(info?.meta.description).toBe("writes a marker on import")
      // ...but the module's top-level code was NEVER executed: no marker file.
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)

      // start() really imports the target module, so now the marker appears.
      const run = yield* workflow.start({ name: SIDE_EFFECT_FIXTURE, args: {} })
      const waited = yield* workflow.wait({ id: run.id })
      expect(waited.run?.status).toBe("completed")
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(true)
    }),
  )

  it.instance("non-statically-analyzable meta is reported invalid without running the file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const marker = path.join(os.tmpdir(), `workflow-dynamic-meta-${Math.random().toString(16).slice(2)}`)
      // Dynamic meta value (process.env) plus a top-level side effect: the file
      // must be reported invalid AND never executed during list().
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "dynamic-meta",
          `await Bun.write(${JSON.stringify(marker)}, "executed")
export const meta = { name: process.env.SECRET }
export async function run(args, ctx) { return { ok: true } }
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      const info = list.find((item) => item.name === "dynamic-meta")
      expect(info?.valid).toBe(false)
      expect(info?.error).toContain("statically analyzable")
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
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
        failed instanceof Workflow.InvalidError ? failed : yield* Effect.fail(new Error("expected InvalidError"))
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

  // Race-regression: cancel() must never report a run as "not found" (undefined →
  // HTTP 404) when it LOSES the race against the run's own natural completion. In
  // the live engine the body fiber's finish("completed") persists the terminal row
  // AND N1-evicts the run from the registry between cancel's registry read and its
  // own finish("cancelled") — leaving that finish to return undefined for a run
  // that exists and is terminal. cancel must then fall back to the persisted
  // snapshot showing the TRUE terminal status (completed), NOT undefined and NOT
  // rewritten to cancelled.
  //
  // Deterministic coverage of the FIX SEMANTICS (the observable contract), not of
  // the exact lost-race code line: complete the run first (await its terminal state
  // via wait, which resolves at finish's Deferred — committed terminal row, but the
  // subsequent N1-evict may or may not have run yet), THEN cancel. The cancel then
  // takes one of the two non-undefined branches — `snapshot(active)` if still
  // registered, or the persisted-DB fallback once evicted — both returning the TRUE
  // terminal status. The pre-fix code returned undefined on the evicted branch.
  // The precise finish-undefined window (cancel's OWN finish returning undefined
  // mid-eviction, the named `finished ?? persisted()` line) is exercised end-to-end
  // by script/httpapi-exercise.ts (workflow.start), whose fixture completes
  // synchronously fast; this unit test pins the contract those branches must honor.
  it.instance("cancel of an already-completed (evicted) run returns the completed snapshot, never undefined", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "instant",
          `export const meta = { name: "Instant" }
export async function run(args, ctx) { ctx.setPhase("run"); return { value: args.value } }
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: "instant", args: { value: 7 } })
      // Drive to terminal: wait resolves only after finish() committed the terminal
      // row, and finish() then evicts the run from the live registry (N1).
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("workflow did not finish")))
      expect(done.status).toBe("completed")
      // Cancel after completion: the run is terminal and (being) evicted, so cancel
      // either snapshots the still-registered terminal run or, once evicted, takes
      // the new finish-undefined fallback to the persisted row. Both must return a
      // non-undefined run whose status is the TRUE terminal status, never cancelled.
      const cancelled = yield* workflow.cancel(run.id)
      expect(cancelled).toBeDefined()
      expect(cancelled?.status).toBe("completed")
      expect(cancelled?.result).toEqual({ value: 7 })
      // Reserved meaning preserved: a genuinely unknown id still reports undefined.
      expect(yield* workflow.cancel(Workflow.RunID.make("job_unknown_id"))).toBeUndefined()
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

  // Fund 4 (HIGH): Mit dem REALEN resolve-on-abort-Runner RESOLVED der Agent-
  // Prompt bei Abort (statt zu rejecten). Die Settlement-Erfolgsverzweigung darf
  // den abort-resolved Step NICHT auf `completed` flippen, keinen Write nach dem
  // Terminal-Write absetzen und das Budget nicht fälschlich belasten.
  it.instance("cancel with a resolve-on-abort runner never flips the agent node to completed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SLOW_FIXTURE, SLOW_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, aborted, started } = resolveOnAbortPromptOps()

      const run = yield* workflow.start({ name: SLOW_FIXTURE, args: {}, prompt: ops, budget: 5 })

      const live = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current && current.agents.some((a) => a.status === "running" && a.session_id) ? current : undefined
        }),
        "agent never started",
      )
      const childSession = live.agents[0]?.session_id
      expect(childSession).toBeDefined()

      yield* workflow.cancel(run.id)

      const after = yield* workflow.get(run.id)
      const done = after ?? (yield* Effect.fail(new Error("run vanished")))
      expect(done.status).toBe("cancelled")
      // Der abort-resolved Agent darf NICHT als completed verbucht sein.
      expect(done.agents.every((a) => a.status !== "completed")).toBe(true)
      expect(done.agents.every((a) => a.status !== "running")).toBe(true)
      // Folge-Step lief nie.
      expect(done.logs.some((l) => l.message?.includes(STEP2_MARKER))).toBe(false)
      expect(started.has(childSession!)).toBe(true)
      expect(aborted.has(childSession!)).toBe(true)

      // KEIN Write nach dem Terminal-Write: ein kalter DB-Read (umgeht den
      // In-Memory-Snapshot) muss cancelled zeigen, nicht completed.
      const row = yield* fetchRunRow(run.id)
      expect(row.status).toBe("cancelled")
      expect(row.agents.every((a) => a.status !== "completed")).toBe(true)
    }),
  )

  // N11 (HIGH): Ein Run, der als `completed` endet, während ein Agent-Node noch
  // `running` ist (fire-and-forget ctx.agent, dessen Settlement nach Body-Ende
  // käme). finish('completed') MUSS den noch laufenden Node terminal schließen
  // (failed mit erklärendem error + completed_at) UND die offene Child-Session
  // wirklich abbrechen, sonst verbrennt die detached Session weiter Tokens.
  it.instance("completed run closes a still-running detached agent node and aborts its session", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, DETACHED_AGENT_FIXTURE, DETACHED_AGENT_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      const { ops, aborted, started } = hangingPromptOps()

      const run = yield* workflow.start({ name: DETACHED_AGENT_FIXTURE, args: {}, prompt: ops })

      // Auf den terminalen `completed`-Zustand warten (der Body returnt, während
      // der detached Agent noch am Prompt hängt).
      const done = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current?.status === "completed" ? current : undefined
        }),
        "workflow never completed",
      )
      expect(done.status).toBe("completed")
      // Der noch laufende Node ist terminal geschlossen (failed + Grund + Zeit).
      expect(done.agents.length).toBeGreaterThan(0)
      expect(done.agents.every((a) => a.status !== "running")).toBe(true)
      const closed = done.agents.find((a) => a.status === "failed")
      expect(closed).toBeDefined()
      expect(closed!.completed_at).toBeGreaterThan(0)
      expect(closed!.error).toBeTruthy()

      // Kalt-Read beweist die Terminalisierung über den DB-Roundtrip.
      const row = yield* fetchRunRow(run.id)
      expect(row.status).toBe("completed")
      expect(row.agents.every((a) => a.status !== "running")).toBe(true)

      // Kern: die hängende Child-Session wurde wirklich abgebrochen.
      const childSession = done.agents[0]?.session_id
      expect(childSession).toBeDefined()
      expect(started.has(childSession!)).toBe(true)
      expect(aborted.has(childSession!)).toBe(true)
    }),
  )

  // Fund 5 (HIGH): Cancel im Startup-Fenster — start() registriert den Run,
  // beantwortet aber die Initial-Phase verzögert; ein Cancel landet, BEVOR der
  // Body geforkt wird. Der Body darf NIE laufen (kein Marker) und der Run muss
  // als cancelled enden (nicht voll durchlaufen).
  it.instance("cancel during the startup window prevents the body from ever running", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const marker = path.join(os.tmpdir(), `workflow-startup-${Math.random().toString(16).slice(2)}`)
      yield* Effect.promise(() => writeWorkflow(test.directory, STARTUP_FIXTURE, startupWorkflow(marker)))
      const workflow = yield* Workflow.Service
      // Die Initial-noReply-Antwort wird ~150ms verzögert: start() hängt im
      // Initial-Prompt, der Run ist aber bereits registriert (status running).
      const { ops } = resolveOnAbortPromptOps({ delayMs: 150 })

      // start() forken, damit wir parallel im Startup-Fenster cancellen können.
      const startFiber = yield* Effect.forkScoped(workflow.start({ name: STARTUP_FIXTURE, args: {}, prompt: ops }))

      // Warten bis der Run registriert ist (running, noch kein Body).
      const id = yield* pollWithTimeout(
        Effect.gen(function* () {
          const all = yield* workflow.runs()
          const found = all.find((r) => r.workflow === STARTUP_FIXTURE)
          return found?.id
        }),
        "run never registered",
      )

      // Cancel im Fenster vor dem Body-Fork.
      yield* workflow.cancel(id)
      yield* Fiber.await(startFiber).pipe(Effect.ignore)
      // Settle-Zeit: falls der Body fälschlich geforkt würde, hätte er hier
      // längst Zeit gehabt, den Marker zu schreiben (Bug-Modell läuft voll durch).
      yield* Effect.sleep("300 millis")

      const done = yield* workflow.get(id)
      expect(done?.status).toBe("cancelled")
      // Der Body lief NIE: kein Marker.
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
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

  // Fund 3 (HIGH): Mit dem resolve-on-abort-Runner laufen die detached Agent-
  // Fibers über bridge.promise NACH dem db.delete weiter und re-INSERTen die
  // gelöschte Row (Zombie). Nach Settlement muss die Row GELÖSCHT bleiben.
  it.instance("remove keeps the row deleted even when the agent settles after delete", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SLOW_FIXTURE, SLOW_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops } = resolveOnAbortPromptOps()

      const run = yield* workflow.start({ name: SLOW_FIXTURE, args: {}, prompt: ops })

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current && current.agents.some((a) => a.status === "running" && a.session_id) ? current : undefined
        }),
        "agent never started",
      )

      yield* workflow.remove(run.id)

      // Ein paar Ticks für ggf. nachlaufende detached Settlement-Fibers.
      yield* Effect.sleep("200 millis")

      // Kalt-Read: kein Re-INSERT, die Row bleibt weg.
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(WorkflowRunTable)
        .where(eq(WorkflowRunTable.id, run.id))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeUndefined()
      expect(yield* workflow.get(run.id)).toBeUndefined()
    }),
  )

  // Fund 24/16 (parallel): ein parallel-Batch mit drei hängenden Agenten +
  // Cancel mitten drin. ALLE registrierten Child-Sessions müssen abgebrochen
  // werden; der sequentielle Folge-Step darf nie laufen; Status cancelled.
  it.instance("cancel during a parallel batch aborts every started child session", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PARALLEL_HANG_FIXTURE, PARALLEL_HANG_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, aborted, started } = resolveOnAbortPromptOps()

      const run = yield* workflow.start({ name: PARALLEL_HANG_FIXTURE, args: {}, prompt: ops })

      // Warten bis alle drei parallelen Agenten ihre Child-Session registriert haben.
      const live = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          const running = current?.agents.filter((a) => a.status === "running" && a.session_id) ?? []
          return running.length >= 3 ? current : undefined
        }),
        "parallel agents never all started",
      )
      const sessions = live!.agents.map((a) => a.session_id!).filter(Boolean)
      expect(sessions.length).toBeGreaterThanOrEqual(3)

      yield* workflow.cancel(run.id)

      const done = yield* workflow.get(run.id)
      expect(done?.status).toBe("cancelled")
      // Jede gestartete Child-Session wurde echt abgebrochen.
      for (const s of started) expect(aborted.has(s)).toBe(true)
      // Der Folge-Step lief nie.
      expect(done?.logs.some((l) => l.message?.includes(PARALLEL_HANG_MARKER))).toBe(false)
      // Kein Agent bleibt running, keiner wird als completed verbucht.
      expect(done?.agents.every((a) => a.status !== "running")).toBe(true)
      expect(done?.agents.every((a) => a.status !== "completed")).toBe(true)
    }),
  )

  // Fund 50 (low): PromptOps OHNE cancel-Vektor. cancel() muss den Run trotzdem
  // als cancelled markieren und den Folge-Step gaten. Dokumentierter Gap: die
  // in-flight Child-Session wird NICHT abgebrochen (sie läuft aus) — nur die
  // Run-Fiber/der Run-Scope wird beendet.
  it.instance("cancel without a PromptOps.cancel vector still ends the run as cancelled", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SLOW_FIXTURE, SLOW_WORKFLOW))
      const workflow = yield* Workflow.Service
      // PromptOps OHNE cancel: der Agent-Prompt hängt (resolved nie von selbst).
      const ops: { prompt: SessionPrompt.Interface["prompt"] } = {
        prompt: (input) =>
          Effect.gen(function* () {
            if (input.noReply) return assistantReply()
            // Hängt unterbrechbar; nur ein Scope-Close (Run-Scope) kann sie beenden.
            yield* Effect.never
            return assistantReply()
          }),
      }

      const run = yield* workflow.start({ name: SLOW_FIXTURE, args: {}, prompt: ops })

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current && current.agents.some((a) => a.status === "running") ? current : undefined
        }),
        "agent never started",
      )

      yield* workflow.cancel(run.id)

      const done = yield* workflow.get(run.id)
      expect(done?.status).toBe("cancelled")
      // Folge-Step lief nie.
      expect(done?.logs.some((l) => l.message?.includes(STEP2_MARKER))).toBe(false)
    }),
  )

  // Orphan-Mechanismus: Die In-Memory-Test-DB (OPENCODE_DB=:memory:) überlebt
  // keine frische Layer-Instanz, daher wird der Orphan simuliert, indem wir eine
  // running-Zeile OHNE Registry-Eintrag direkt über die SQL-Schicht einfügen und
  // anschließend NUR den Sweep auslösen (engine.sweep()), so wie er beim
  // Service-Start läuft (leere Registry -> alle running-Zeilen werden gefegt).
  it.instance("orphaned running rows are marked interrupted on service start", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const workflow = yield* Workflow.Service
      const orphanId = "job_orphan_sweep"
      yield* seedRunningRow(orphanId, test.directory)

      yield* workflow.sweep()

      const row = yield* fetchRunRow(orphanId)
      expect(row.status).toBe("interrupted")
      expect(row.completed_at).toBeGreaterThan(0)
    }),
  )

  // Fund 15 (medium): Der Sweep schrieb bisher nur Run-Level-Spalten um, nie das
  // agents-JSON. Ein gesweepter Orphan trug daher permanent einen Agent mit
  // status `running` ohne completed_at/error → das TUI rendert ewig ein Live-
  // Icon. Nach dem Sweep MUSS auch jeder noch laufende Agent-Node terminal sein.
  it.instance("orphan sweep normalizes still-running agent nodes to failed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const workflow = yield* Workflow.Service
      const orphanId = "job_orphan_agent"
      yield* seedRunningRowWithAgent(orphanId, test.directory)

      yield* workflow.sweep()

      const row = yield* fetchRunRow(orphanId)
      expect(row.status).toBe("interrupted")
      // Der laufende Node ist terminal geschlossen (failed + Grund + Zeit).
      const closed = row.agents.find((a) => a.id === "1")
      expect(closed?.status).toBe("failed")
      expect(closed?.completed_at).toBeGreaterThan(0)
      expect(closed?.error).toBeTruthy()
      // Ein bereits abgeschlossener Node bleibt unberührt.
      const intact = row.agents.find((a) => a.id === "2")
      expect(intact?.status).toBe("completed")
      // Kein Node bleibt `running`.
      expect(row.agents.every((a) => a.status !== "running")).toBe(true)
    }),
  )

  it.instance("persisted run round-trips through fromRow", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const workflow = yield* Workflow.Service
      const persistedId = Workflow.RunID.make("job_roundtrip")
      // Persist a finished run directly via the SQL layer (no live registry
      // entry), so get() must read it back through DB->fromRow.
      yield* seedCompletedRow(persistedId, test.directory)

      const viaDb = yield* workflow.get(persistedId)
      const persisted = viaDb ?? (yield* Effect.fail(new Error("run not persisted")))
      expect(persisted).toMatchObject({ id: persistedId, status: "completed" })
      // Telemetrie überlebt den Roundtrip durch fromRow.
      expect(persisted.logs.map((item) => item.message)).toContain("running")
      expect(persisted.agents.length).toBeGreaterThan(0)
      expect(persisted.agents[0]?.output).toBe("did the thing")
      // N20: das geseedete result überlebt den Roundtrip (wurde bisher nie asserted).
      expect(persisted.result).toEqual({ ok: true })
    }),
  )

  // N1 (medium): Ein terminaler Run muss nach finish() aus der In-Memory-Registry
  // evictet sein, sonst wächst die Map unbeschränkt UND get()/runs() pinnen für
  // immer den In-Memory-Snapshot eines toten Runs statt der DB-Row (gepinnte
  // Divergenz). Seam (ohne neuen Produktions-Export): nach Abschluss die DB-Row
  // direkt über die SQL-Schicht mutieren und get() lesen. Hielte die Registry den
  // Run noch, läse get() den (stale) In-Memory-Snapshot und ignorierte die
  // Mutation; nach Eviction fällt get() auf fromRow → die Mutation ist sichtbar.
  it.instance("a finished run is evicted from the in-memory registry (get falls back to the DB row)", () =>
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
      const waited = yield* workflow.wait({ id: run.id })
      expect(waited.run?.status).toBe("completed")
      expect(waited.run?.result).toEqual({ value: 42 })

      // Direkt die DB-Row mutieren (umgeht die Engine vollständig) UND innerhalb
      // der Poll-Schleife re-applizieren: eine zuletzt noch geforkte Progress-
      // Schreibung (aus ctx.setPhase/log) kann unmittelbar nach wait() einmalig
      // current_phase auf "run" zurückschreiben — das Re-Apply macht den Test
      // robust gegen dieses kurze Fenster. Hielte die Registry den Run dagegen
      // noch, läse get() den gepinnten In-Memory-Snapshot (current_phase === "run")
      // und die DB-Mutation bliebe — egal wie oft geschrieben — für immer
      // unsichtbar. Nach Eviction (Designreihenfolge 3e/N2: NACH dem Deferred-
      // Resolve) fällt get() auf die DB-Row zurück → die Mutation wird sichtbar.
      const { db } = yield* Database.Service
      const after = yield* pollWithTimeout(
        Effect.gen(function* () {
          yield* db
            .update(WorkflowRunTable)
            .set({ current_phase: "db-mutated" })
            .where(eq(WorkflowRunTable.id, run.id))
            .run()
            .pipe(Effect.orDie)
          const current = yield* workflow.get(run.id)
          return current?.current_phase === "db-mutated" ? current : undefined
        }),
        "finished run was never evicted from the registry (get stayed pinned to the in-memory snapshot)",
      )
      expect(after.current_phase).toBe("db-mutated")
      // Der Terminalstand bleibt sonst korrekt (kein Stale-Verlust).
      expect(after.status).toBe("completed")
      expect(after.result).toEqual({ value: 42 })
      expect(after.logs.map((l) => l.message)).toContain("running")
    }),
  )

  // N1 (medium) — Reihenfolge-Sicherung gegen 3e/N2: ein wait()-Warter, der GENAU
  // um den finish()-Übergang aufwacht, muss noch den Terminalzustand erhalten —
  // die Eviction darf den Waiter nicht entwerten (der Run kommt aus dem resolved
  // done-Deferred; ein get() danach liest die DB-Row, die der Terminal-Persist
  // VOR der Eviction geschrieben hat).
  it.instance("a waiter receives the terminal state across eviction; the DB row is present afterwards", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "hello",
          `export const meta = { name: "Hello" }
export async function run(args, ctx) { ctx.setPhase("run"); return { value: args.value } }
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: "hello", args: { value: 7 } })
      // wait() ohne Timeout hängt am done-Deferred und wacht beim Terminal-Übergang
      // auf — nach Persist + Deferred.succeed, danach folgt die Eviction.
      const waited = yield* workflow.wait({ id: run.id })
      expect(waited.run?.status).toBe("completed")
      expect(waited.run?.result).toEqual({ value: 7 })
      // Der Terminal-Persist lief VOR der Eviction: die DB-Row existiert (kein
      // Read-after-Evict-Loch).
      const row = yield* fetchRunRow(run.id)
      expect(row.status).toBe("completed")
      // Und get() nach Abschluss liefert exakt den persistierten Stand.
      const got = yield* workflow.get(run.id)
      expect(got?.status).toBe("completed")
      expect(got?.result).toEqual({ value: 7 })
    }),
  )

  // N16 (medium): cancel() auf einen persistierten, NICHT-live Run (geseedet, kein
  // Registry-Eintrag — der Zustand nach Neustart/Eviction) darf NICHT undefined
  // liefern. Konsistent mit get()/remove() konsultiert cancel() die (gescopte)
  // DB-Row: gefunden → ehrlich den Run-Snapshot zurückgeben (ein bereits
  // terminaler Run wird nicht „gecancelt", aber zurückgegeben). undefined NUR bei
  // echtem not-found.
  it.instance("cancel falls back to the persisted row for a non-live run; undefined only for unknown ids", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const workflow = yield* Workflow.Service
      const persistedId = Workflow.RunID.make("job_cancel_nonlive")
      // Fertiger Run direkt geseedet → kein Registry-Eintrag (nicht live).
      yield* seedCompletedRow(persistedId, test.directory)

      // cancel() findet ihn über die DB und liefert den Snapshot, nicht undefined.
      const cancelled = yield* workflow.cancel(persistedId)
      expect(cancelled).toBeDefined()
      expect(cancelled?.id).toBe(persistedId)
      // Ein bereits terminaler Run wird nicht in cancelled umgeschrieben.
      expect(cancelled?.status).toBe("completed")

      // Eine völlig unbekannte id liefert undefined (→ HTTP 404 in 3h).
      const unknown = yield* workflow.cancel(Workflow.RunID.make("job_cancel_unknown"))
      expect(unknown).toBeUndefined()
    }),
  )

  // N16 — Cross-Directory: cancel() ist auf das aufrufende Verzeichnis gescoped
  // (wie get()/remove()). Eine fremde Row darf NICHT als gefunden gelten.
  it.instance(
    "cancel from another directory cannot see a foreign run",
    () =>
      Effect.gen(function* () {
        const a = yield* TestInstance
        const b = yield* tmpdirScoped({ git: true })
        const workflow = yield* Workflow.Service
        const idA = Workflow.RunID.make("job_cancel_scoped_A")
        yield* seedCompletedRow(idA, a.directory)

        // B sieht ihn nicht → undefined (nicht „found-but-not-cancellable").
        expect(yield* workflow.cancel(idA).pipe(provideInstance(b))).toBeUndefined()
        // A findet ihn weiterhin.
        expect((yield* workflow.cancel(idA))?.id).toBe(idA)
      }),
    { git: true },
  )

  // N13 (low): snapshot()/die öffentliche Run-Ausgabe darf KEINE internen
  // Zusatzfelder (directory/done/runScope/fiber/budget …) tragen und KEINE
  // Live-Referenzen aliasen — Mutieren des zurückgegebenen Objekts (inkl. der
  // verschachtelten args/definition/result) darf den internen Zustand nicht
  // verändern (defensive Projektion).
  it.instance("public run output is a defensive projection with no internal fields or live aliases", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "hello",
          `export const meta = { name: "Hello" }
export async function run(args, ctx) { ctx.setPhase("run"); ctx.log("running"); return { nested: { ok: true } } }
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: "hello", args: { nested: { value: 1 } } })

      // Live-Snapshot (Run ist noch in der Registry): keine internen Felder.
      const live = yield* workflow.get(run.id)
      const liveAny = live as unknown as Record<string, unknown>
      for (const internal of ["directory", "done", "runScope", "fiber", "sessions", "cancelSession", "cancelling", "removed", "budget", "budgetRemaining"]) {
        expect(internal in liveAny).toBe(false)
      }
      // Exakt die deklarierten Run-Schlüssel (Teilmenge: optionale können fehlen).
      const allowed = new Set([
        "id", "session_id", "workflow", "args", "definition", "status",
        "started_at", "completed_at", "current_phase", "logs", "agents", "result", "error",
      ])
      for (const key of Object.keys(liveAny)) expect(allowed.has(key)).toBe(true)

      // Defensive Projektion: das verschachtelte args mutieren darf den internen
      // Zustand NICHT beeinflussen.
      ;(live!.args as { nested: { value: number } }).nested.value = 999
      const again = yield* workflow.get(run.id)
      expect((again!.args as { nested: { value: number } }).nested.value).toBe(1)

      // Nach Abschluss kommt der Run NICHT mehr aus dem Live-Snapshot: finish()
      // evictet den terminalen Run aus der Registry (N1), so dass jeder folgende
      // get() ihn frisch aus der DB-Row über fromRow rekonstruiert. Eine Mutation
      // an `done.result` und ein erneuter get() würden hier also nur die (ohnehin
      // garantierte) fromRow-Frische prüfen — NICHT die Alias-Trennung des
      // Live-Snapshots. Die result-Alias-Trennung am LIVEN Run ist daher in
      // "snapshot severs agents[].tokens aliasing on a live run" abgedeckt; hier
      // verifizieren wir nur ehrlich, dass das result den DB-Roundtrip überlebt.
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("workflow did not finish")))
      expect((done.result as { nested: { ok: boolean } }).nested.ok).toBe(true)
    }),
  )

  // N13 (spec): die öffentliche Run-Projektion darf das verschachtelte
  // `agents[].tokens` (inkl. des weiter genesteten `cache`) NICHT aliasen. Der
  // frühere snapshot kopierte agents nur flach (`{ ...item }`), so dass ein
  // Verbraucher über `snapshot.agents[0].tokens.input` den internen Engine-State
  // mutieren konnte. Geprüft am LIVEN Run (Run noch in der Registry, Agent-Node
  // mit echter Token-Telemetrie), damit get() einen Live-Snapshot liefert und
  // NICHT den ohnehin frischen fromRow-Pfad.
  it.instance("snapshot severs agents[].tokens aliasing on a live run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, AGENT_THEN_HANG_FIXTURE, AGENT_THEN_HANG_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: AGENT_THEN_HANG_FIXTURE, args: {}, prompt: tokensPromptOps() })

      // Warten, bis der Agent-Step gesettlet ist (tokens befüllt) und der Run
      // dabei NOCH läuft (Body hängt am 30s-Timer) — get() liefert dann live.
      const live = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current?.status === "running" && current.agents[0]?.tokens ? current : undefined
        }),
        "agent tokens never populated on a live run",
      )
      const tokens = live.agents[0]!.tokens!
      expect(tokens.input).toBe(11)
      expect(tokens.cache.read).toBe(33)

      // Über den Snapshot in den verschachtelten tokens/cache schreiben …
      tokens.input = 999
      tokens.cache.read = 888

      // … darf den internen Engine-State NICHT verändern: ein zweiter Live-Snapshot
      // zeigt die Originalwerte.
      const again = yield* workflow.get(run.id)
      expect(again?.status).toBe("running")
      expect(again!.agents[0]!.tokens!.input).toBe(11)
      expect(again!.agents[0]!.tokens!.cache.read).toBe(33)

      // Aufräumen: den hängenden Run abbrechen, damit der 30s-Timer den Test nicht hält.
      yield* workflow.cancel(run.id)
    }),
  )

  // N2/N13 (regression): ein Workflow, der einen NICHT strukturell klonbaren Wert
  // zurückgibt (`{ kept: 1, cb: () => {} }`), darf weder den no-timeout-wait()
  // strandlassen noch den Terminal-Persist verhindern. Der frühere
  // structuredClone-Snapshot warf darauf (DOMException) und hing. Der Engine
  // normalisiert das result jetzt über denselben JSON-Codec wie der Persist:
  // Funktionen werden (wie JSON.stringify) still verworfen, der Run schließt
  // sauber als `completed` ab, und Live-Snapshot wie DB-Row tragen dieselbe Form.
  it.instance("a non-cloneable workflow result never hangs wait(); JSON-normalized like the persist", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, UNSERIALIZABLE_RESULT_FIXTURE, UNSERIALIZABLE_RESULT_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: UNSERIALIZABLE_RESULT_FIXTURE, args: {} })

      // wait() OHNE timeout: kommt terminal zurück (kein Hang) und meldet keinen Timeout.
      const waited = yield* workflow.wait({ id: run.id })
      expect(waited.timedOut).toBe(false)
      const done = waited.run ?? (yield* Effect.fail(new Error("workflow did not finish")))
      expect(done.status).toBe("completed")
      // Funktionen werden (wie bei JSON.stringify) verworfen, serialisierbare
      // Felder bleiben erhalten.
      expect(done.result).toEqual({ kept: 1 })

      // DB-Row und Live-Verhalten konsistent: ein kalter Spalten-Read zeigt
      // dieselbe entfunktionalisierte Form.
      expect(yield* fetchRawResult(run.id)).toBe(JSON.stringify({ kept: 1 }))
      const persisted = yield* workflow.get(run.id)
      expect(persisted?.status).toBe("completed")
      expect(persisted?.result).toEqual({ kept: 1 })
    }),
  )

  // N2/N13 (regression): ein result mit ZIRKULÄRER Referenz lässt JSON.stringify
  // selbst werfen (TypeError). Der mit Effect.try abgesicherte
  // Normalisierungspfad muss den Run dennoch terminal als `completed` abschließen
  // (kein Hang, kein verlorener Terminal-Übergang) und das result auf den
  // $unserializable-Platzhalter setzen.
  it.instance("a circular workflow result finishes with the $unserializable placeholder", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, CIRCULAR_RESULT_FIXTURE, CIRCULAR_RESULT_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: CIRCULAR_RESULT_FIXTURE, args: {} })

      const waited = yield* workflow.wait({ id: run.id })
      expect(waited.timedOut).toBe(false)
      const done = waited.run ?? (yield* Effect.fail(new Error("workflow did not finish")))
      expect(done.status).toBe("completed")
      expect((done.result as { $unserializable: string }).$unserializable).toBeDefined()

      // Konsistent in der DB-Row.
      const persisted = yield* workflow.get(run.id)
      expect((persisted?.result as { $unserializable: string }).$unserializable).toBeDefined()
    }),
  )

  // Fund 42 / N20 (low): result === null darf im DB-Roundtrip NICHT zu undefined
  // ("No result recorded.") werden. Drei Fälle, end-to-end durch den echten
  // Engine-Persist getrieben: ein echtes result, result === null und nie gesetzt.
  // Geprüft wird BEIDE Richtungen: die rohe Spalten-Serialisierung (write) und
  // die Decodierung durch fromRow (read), inkl. der Unterscheidung SQL-NULL
  // (nie gesetzt → undefined) vs. JSON-Text "null" (echtes null → null).
  it.instance("null and undefined workflow results survive persistence distinctly", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, HELLO_FIXTURE, `export const meta = { name: "Hello" }
export async function run(args, ctx) { ctx.setPhase("run"); return { value: args.value } }
`))
      yield* Effect.promise(() => writeWorkflow(test.directory, NULL_RESULT_FIXTURE, NULL_RESULT_WORKFLOW))
      yield* Effect.promise(() => writeWorkflow(test.directory, VOID_RESULT_FIXTURE, VOID_RESULT_WORKFLOW))
      const workflow = yield* Workflow.Service

      const finishRun = (name: string, args?: Record<string, unknown>) =>
        Effect.gen(function* () {
          const run = yield* workflow.start({ name, args: args ?? {} })
          const waited = yield* workflow.wait({ id: run.id })
          const done = waited.run ?? (yield* Effect.fail(new Error(`${name} did not finish`)))
          expect(done.status).toBe("completed")
          return run.id
        })

      // (a) echtes result.
      const realId = yield* finishRun(HELLO_FIXTURE, { value: 42 })
      expect((yield* workflow.get(realId))?.result).toEqual({ value: 42 })
      expect(yield* fetchRawResult(realId)).toBe(JSON.stringify({ value: 42 }))

      // (b) result === null: roh als JSON-Text "null" persistiert, NICHT SQL-NULL.
      const nullId = yield* finishRun(NULL_RESULT_FIXTURE)
      expect((yield* workflow.get(nullId))?.result).toBeNull()
      expect(yield* fetchRawResult(nullId)).toBe("null")

      // (c) nie gesetzt: roh SQL-NULL, liest als undefined zurück.
      const voidId = yield* finishRun(VOID_RESULT_FIXTURE)
      expect((yield* workflow.get(voidId))?.result).toBeUndefined()
      expect(yield* fetchRawResult(voidId)).toBeNull()

      // Kalt-Read durch fromRow (frische Rows, kein Registry-Eintrag): die drei
      // rohen Spalten-Zustände dekodieren exakt zu value / null / undefined.
      const { db } = yield* Database.Service
      const now = Date.now()
      // Raw INSERT so the `result` column holds the EXACT bytes under test (the
      // text `"null"` vs SQL NULL) — a Drizzle insert would route through the
      // engine's codec and hide the distinction. time_created/time_updated are
      // NOT NULL with no SQL-level default (the default lives in the Drizzle
      // Timestamps helper, which a raw INSERT bypasses), so they must be set here.
      const seedRaw = (id: string, raw: string | null) =>
        db.run(
          sql`INSERT INTO ${WorkflowRunTable} (id, workflow, directory, status, started_at, completed_at, logs, agents, result, time_created, time_updated)
              VALUES (${id}, ${HELLO_FIXTURE}, ${test.directory}, 'completed', ${now}, ${now}, '[]', '[]', ${raw}, ${now}, ${now})`,
        ).pipe(Effect.orDie)
      yield* seedRaw("job_result_real", JSON.stringify({ value: 7 }))
      yield* seedRaw("job_result_null", "null")
      yield* seedRaw("job_result_void", null)
      expect((yield* workflow.get(Workflow.RunID.make("job_result_real")))?.result).toEqual({ value: 7 })
      expect((yield* workflow.get(Workflow.RunID.make("job_result_null")))?.result).toBeNull()
      expect((yield* workflow.get(Workflow.RunID.make("job_result_void")))?.result).toBeUndefined()
    }),
  )

  it.instance("wait on interrupted run resolves immediately as interrupted (not timedOut)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const workflow = yield* Workflow.Service
      const orphanId = Workflow.RunID.make("job_orphan_wait")
      yield* seedRunningRow(orphanId, test.directory)
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
      // Das Gate verhindert, dass der zweite Step überhaupt STARTET: nur der
      // erste Agent läuft (und wird completed); für den geblockten zweiten Step
      // wird kein Node angelegt — die Engine weigert sich, weiter zu spenden.
      expect(done.run?.agents.filter((a) => a.status === "completed").length).toBe(1)
      expect(done.run?.agents.length).toBe(1)
    }),
  )

  it.instance("budgetRemaining reflects real spend during the run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, BUDGET_REMAINING_FIXTURE, BUDGET_REMAINING_WORKFLOW))
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
      yield* Effect.promise(() => writeWorkflow(test.directory, BUDGET_UNLIMITED_FIXTURE, BUDGET_UNLIMITED_WORKFLOW))
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

  it.instance("a failed-but-paid step still charges the budget by its actual cost", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, BUDGET_FAILED_PAID_FIXTURE, BUDGET_FAILED_PAID_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      // Schema-Agent scheitert (kein strukturiertes Ergebnis), hat aber 0.3 USD
      // gekostet. Der Workflow fängt den Fehler ab und läuft weiter.
      const run = yield* workflow.start({
        name: BUDGET_FAILED_PAID_FIXTURE,
        args: {},
        prompt: structuredPromptOps("error", 0.3),
        budget: 1,
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      const result = done.run?.result as { failed: boolean; remaining: number }
      // Der Step ist wirklich gescheitert ...
      expect(result.failed).toBe(true)
      // ... wurde aber trotzdem mit seinen echten Kosten (0.3) belastet.
      expect(result.remaining).toBe(0.7)
      // Und der Agent-Node ist als failed verbucht.
      expect(done.run?.agents.some((a) => a.status === "failed")).toBe(true)
    }),
  )

  // N2 (medium): finish() persistet (orDie) den Terminalzustand. Schlägt dieser
  // Terminal-Write fehl, darf das done-Deferred NICHT verloren gehen — sonst
  // hängt jedes wait() ohne Timeout ewig. Wir injizieren genau eine fehlschlagende
  // Terminal-Persistenz über einen minimalen, klar dokumentierten Test-Seam und
  // verlangen, dass wait() trotzdem mit dem Terminalzustand resolved.
  it.instance("finish resolves waiters even when the terminal persist fails", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "hello",
          `export const meta = { name: "Hello" }
export async function run(args, ctx) { ctx.setPhase("run"); return { value: args.value } }
`,
        ),
      )
      const workflow = yield* Workflow.Service
      // Seam: der NÄCHSTE Terminal-Persist (in finish) wirft einmalig.
      Workflow.__testHooks.failNextTerminalPersist()
      const run = yield* workflow.start({ name: "hello", args: { value: 1 } })
      // wait() OHNE Timeout: darf nicht hängen, sondern muss den Terminalzustand
      // liefern, obwohl der Terminal-DB-Write fehlgeschlagen ist.
      const waited = yield* awaitWithTimeout(
        workflow.wait({ id: run.id }),
        "wait hung after a failing terminal persist",
        "5 seconds",
      )
      expect(waited.run?.status).toBe("completed")
      expect(waited.run?.result).toEqual({ value: 1 })
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

  // Fund 2 (Symlink-Boundary): Ein Symlink in workflows/ -> externes Ziel darf
  // NIE als Workflow erscheinen. Sonst sieht ein Reviewer nur den harmlosen
  // Symlink, während start() das externe Ziel (z. B. /tmp/payload.ts) lädt.
  it.instance("a symlink in workflows/ pointing outside the directory is not discovered", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // Externes Ziel außerhalb des workflows-Verzeichnisses.
      const external = path.join(os.tmpdir(), `workflow-symlink-payload-${Math.random().toString(16).slice(2)}.js`)
      yield* Effect.promise(() =>
        Bun.write(
          external,
          `export const meta = { name: "Payload" }
export async function run() { return { ok: true } }
`,
        ),
      )
      // Reguläre Datei als Regressions-Guard: muss weiterhin gefunden werden.
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "regular",
          `export const meta = { name: "Regular" }
export async function run() { return { ok: true } }
`,
        ),
      )
      const workflowsDir = path.join(test.directory, ".opencode", "workflows")
      const link = path.join(workflowsDir, "evil.js")
      yield* Effect.promise(() => fs.symlink(external, link))

      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      // Der Symlink-Eintrag darf NICHT als gültiger Workflow erscheinen.
      const evil = list.find((item) => item.name === "evil")
      expect(evil?.valid).not.toBe(true)
      // Die reguläre Datei bleibt auffindbar (Regressions-Guard).
      expect(list.some((item) => item.name === "regular" && item.valid === true)).toBe(true)

      yield* Effect.promise(() => fs.rm(external, { force: true }))
    }),
  )

  // Fund 40 (Temp-Cleanup): Eine verwaiste loadModule-Tempdatei (Namensmuster
  // `.<base>.<ts>.<rand>.mts`) im workflows-Verzeichnis darf NIE als Workflow
  // gelistet werden und wird beim Discovery-Lauf opportunistisch gelöscht, wenn
  // sie alt ist (> ~1h).
  it.instance("an orphaned loadModule temp file is never listed and old ones are swept", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "hello",
          `export const meta = { name: "Hello" }
export async function run() { return { ok: true } }
`,
        ),
      )
      const workflowsDir = path.join(test.directory, ".opencode", "workflows")
      // Exaktes Namensmuster, das loadModule erzeugt: `.<base>.<ts>.<rand>.mts`.
      const orphan = path.join(workflowsDir, `.hello.${Date.now()}.abc123.mts`)
      yield* Effect.promise(() =>
        Bun.write(
          orphan,
          `export const meta = { name: "Orphan" }
export async function run() { return { ok: true } }
`,
        ),
      )
      // Alt machen (2h zurück), damit der Sweep sie löscht.
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      yield* Effect.promise(() => fs.utimes(orphan, old, old))

      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      // Die Tempdatei darf in keiner Form als Workflow auftauchen.
      expect(list.some((item) => item.name.includes("hello.") || item.meta.name === "Orphan")).toBe(false)
      // Die echte Datei bleibt gelistet.
      expect(list.some((item) => item.name === "hello" && item.valid === true)).toBe(true)
      // Die alte verwaiste Tempdatei wurde beim Discovery-Lauf gelöscht.
      expect(yield* Effect.promise(() => Bun.file(orphan).exists())).toBe(false)
    }),
  )

  // N4 (Projekt-Vorrang): Ein gleichnamiger Workflow im Projekt- UND im
  // Global-Config-Verzeichnis muss zur PROJEKT-Datei auflösen — sonst schattet
  // die globale Datei die Projektdatei und start()/find() trifft die falsche.
  it.instance("a project workflow takes precedence over a same-named global workflow", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // Projekt-Datei.
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "shared",
          `export const meta = { name: "ProjectShared" }
export async function run() { return { from: "project" } }
`,
        ),
      )
      // Gleichnamige Datei im globalen Config-Verzeichnis (~/.config/opencode).
      const globalWorkflows = path.join(Global.Path.config, "workflows")
      const globalFile = path.join(globalWorkflows, "shared.js")
      yield* Effect.promise(() => fs.mkdir(globalWorkflows, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          globalFile,
          `export const meta = { name: "GlobalShared" }
export async function run() { return { from: "global" } }
`,
        ),
      )

      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      const shared = list.filter((item) => item.name === "shared")
      // Genau ein Eintrag (dedupliziert nach Name)...
      expect(shared.length).toBe(1)
      // ... und es ist die PROJEKT-Datei.
      const projectWorkflows = path.join(test.directory, ".opencode", "workflows")
      expect(shared[0]?.path.startsWith(projectWorkflows)).toBe(true)
      expect(shared[0]?.meta.name).toBe("ProjectShared")

      // start() löst denselben Namen ebenfalls zur Projekt-Datei auf.
      const run = yield* workflow.start({ name: "shared" })
      const done = (yield* workflow.wait({ id: run.id })).run
      expect(done?.result).toEqual({ from: "project" })
      expect(done?.definition?.path.startsWith(projectWorkflows)).toBe(true)

      yield* Effect.promise(() => fs.rm(globalFile, { force: true }))
    }),
  )

  // Fund 6 (HIGH) — Cross-Directory-Leak. Zwei Verzeichnisse A/B teilen sich
  // dieselbe (prozess-globale) DB. runs() von B darf As Run NICHT enthalten:
  // jeder Run ist auf das Verzeichnis gescoped, in dem er gestartet wurde.
  it.instance(
    "runs() does not leak runs started in another directory",
    () =>
      Effect.gen(function* () {
        const a = yield* TestInstance
        const b = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(() =>
          writeWorkflow(
            a.directory,
            "hello",
            `export const meta = { name: "Hello" }
export async function run() { return { ok: true } }
`,
          ),
        )
        const workflow = yield* Workflow.Service
        const runA = yield* workflow.start({ name: "hello" })
        yield* workflow.wait({ id: runA.id })

        // B's Liste enthält As Run NICHT.
        const fromB = yield* workflow.runs().pipe(provideInstance(b))
        expect(fromB.some((r) => r.id === runA.id)).toBe(false)
        // A sieht den eigenen Run weiterhin (Regression).
        const fromA = yield* workflow.runs()
        expect(fromA.some((r) => r.id === runA.id)).toBe(true)
      }),
    { git: true },
  )

  // Fund 6 (HIGH) — get()/remove() aus dem fremden Verzeichnis dürfen As Row
  // weder lesen noch löschen. Kalt-Read (kein Registry-Eintrag, nur DB).
  it.instance(
    "get()/remove() from another directory cannot see or delete a foreign run",
    () =>
      Effect.gen(function* () {
        const a = yield* TestInstance
        const b = yield* tmpdirScoped({ git: true })
        const workflow = yield* Workflow.Service
        // As Run direkt als Row seeden, mit As directory.
        const idA = Workflow.RunID.make("job_dir_scoped_A")
        const { db } = yield* Database.Service
        const now = Date.now()
        yield* db
          .insert(WorkflowRunTable)
          .values({
            id: idA,
            workflow: HELLO_FIXTURE,
            status: "completed",
            started_at: now,
            completed_at: now,
            directory: a.directory,
            logs: [],
            agents: [],
          })
          .run()
          .pipe(Effect.orDie)

        // B sieht ihn nicht.
        expect(yield* workflow.get(idA).pipe(provideInstance(b))).toBeUndefined()
        // remove aus B meldet false und lässt As Row unangetastet.
        const removed = yield* workflow.remove(idA).pipe(provideInstance(b))
        expect(removed).toBe(false)
        const row = yield* fetchRunRow(idA)
        expect(row.status).toBe("completed")
        // A findet seinen Run weiterhin.
        const fromA = yield* workflow.get(idA)
        expect(fromA?.id).toBe(idA)
      }),
    { git: true },
  )

  // Fund 17 (medium) — Startup-Sweep cross-directory. Ein Sweep aus B (leere
  // liveIds-Registry, frische InstanceState) darf NUR Bs eigene Zombie-Rows
  // heilen — As running-Row im anderen Verzeichnis bleibt unangetastet.
  it.instance(
    "sweep from another directory leaves foreign running rows untouched",
    () =>
      Effect.gen(function* () {
        const a = yield* TestInstance
        const b = yield* tmpdirScoped({ git: true })
        const workflow = yield* Workflow.Service
        const { db } = yield* Database.Service
        const now = Date.now()
        // As running-Row (gehört Verzeichnis A).
        yield* db
          .insert(WorkflowRunTable)
          .values({
            id: "job_sweep_A",
            workflow: HELLO_FIXTURE,
            status: "running",
            started_at: now,
            directory: a.directory,
            logs: [],
            agents: [],
          })
          .run()
          .pipe(Effect.orDie)
        // Bs eigene Zombie-Row.
        yield* db
          .insert(WorkflowRunTable)
          .values({
            id: "job_sweep_B",
            workflow: HELLO_FIXTURE,
            status: "running",
            started_at: now,
            directory: b,
            logs: [],
            agents: [],
          })
          .run()
          .pipe(Effect.orDie)

        // Sweep aus B: heilt nur Bs Zombie, nicht As running-Row.
        yield* workflow.sweep().pipe(provideInstance(b))
        expect((yield* fetchRunRow("job_sweep_A")).status).toBe("running")
        expect((yield* fetchRunRow("job_sweep_B")).status).toBe("interrupted")

        // As eigener Sweep heilt dann As Zombie.
        yield* workflow.sweep()
        expect((yield* fetchRunRow("job_sweep_A")).status).toBe("interrupted")
      }),
    { git: true },
  )
})
