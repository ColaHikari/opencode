import { describe, expect, test } from "bun:test"
import { Workflow } from "@/workflow/workflow"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { Agent } from "@/agent/agent"
import { SessionID } from "@/session/schema"
import type { SessionPrompt } from "@/session/prompt"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowRunTable } from "@opencode-ai/core/workflow/sql"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { MessageID } from "@opencode-ai/core/v1/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { eq, sql } from "drizzle-orm"
import { TestInstance, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { InstanceState } from "@/effect/instance-state"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"

// Database.defaultLayer is merged so the orphan-sweep tests can seed a row
// directly through the same in-memory SQLite connection the engine uses.
// Session/Agent.defaultLayer are merged so the subagent-permission-inheritance
// tests can create a caller session (with a deny ruleset) and read back the
// child session the engine spawns — through the SAME memoised services the
// engine resolves (Effect dedupes shared layer builds, exactly as for Database).
const it = testEffect(
  Layer.mergeAll(
    Workflow.defaultLayer,
    Database.defaultLayer,
    Session.defaultLayer,
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    // EventV2Bridge.defaultLayer is merged so a test can subscribe to the SAME bus
    // instance the engine publishes run-lifecycle events on. It is the identical
    // exported const reference the Workflow layer provides internally, so Effect's
    // layer memoisation resolves both to ONE instance (exactly as for Database).
    EventV2Bridge.defaultLayer,
  ),
)

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
            // Fund 51: per-agent telemetry (cost USD + tokens incl. `total`) must
            // survive the DB→fromRow roundtrip, not just status/output. Seeded with
            // non-zero values so a roundtrip that drops them would be observable.
            cost: 0.42,
            tokens: { total: 99, input: 11, output: 22, reasoning: 33, cache: { read: 44, write: 55 } },
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

// Subagent-permission-inheritance fixture (#26514 regression / Fund N9): a
// single agent step that completes. The engine must spawn its child session
// with a derived `permission` ruleset when a `caller` context is supplied.
const SINGLE_AGENT_FIXTURE = "single-agent"
const SINGLE_AGENT_WORKFLOW = `export const meta = { name: "${SINGLE_AGENT_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "do the thing" })
  return { ok: true }
}
`

// Per-step reasoning variant fixture (Task 6): a single agent step that passes a
// `variant` through to the engine. The engine must thread that variant into the
// underlying prompt run (PromptInput.variant) unchanged.
const VARIANT_FIXTURE = "variant-step"
const VARIANT_WORKFLOW = `export const meta = { name: "${VARIANT_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "hi", variant: "max" })
  return { ok: true }
}
`

// model:"small" fixture (Task 7): a single agent step that requests the magic
// "small" model. The engine must resolve this to the configured small_model and
// dispatch the prompt against that provider/model.
const SMALL_MODEL_FIXTURE = "small-model-step"
const SMALL_MODEL_WORKFLOW = `export const meta = { name: "${SMALL_MODEL_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "hi", model: "small" })
  return { ok: true }
}
`

// Per-step tools-scoping fixture (Task 8): a single agent step that passes a
// `tools` whitelist/blacklist. The engine must thread that Record<string,boolean>
// through to the prompt run (PromptInput.tools) unchanged so the session scopes
// its tools accordingly.
const TOOLS_FIXTURE = "tools-step"
const TOOLS_WORKFLOW = `export const meta = { name: "${TOOLS_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "hi", tools: { webfetch: false } })
  return { ok: true }
}
`

// Security-compose fixture: a single agent step that tries to RE-GRANT a tool
// (\`edit\`) the inherited caller permission denies (Plan Mode). The per-step
// grant must NOT override the inherited deny — the composed child-session
// ruleset must still deny \`edit\`.
const TOOLS_REGRANT_FIXTURE = "tools-regrant-step"
const TOOLS_REGRANT_WORKFLOW = `export const meta = { name: "${TOOLS_REGRANT_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "hi", tools: { edit: true } })
  return { ok: true }
}
`

// Per-step skills fixture (Task 9): a single agent step that requests specific
// skills. opencode only loads skills via the runtime \`skill\` tool, so the engine
// prepends a load directive to the prompt and enables the skill tool for the step.
const SKILLS_FIXTURE = "skills-step"
const SKILLS_WORKFLOW = `export const meta = { name: "${SKILLS_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "do it", skills: ["pdf", "xlsx"] })
  return { ok: true }
}
`

// Declarative file-attachments fixture (Task 10): a single agent step that
// attaches an existing file by path. The engine must resolve the path relative
// to the run's workspace directory and append a file part after the text part.
const FILES_FIXTURE = "files-step"
const FILES_WORKFLOW = `export const meta = { name: "${FILES_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "hi", files: ["./ATTACH.md"] })
  return { ok: true }
}
`

// Missing-file variant of the Task 10 fixture: a non-existent attachment must
// fail the run with a WorkflowInvalidError naming the missing file.
const FILES_MISSING_FIXTURE = "files-missing-step"
const FILES_MISSING_WORKFLOW = `export const meta = { name: "${FILES_MISSING_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "hi", files: ["./DOES_NOT_EXIST.md"] })
  return { ok: true }
}
`


// Task 11: a single agent step requesting worktree isolation. When the workspace
// is a git repository the engine runs the subagent inside a fresh `git worktree`
// (auto-cleaned on the run scope); a non-git workspace fails the step with a
// WorkflowInvalidError naming the missing git repository.
const ISOLATION_FIXTURE = "isolation-step"
const ISOLATION_WORKFLOW = `export const meta = { name: "${ISOLATION_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "hi", isolation: "worktree" })
  return { ok: true }
}
`

// Task 11a (deterministic non-LLM shell step): ctx.shell runs a command in the
// run's workspace and returns { output, exitCode } WITHOUT consuming an LLM turn
// or budget. A non-zero exit is mapped to the return value (never thrown), and
// ctx.budget.spent() stays 0 because shell never touches the cost accumulator.
const SHELL_FIXTURE = "shell-step"
const SHELL_WORKFLOW = `export const meta = { name: "${SHELL_FIXTURE}", phases: ["run"] }
export async function run(_args, ctx) {
  ctx.setPhase("run")
  const ok = await ctx.shell("echo hello-workflow")
  const fail = await ctx.shell("exit 3")
  return { out: ok.output.trim(), okCode: ok.exitCode, failCode: fail.exitCode, spent: ctx.budget.spent() }
}
`

// Task 11b (depth-1 nesting): a parent workflow runs a DISCOVERED child workflow
// inline via ctx.workflow under the SAME run (no second run row). The child's
// logs are prefixed (`child: ...`) and its result flows back to the parent.
const NEST_CHILD_FIXTURE = "child"
const NEST_CHILD_WORKFLOW = `export const meta = { name: "${NEST_CHILD_FIXTURE}", description: "c" }
export async function run(args, ctx) {
  ctx.log("child-ran")
  return { doubled: Number(args.n) * 2 }
}
`
const NEST_PARENT_FIXTURE = "parent"
const NEST_PARENT_WORKFLOW = `export const meta = { name: "${NEST_PARENT_FIXTURE}", description: "p" }
export async function run(_a, ctx) {
  const r = await ctx.workflow("child", { n: 21 })
  return { fromChild: r.doubled }
}
`

// Task 11b (depth guard): a child that ITSELF calls ctx.workflow must be refused —
// nesting is limited to depth 1, so the nested call throws a WorkflowInvalidError
// and the run fails with that error.
const NEST_GRANDCHILD_FIXTURE = "grandchild"
const NEST_GRANDCHILD_WORKFLOW = `export const meta = { name: "${NEST_GRANDCHILD_FIXTURE}", description: "gc" }
export async function run(args, ctx) { return { ok: true } }
`
const NEST_DEEP_CHILD_FIXTURE = "deep-child"
const NEST_DEEP_CHILD_WORKFLOW = `export const meta = { name: "${NEST_DEEP_CHILD_FIXTURE}", description: "dc" }
export async function run(args, ctx) {
  // depth-2 attempt: this nested ctx.workflow must throw.
  return await ctx.workflow("grandchild", {})
}
`
const NEST_DEEP_PARENT_FIXTURE = "deep-parent"
const NEST_DEEP_PARENT_WORKFLOW = `export const meta = { name: "${NEST_DEEP_PARENT_FIXTURE}", description: "dp" }
export async function run(_a, ctx) {
  return await ctx.workflow("deep-child", {})
}
`

// Task 11b (c) (shared agent-lifetime cap): a parent that dispatches one agent and
// then runs a child that dispatches more — collectively exceeding the run's
// (test-lowered) agent-lifetime cap. The cap is shared via the SAME run, so the
// over-cap dispatch (inside the child) fails the WHOLE run with AgentLimitError.
const NEST_AGENT_CHILD_FIXTURE = "agent-child"
const NEST_AGENT_CHILD_WORKFLOW = `export const meta = { name: "${NEST_AGENT_CHILD_FIXTURE}", description: "ac" }
export async function run(args, ctx) {
  for (let i = 0; i < args.count; i++) await ctx.agent({ prompt: "child step " + i })
  return { ok: true }
}
`
const NEST_AGENT_PARENT_FIXTURE = "agent-parent"
const NEST_AGENT_PARENT_WORKFLOW = `export const meta = { name: "${NEST_AGENT_PARENT_FIXTURE}", description: "ap" }
export async function run(_a, ctx) {
  await ctx.agent({ prompt: "parent step" })
  return await ctx.workflow("agent-child", { count: 10 })
}
`

// Prompt-ops that resolve every agent prompt immediately (no hang), so the run
// reaches `completed` and the child session is fully created/projected.
function immediatePromptOps() {
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: () => Effect.succeed(assistantReply()),
    cancel: () => Effect.void,
  }
  return ops
}

// Capturing prompt-ops: resolve every agent prompt immediately (like
// immediatePromptOps) but capture each real (non-noReply) PromptInput so a test
// can assert on what the engine actually dispatched (e.g. its resolved `variant`
// or `model`). The initial "Workflow started" noReply message is skipped so only
// genuine ctx.agent dispatches are recorded. Named distinctly from the journal
// `recordingPromptOps` below so the two never collide via function hoisting.
function capturingPromptOps() {
  const inputs: SessionPrompt.PromptInput[] = []
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.sync(() => {
        if (!input.noReply) inputs.push(input)
        return assistantReply()
      }),
    cancel: () => Effect.void,
  }
  return { ops, inputs }
}

// Directory-capturing prompt-ops: like capturingPromptOps, but for each real
// (non-noReply) dispatch it ALSO records the EFFECTIVE instance directory the
// prompt runs under (`InstanceState.directory`). This is the directory the
// subagent's file tools (bash/edit/write/read) resolve their cwd against — so
// recording it from INSIDE the prompt-op Effect proves whether worktree
// isolation actually redirects the child (the assertion target for Task 11),
// not merely that a worktree was created.
function directoryCapturingPromptOps() {
  const inputs: SessionPrompt.PromptInput[] = []
  const directories: string[] = []
  // Whether the captured directory contained a `.git` entry AT DISPATCH TIME
  // (i.e. while the worktree was still live) — proving it was a real git
  // worktree, observed before the run-scope finalizer removes it.
  const wasGitWorktree: boolean[] = []
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (!input.noReply) {
          inputs.push(input)
          const dir = yield* InstanceState.directory
          directories.push(dir)
          wasGitWorktree.push(
            yield* Effect.promise(() =>
              fs
                .stat(path.join(dir, ".git"))
                .then(() => true)
                .catch(() => false),
            ),
          )
        }
        return assistantReply()
      }),
    cancel: () => Effect.void,
  }
  return { ops, inputs, directories, wasGitWorktree }
}

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

// A minimal single-phase, zero-agent workflow used by the bus-event test: it sets
// the phase and returns a value, so the run goes running -> completed through the
// same persistRun choke-point every state write uses — no provider stubbing needed.
const EVENTS_FIXTURE = "events"
const EVENTS_WORKFLOW = `export const meta = { name: "${EVENTS_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) { ctx.setPhase("run"); return { ok: true } }
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

// Deterministic concurrency barrier shared with a workflow module's body.
// `loadModule` imports the workflow into the SAME process, and Bun shares
// `globalThis` across dynamically imported modules (verified), so a barrier
// registered here under a unique token is reachable from the workflow body via
// `globalThis.__workflowTestBarriers[token]`. Every task entering the barrier
// bumps a live `active` counter (tracking `peak`) and then parks on a single
// shared gate Promise until the test releases it. This replaces wall-clock
// `setTimeout` windows (Fund 48): a task's overlap is observed by polling the
// `active` counter for a CONDITION (e.g. "20 tasks parked"), never by sleeping a
// fixed duration and hoping the tasks happened to overlap. The gate keeps every
// in-flight task suspended until the test has observed the peak, so the measured
// concurrency is exactly the engine's scheduling decision, not a timing artifact.
type TestBarrier = {
  active: number
  peak: number
  /** Resolves when the test releases the gate; tasks await this before exiting. */
  gate: Promise<void>
  release: () => void
  /** Per-key ordered markers a task can push (used by the no-barrier pipeline proof). */
  order: string[]
}

declare global {
  // `var` (not `const`) is required for a writable global so the body and the
  // test can assign `globalThis.__workflowTestBarriers`.
  var __workflowTestBarriers: Record<string, TestBarrier> | undefined
}

// Installs a fresh barrier under a unique token and returns the token plus an
// Effect that polls until at least `count` tasks are simultaneously parked on the
// gate (the deterministic "tasks have overlapped" condition) and reports the peak.
function installBarrier() {
  const token = `barrier_${Math.random().toString(16).slice(2)}`
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const barrier: TestBarrier = { active: 0, peak: 0, gate, release, order: [] }
  ;(globalThis.__workflowTestBarriers ??= {})[token] = barrier
  return {
    token,
    barrier,
    // Waits until `peak` has reached `count` (i.e. that many tasks have been
    // simultaneously parked at the gate at some point), then yields the barrier.
    awaitPeak: (count: number) =>
      pollWithTimeout(
        Effect.sync(() => (barrier.peak >= count ? barrier : undefined)),
        `barrier never reached peak ${count}`,
      ),
    // Waits until an exact ordered marker has been recorded by a task.
    awaitOrder: (marker: string) =>
      pollWithTimeout(
        Effect.sync(() => (barrier.order.includes(marker) ? barrier : undefined)),
        `barrier never recorded order marker ${marker}`,
      ),
  }
}

// The body-side latch helper, inlined as source text into every barrier fixture
// (the workflow module runs in its own import; it cannot import test helpers).
// A task: bumps active/peak, parks on the gate, then decrements active on the way
// out. `enter`/`leave` are split so a pipeline stage can record order between them.
const BARRIER_PRELUDE = `
  const __b = globalThis.__workflowTestBarriers[args.__barrier]
  const __enter = () => { __b.active++; __b.peak = Math.max(__b.peak, __b.active) }
  const __leave = () => { __b.active-- }
  const __park = async () => { await __b.gate }
`

// Parallel barrier fixture: N tasks (count from args), each parks on the shared
// gate so the test can observe the true peak concurrency deterministically. The
// concurrencyLimit is passed through from args (omitted ⇒ engine default).
const PARALLEL_BARRIER_FIXTURE = "parallel-barrier"
const PARALLEL_BARRIER_WORKFLOW = `export const meta = { name: "${PARALLEL_BARRIER_FIXTURE}", phases: ["parallel"] }
export async function run(args, ctx) {
  ctx.setPhase("parallel")${BARRIER_PRELUDE}
  const tasks = Array.from({ length: args.count }, (_, i) => async () => {
    __enter()
    await __park()
    __leave()
    return i
  })
  const options = args.concurrencyLimit === undefined ? undefined : { concurrencyLimit: args.concurrencyLimit }
  const result = await ctx.parallel(tasks, options)
  return { peak: __b.peak, result }
}
`

// P1 (Claude parity): a rejecting task in ctx.parallel must NOT kill the whole
// batch — it resolves to `null` at its position, the surviving tasks keep their
// values, and the drop is LOGGED (never silent). Module uses `export default`
// so the resolved-object load path is exercised too.
const PARALLEL_ERROR_FIXTURE = "par-err"
const PARALLEL_ERROR_WORKFLOW = `export default {
  meta: { name: "${PARALLEL_ERROR_FIXTURE}", description: "parallel error tolerance" },
  async run(_args, ctx) {
    const out = await ctx.parallel([
      () => Promise.resolve("ok-1"),
      () => Promise.reject(new Error("boom")),
      () => Promise.resolve("ok-3"),
    ])
    return { out }
  },
}
`

// P2 (Claude parity): a throwing stage in ctx.pipeline must NOT kill the whole
// pipeline — it drops ONLY that item to `null` at its position and skips that
// item's remaining stages, while the other items run every stage to completion;
// the drop is LOGGED (never silent). Module uses `export default` so the
// resolved-object load path is exercised too.
const PIPELINE_ERROR_FIXTURE = "pipe-err"
const PIPELINE_ERROR_WORKFLOW = `export default {
  meta: { name: "${PIPELINE_ERROR_FIXTURE}", description: "pipeline per-item drop" },
  async run(_args, ctx) {
    const calls: string[] = []
    const out = await ctx.pipeline(
      [1, 2, 3],
      async (prev) => { if (prev === 2) throw new Error("stage1-boom"); calls.push("s1:" + prev); return prev * 10 },
      async (prev, item) => { calls.push("s2:" + item); return prev + 1 },
    )
    return { out, calls }
  },
}
`

// Pipeline barrier fixture: N items, ONE stage that parks every item on the gate,
// so the test can observe how many items run that stage concurrently (the
// pipeline concurrency default / clamp).
const PIPELINE_BARRIER_FIXTURE = "pipeline-barrier"
const PIPELINE_BARRIER_WORKFLOW = `export const meta = { name: "${PIPELINE_BARRIER_FIXTURE}", phases: ["pipeline"] }
export async function run(args, ctx) {
  ctx.setPhase("pipeline")${BARRIER_PRELUDE}
  const items = Array.from({ length: args.count }, (_, i) => i)
  const stage = async (item) => { __enter(); await __park(); __leave(); return item }
  // Pass the options object ONLY when a limit is set: the engine treats a trailing
  // object as { concurrencyLimit }, so a trailing undefined would be parsed as a
  // (missing) stage. No-options ⇒ pipeline runs items unbounded.
  const result = args.concurrencyLimit === undefined
    ? await ctx.pipeline(items, stage)
    : await ctx.pipeline(items, stage, { concurrencyLimit: args.concurrencyLimit })
  return { peak: __b.peak, result }
}
`

// No-barrier pipeline ordering fixture (deterministic replacement for the
// setTimeout-based PIPELINE_WORKFLOW ordering proof, Fund 48): item "A" parks in
// stage 1 on the shared gate; item "B" passes stage 1 unparked and records that it
// REACHED stage 2 while A is still held in stage 1. Stage 2 also changes the type
// (string -> { a, b }), proving heterogeneous stages. The test waits for B's
// stage-2 marker (a condition, no wall clock) BEFORE releasing A, so the ordering
// claim "B reaches stage 2 before A leaves stage 1" is guaranteed, not timed.
const PIPELINE_ORDER_FIXTURE = "pipeline-order"
const PIPELINE_ORDER_WORKFLOW = `export const meta = { name: "${PIPELINE_ORDER_FIXTURE}", phases: ["pipeline"] }
export async function run(args, ctx) {
  ctx.setPhase("pipeline")${BARRIER_PRELUDE}
  const result = await ctx.pipeline(
    ["A", "B"],
    async (item) => {
      __b.order.push(item + ":stage1:start")
      // Item A is held in stage 1 on the gate until the test releases it; item B
      // proceeds immediately, so B can reach stage 2 before A leaves stage 1.
      if (item === "A") await __park()
      __b.order.push(item + ":stage1:done")
      return { item, n: item === "A" ? 1 : 2 }
    },
    async (prev, item) => {
      __b.order.push(item + ":stage2")
      return { a: prev.n, b: prev.item === "A" ? "x" : "y" }
    },
  )
  return { order: __b.order, result }
}
`

// Telemetry shape of a single assistant turn — exactly the fields the engine reads
// off a persisted assistant message when it sums per-agent cost/tokens.
type AssistantTurn = {
  cost: number
  tokens: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  structured?: unknown
  error?: unknown
}

// Faithfully mirrors the production session layer: SessionPrompt.runLoop is a
// while(true) loop that PERSISTS one assistant message per turn (queryable via
// Session.messages) and RETURNS only the last one. The prompt fakes are given the
// engine's child sessionID, so they write each turn into the SAME MessageTable the
// engine's `sessions.messages(sessionID)` sum reads from, then resolve with a
// WithParts carrying the LAST turn's info (the engine still uses that single
// message for message_id / output / abort + structured-output detection). A fake
// with a single turn persists exactly one row ⇒ the summed result equals that row,
// identical to the previous single-message behaviour. The captured Database.Service
// is the same in-memory connection the engine uses (memoised in the merged layer).
function persistTurns(db: Database.Interface["db"], sessionID: string, turns: AssistantTurn[]) {
  return Effect.gen(function* () {
    let last: SessionV1.WithParts | undefined
    for (const turn of turns) {
      const id = MessageID.ascending()
      const data = {
        role: "assistant",
        providerID: "test",
        modelID: "test-model",
        cost: turn.cost,
        tokens: turn.tokens,
        ...("structured" in turn ? { structured: turn.structured } : {}),
        ...(turn.error ? { error: turn.error } : {}),
      }
      yield* db
        .insert(MessageTable)
        .values({
          id,
          session_id: sessionID,
          time_created: Date.now(),
          time_updated: Date.now(),
          data,
        } as unknown as typeof MessageTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      last = {
        info: { id, sessionID, ...data },
        parts: [{ type: "text", text: "ok" }],
      } as unknown as SessionV1.WithParts
    }
    return last!
  })
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
    ({
      info: { role: "assistant", error: { name: "MessageAbortedError", data: {} } },
      parts: [],
    }) as unknown as SessionV1.WithParts
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
function tokensPromptOps(db: Database.Interface["db"]) {
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        return yield* persistTurns(db, input.sessionID, [
          { cost: 0, tokens: { input: 11, output: 22, reasoning: 0, cache: { read: 33, write: 44 } } },
        ])
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
function structuredPromptOps(db: Database.Interface["db"], mode: "structured" | "undefined" | "error", cost = 0) {
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        const turn: AssistantTurn = {
          cost,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        if (mode === "structured") turn.structured = SCHEMA_OBJECT
        if (mode === "error")
          turn.error = {
            name: "StructuredOutputError",
            data: { message: "Model did not produce structured output", retries: 0 },
          }
        const last = yield* persistTurns(db, input.sessionID, [turn])
        const parts = mode === "undefined" || mode === "error" ? [{ type: "text", text: "here is some plaintext" }] : []
        return { info: last.info, parts } as unknown as SessionV1.WithParts
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
function costPromptOps(db: Database.Interface["db"], cost: number) {
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        return yield* persistTurns(db, input.sessionID, [
          { cost, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        ])
      }),
    cancel: () => Effect.void,
  }
  return ops
}

// Multi-turn fake (Fund N12): a SINGLE ctx.agent step whose underlying session
// runs several provider turns (the normal case when the subagent uses tools),
// each persisting its own assistant message with its own cost/tokens. Production
// returns only the LAST turn, so charging that one alone discards every
// intermediate turn. The engine must instead sum cost/tokens across ALL persisted
// assistant messages of the child session.
function multiTurnPromptOps(db: Database.Interface["db"], turns: AssistantTurn[]) {
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        return yield* persistTurns(db, input.sessionID, turns)
      }),
    cancel: () => Effect.void,
  }
  return ops
}

// Fund 23 (budget soft-cap under parallelism): prompt-ops that hold EVERY agent
// prompt at a shared latch until `expected` prompts have arrived, then resolve all
// of them with the given per-step `cost`. The engine checks the budget gate at the
// TOP of `ctx.agent`, BEFORE calling the prompt — so by the time a prompt arrives
// here its step has already passed the gate. Gating the resolution until all
// `expected` prompts have arrived therefore GUARANTEES, deterministically (a
// Deferred barrier, not a timing window), that all parallel in-flight steps passed
// the gate while the budget was still positive. They then all settle and charge,
// documenting the best-effort overspend. Returns the latch arrival promise so the
// test can also await the barrier shape if needed.
function budgetBarrierPromptOps(db: Database.Interface["db"], cost: number, expected: number) {
  const gates: Deferred.Deferred<void>[] = []
  let arrived = 0
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        // Park until all `expected` parallel prompts have arrived: each opens its
        // own gate, and the LAST arrival releases every gate at once.
        const gate = yield* Deferred.make<void>()
        gates.push(gate)
        arrived += 1
        if (arrived >= expected) for (const g of gates) yield* Deferred.succeed(g, undefined)
        yield* Deferred.await(gate)
        return yield* persistTurns(db, input.sessionID, [
          { cost, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        ])
      }),
    cancel: () => Effect.void,
  }
  return ops
}

// Fund 23: N parallel agent steps, then a SEQUENTIAL step after the batch. With a
// budget that each parallel step's cost overshoots in aggregate, all N parallel
// steps pass the gate (budget still positive when each is checked) and all are
// charged — the documented soft-cap overspend. The follow-up sequential step then
// hits an exhausted budget and fails. The workflow catches that failure and reports
// how far the budget was overspent and that the post-batch step did NOT run.
const BUDGET_PARALLEL_FIXTURE = "budget-parallel"
const BUDGET_PARALLEL_WORKFLOW = `export const meta = { name: "${BUDGET_PARALLEL_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const tasks = Array.from({ length: args.count }, (_, i) => () => ctx.agent({ prompt: "parallel " + i }))
  await ctx.parallel(tasks)
  const overspent = ctx.budgetRemaining
  let nextStarted = false
  let nextFailed = false
  try {
    nextStarted = true
    await ctx.agent({ prompt: "after the batch" })
  } catch (e) {
    nextFailed = true
  }
  return { overspent, nextStarted, nextFailed }
}
`

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

// ctx.budget (Claude-Code-Parität) MIT gesetztem Budget: liest total/spent()/
// remaining() OHNE Agent-Step, sodass spent()===0 und remaining()===total gilt.
const BUDGET_API_FIXTURE = "budget-api"
const BUDGET_API_WORKFLOW = `export const meta = { name: "${BUDGET_API_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  return { total: ctx.budget.total, spent: ctx.budget.spent(), remaining: ctx.budget.remaining() }
}
`

// ctx.budget OHNE Budget: total ist null und remaining() ist Infinity. Infinity
// überlebt JSON nicht, daher gibt das Fixture stattdessen einen Booleschen zurück.
const BUDGET_API_UNLIMITED_FIXTURE = "budget-api-unlimited"
const BUDGET_API_UNLIMITED_WORKFLOW = `export const meta = { name: "${BUDGET_API_UNLIMITED_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  return { total: ctx.budget.total, remainingFinite: Number.isFinite(ctx.budget.remaining()) }
}
`

// Fund 18/19/20 (Argument-Koerzierung & Defaults): ein Workflow, der die
// deklarierten args UND deren JS-Laufzeittypen 1:1 ins Resultat zurückgibt.
// Über `typeof` kann der Test beweisen, dass die Engine String-eingehende args
// (z. B. JSON-args über HTTP) gemäß dem deklarierten `type` koerziert hat, bevor
// `run` sie sieht — und dass nicht deklarierte args unverändert durchgereicht
// werden.
const COERCE_FIXTURE = "coerce-args"
const COERCE_WORKFLOW = `export const meta = {
  name: "${COERCE_FIXTURE}",
  arguments: {
    count: { type: "number" },
    flag: { type: "boolean" },
    label: { type: "string" },
    bare: {},
  },
}
export async function run(args, ctx) {
  return {
    count: args.count,
    countType: typeof args.count,
    flag: args.flag,
    flagType: typeof args.flag,
    label: args.label,
    labelType: typeof args.label,
    bare: args.bare,
    bareType: typeof args.bare,
  }
}
`

// Fund 20 (Defaults): deklarierte Defaults für jeden Typ. Werden die args nicht
// übergeben, MUSS run() den (typ-korrekten) Default sehen; ein explizit
// übergebener Wert gewinnt über den Default.
const DEFAULT_FIXTURE = "default-args"
const DEFAULT_WORKFLOW = `export const meta = {
  name: "${DEFAULT_FIXTURE}",
  arguments: {
    name: { type: "string", default: "x" },
    count: { type: "number", default: 7 },
    flag: { type: "boolean", default: true },
  },
}
export async function run(args, ctx) {
  return {
    name: args.name,
    nameType: typeof args.name,
    count: args.count,
    countType: typeof args.count,
    flag: args.flag,
    flagType: typeof args.flag,
  }
}
`

// Review-Fund 3i.3 (LOW): ein deklarierter Default wird selbst durch den
// Koerzierungspfad geschickt, bevor er run() erreicht. Ein STRING-Default "7"
// für ein number-Argument muss run() als die Zahl 7 erreichen — nicht als der
// rohe String "7". Bewusst getrennt von DEFAULT_WORKFLOW (dessen Default schon
// die Zahl 7 ist und den rohen Durchschlupf daher NICHT aufdecken würde).
const STRING_DEFAULT_FIXTURE = "string-default-args"
const STRING_DEFAULT_WORKFLOW = `export const meta = {
  name: "${STRING_DEFAULT_FIXTURE}",
  arguments: {
    count: { type: "number", default: "7" },
    flag: { type: "boolean", default: "true" },
  },
}
export async function run(args, ctx) {
  return {
    count: args.count,
    countType: typeof args.count,
    flag: args.flag,
    flagType: typeof args.flag,
  }
}
`

// Track B — Cap-Fixture: N parallele ctx.agent-Aufrufe, jeder am Barrier-Gate
// geparkt (über die Prompt-Ops, nicht im Body), damit der Test den ECHTEN Peak
// gleichzeitig laufender Agent-Dispatches misst. Die Run-weite Semaphore deckelt
// diesen Peak auf min(16, max(2, cpus-2)). Anders als PARALLEL_BARRIER (das
// schlichte Tasks parkt und so NUR die parallel-Concurrency misst), parkt diese
// Fixture innerhalb von ctx.agent — genau der Pfad, den die Semaphore deckelt.
const AGENT_CAP_FIXTURE = "agent-cap"
const AGENT_CAP_WORKFLOW = `export const meta = { name: "${AGENT_CAP_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const tasks = Array.from({ length: args.count }, (_, i) => () => ctx.agent({ prompt: "cap " + i }))
  const result = await ctx.parallel(tasks, { concurrencyLimit: args.count })
  return { result: result.length }
}
`

// Lifetime-Fixture: ruft ctx.agent in einer Schleife N-mal SEQUENTIELL auf, fängt
// einen geworfenen Fehler ab und meldet, wie viele Aufrufe gelangen, bevor das
// Lifetime-Limit zugeschlagen hat.
const LIFETIME_FIXTURE = "agent-lifetime"
const LIFETIME_WORKFLOW = `export const meta = { name: "${LIFETIME_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  for (let i = 0; i < args.count; i++) {
    await ctx.agent({ prompt: "step " + i })
  }
  return { ok: true }
}
`

// Pause-Fixture: ein Agent-Step, der am Gate hängt (über hangingPromptOps), danach
// ein zweiter Step, der bei korrekter Pause NIE läuft (PAUSE_AFTER_MARKER).
const PAUSE_FIXTURE = "pause-hang"
const PAUSE_AFTER_MARKER = "pause-after-reached"
const PAUSE_WORKFLOW = `export const meta = { name: "${PAUSE_FIXTURE}", phases: ["run", "after"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  ctx.log("pause-started")
  await ctx.agent({ prompt: "hang" })
  ctx.setPhase("after")
  ctx.log("${PAUSE_AFTER_MARKER}")
  return { ok: true }
}
`

// Resume-Fixture: zwei sequentielle ctx.agent-Aufrufe (A, dann B). Beim ersten
// Lauf wird A completed, B durch die Pause unterbrochen. Beim Resume muss A aus
// dem Journal kommen (KEIN neuer Prompt), B live laufen. Der Body gibt beide
// Outputs zurück, damit der Test die Werte prüfen kann.
const RESUME_FIXTURE = "resume-two-agents"
const RESUME_WORKFLOW = `export const meta = { name: "${RESUME_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const a = await ctx.agent({ prompt: "agent A" })
  const b = await ctx.agent({ prompt: "agent B" })
  return { a: a.text, b: b.text }
}
`

// Occurrence-Fixture: ZWEI identische Prompts hintereinander. Beim Resume müssen
// beide getrennt aus dem Journal aufgelöst werden (Occurrence-Index), nicht beide
// auf denselben Journal-Eintrag.
const RESUME_DUP_FIXTURE = "resume-dup-prompts"
const RESUME_DUP_WORKFLOW = `export const meta = { name: "${RESUME_DUP_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const first = await ctx.agent({ prompt: "same prompt" })
  const second = await ctx.agent({ prompt: "same prompt" })
  return { first: first.text, second: second.text }
}
`

// Drift-Fixture (Fund: ungeschütztes JSON.parse auf einem Plaintext-Journal-Node).
// Der Journal-Key ist NUR { prompt, agent, phase } — das Schema gehört NICHT dazu.
// Eine V1-Datei mit einem PLAINTEXT-Agenten (kein Schema) erzeugt einen Journal-
// Node, dessen output kein gültiges JSON ist. Wird die SELBE Datei (gleicher Name
// → gleiche path/journalKey) zwischen Lauf und Resume zu V2 überschrieben — jetzt
// fordert derselbe Agent-Call ein Schema an — matcht der Plaintext-Node die Schema-
// Anfrage. Das alte JSON.parse(cached.output) würde synchron werfen (Defect). Der
// Resume MUSS das stattdessen als Cache-MISS behandeln und den Agenten LIVE laufen
// lassen. Beide Versionen teilen Name/Phase/Prompt, damit der Key identisch ist.
const DRIFT_FIXTURE = "resume-schema-drift"
const DRIFT_WORKFLOW_PLAINTEXT = `export const meta = { name: "${DRIFT_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const r = await ctx.agent({ prompt: "drift agent" })
  return { value: r.text }
}
`
const DRIFT_WORKFLOW_SCHEMA = `export const meta = { name: "${DRIFT_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const r = await ctx.agent({ prompt: "drift agent", schema: { type: "object" } })
  return { value: r.data }
}
`

// Prompt-Ops für den Drift-Test: zählt jeden GEFEUERTEN (live) Prompt und liefert,
// wenn ein Schema angefordert wurde (input.format gesetzt), eine strukturierte
// Antwort (message.info.structured) — sonst PLAINTEXT, dessen Text KEIN gültiges
// JSON ist. So beweist der Resume: matcht die Schema-Anfrage den Plaintext-Journal-
// Node, läuft der Agent live (count +1) und liefert ein echtes structured-Ergebnis,
// statt am JSON.parse des Plaintext-Outputs zu defecten.
function driftPromptOps(db: Database.Interface["db"]) {
  const state = { count: 0 }
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        state.count++
        const wantsSchema = input.format?.type === "json_schema"
        const turn: AssistantTurn = {
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        if (wantsSchema) turn.structured = SCHEMA_OBJECT
        const last = yield* persistTurns(db, input.sessionID, [turn])
        // Plaintext-Pfad: ein Text, der bewusst KEIN gültiges JSON ist.
        const parts = wantsSchema ? [] : [{ type: "text", text: "not json at all" }]
        return { info: last.info, parts } as unknown as SessionV1.WithParts
      }),
    cancel: () => Effect.void,
  }
  return { ops, state }
}

// Prompt-Ops, die jeden Agent-Prompt SOFORT mit einem PROMPT-spezifischen Output
// beantworten und (a) jeden gestarteten Prompt-Text protokollieren sowie (b) echte
// Kosten verbuchen. So kann der Resume-Test beweisen, dass für gecachte Agenten
// KEIN neuer Prompt gefeuert wird (Prompt-Text fehlt in `prompted`) und der Output
// aus dem Journal stammt. Der Output ist `"out:" + prompt-text` damit identische
// Prompts dennoch denselben Output liefern (die Occurrence-Trennung wird über die
// Zähl-Logik geprüft, nicht über unterschiedliche Outputs).
function recordingPromptOps(db: Database.Interface["db"], cost = 0) {
  const prompted: string[] = []
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        const text = input.parts?.[0]?.type === "text" ? input.parts[0].text : ""
        prompted.push(text)
        const last = yield* persistTurns(db, input.sessionID, [
          { cost, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        ])
        return {
          info: last.info,
          parts: [{ type: "text", text: "out:" + text }],
        } as unknown as SessionV1.WithParts
      }),
    cancel: () => Effect.void,
  }
  return { ops, prompted }
}

describe("Workflow", () => {
  // The engine must publish run-lifecycle bus events from persistRun so non-TUI
  // consumers (dashboard, plugins) can observe a run instead of polling. A run
  // crosses persistRun at least once while `running` and once at its terminal
  // transition, so a subscriber must see >=1 `workflow.run.updated` (running)
  // and a final `workflow.run.finished` (completed). The payload is the SLIM
  // shape: `agents` is a COUNT object, never the full array.
  it.instance("publishes workflow.run.updated/finished bus events with a slim payload", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, EVENTS_FIXTURE, EVENTS_WORKFLOW))
      const workflow = yield* Workflow.Service
      const events = yield* EventV2Bridge.Service
      const seen: Array<{ type: string; data: Record<string, unknown> }> = []
      const unsub = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === "workflow.run.updated" || event.type === "workflow.run.finished")
            seen.push({ type: event.type, data: event.data as Record<string, unknown> })
        }),
      )
      yield* Effect.addFinalizer(() => unsub)

      const started = yield* workflow.start({ name: EVENTS_FIXTURE, args: {} })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("events workflow did not finish")))
      expect(done.status).toBe("completed")

      // At least one `running` update was seen during the run.
      const running = seen.filter((e) => e.type === "workflow.run.updated" && e.data["status"] === "running")
      expect(running.length).toBeGreaterThanOrEqual(1)

      // The final event is the terminal `finished` with status completed.
      const last = seen.at(-1) ?? (yield* Effect.fail(new Error("no workflow.run events seen")))
      expect(last.type).toBe("workflow.run.finished")
      expect(last.data["status"]).toBe("completed")

      // Slim payload: the metadata fields plus an `agents` COUNT object (never the
      // full agents array).
      expect(last.data["id"]).toBe(started.id)
      expect(last.data["workflow"]).toBe(EVENTS_FIXTURE)
      expect(last.data["current_phase"]).toBe("run")
      expect(last.data["directory"]).toBe(test.directory)
      expect(last.data["agents"]).toEqual({ total: 0, running: 0, failed: 0 })
      expect(Array.isArray(last.data["agents"])).toBe(false)
    }),
  )

  // Fund 48 (deterministic ordering): the pipeline runs each item's stage SEQUENCE
  // independently — there is NO barrier between stages, so item B can be in stage 2
  // while item A is still in stage 1. Previously proven by sleeping item A 80ms in
  // stage 1 (wall-clock flake); now item A parks on a shared gate in stage 1 and
  // the test waits for B's stage-2 marker (a CONDITION) before releasing A, so the
  // ordering is guaranteed regardless of scheduling speed. Stage 2 also changes the
  // type (string -> { a, b }), proving heterogeneous stages.
  it.instance("pipeline runs stages per item without a barrier and supports heterogeneous types", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PIPELINE_ORDER_FIXTURE, PIPELINE_ORDER_WORKFLOW))
      const workflow = yield* Workflow.Service
      const sync = installBarrier()
      const run = yield* workflow.start({ name: PIPELINE_ORDER_FIXTURE, args: { __barrier: sync.token } })
      // Deterministic proof: wait until B has REACHED stage 2 (while A is still
      // parked in stage 1), then release A so the run can finish.
      yield* sync.awaitOrder("B:stage2")
      sync.barrier.release()
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("pipeline did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as { order: string[]; result: Array<{ a: number; b: string }> }
      // No barrier between stages: B reached stage 2 before A left stage 1.
      expect(result.order.indexOf("B:stage2")).toBeLessThan(result.order.indexOf("A:stage1:done"))
      // Stage 2 changes the type; results stay in item order.
      expect(result.result).toEqual([
        { a: 1, b: "x" },
        { a: 2, b: "y" },
      ])
      delete globalThis.__workflowTestBarriers![sync.token]
    }),
  )

  // Fund 48/49 (deterministic peak): an explicit concurrencyLimit caps the number
  // of simultaneously-running parallel tasks. Previously proven by 6 tasks à ~40ms
  // hoping they overlap; now every task parks on a shared gate and the test polls
  // the live `active` counter, so the measured peak is the engine's real scheduling
  // decision, not a timing window. With limit 2 and 6 tasks exactly 2 tasks are
  // ever parked at once (peak === 2): a lower peak would mean over-clamping, a
  // higher one would mean the limit was ignored.
  it.instance("parallel respects concurrencyLimit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PARALLEL_BARRIER_FIXTURE, PARALLEL_BARRIER_WORKFLOW))
      const workflow = yield* Workflow.Service
      const sync = installBarrier()
      const run = yield* workflow.start({
        name: PARALLEL_BARRIER_FIXTURE,
        args: { __barrier: sync.token, count: 6, concurrencyLimit: 2 },
      })
      // Wait until the limit (2) tasks are simultaneously parked, then release the
      // gate so the whole batch can drain.
      yield* sync.awaitPeak(2)
      sync.barrier.release()
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("parallel did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as { peak: number; result: number[] }
      expect(result.result).toHaveLength(6)
      // Exactly the limit: never above (limit honored) and never below 2 (no
      // accidental over-clamp to 1).
      expect(result.peak).toBe(2)
      delete globalThis.__workflowTestBarriers![sync.token]
    }),
  )

  // P1 (Claude parity): a rejecting parallel task must not fail the whole batch.
  // It resolves to `null` at its position, the surviving tasks keep their values,
  // and the drop is logged (never silent). Before this change the first rejection
  // killed the batch and the run ended `failed`.
  it.instance("parallel drops a rejecting task to null and logs it instead of failing the batch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, PARALLEL_ERROR_FIXTURE, PARALLEL_ERROR_WORKFLOW, "ts"),
      )
      const workflow = yield* Workflow.Service
      const started = yield* workflow.start({ name: PARALLEL_ERROR_FIXTURE, args: {} })
      const waited = yield* workflow.wait({ id: started.id })
      const run = waited.run ?? (yield* Effect.fail(new Error("par-err did not finish")))
      // The batch survives the rejection.
      expect(run.status).toBe("completed")
      expect((run.result as { out: unknown[] }).out).toEqual(["ok-1", null, "ok-3"])
      // The drop is logged, never silent — and carries the rejection's message.
      const dropLog = run.logs.find((l) => l.message.includes("parallel task 2 dropped"))
      expect(dropLog?.message).toContain("boom")
    }),
  )

  // P2 (Claude parity): a throwing stage in ctx.pipeline must not fail the whole
  // pipeline — it drops ONLY that item to `null` at its position and skips that
  // item's remaining stages; the other items run every stage to completion, and
  // the drop is logged (never silent). Before this change the first throwing item
  // aborted the whole pipeline and the run ended `failed`.
  it.instance("pipeline drops only the throwing item to null and skips its remaining stages", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, PIPELINE_ERROR_FIXTURE, PIPELINE_ERROR_WORKFLOW, "ts"),
      )
      const workflow = yield* Workflow.Service
      const started = yield* workflow.start({ name: PIPELINE_ERROR_FIXTURE, args: {} })
      const waited = yield* workflow.wait({ id: started.id })
      const run = waited.run ?? (yield* Effect.fail(new Error("pipe-err did not finish")))
      expect(run.status).toBe("completed")
      const r = run.result as { out: unknown[]; calls: string[] }
      expect(r.out).toEqual([11, null, 31]) // only item 2 dropped
      expect(r.calls).not.toContain("s2:2") // item 2's remaining stages skipped
      expect(
        run.logs.some((l) => l.message.includes("pipeline item 2 dropped") && l.message.includes("stage1-boom")),
      ).toBe(true)
    }),
  )

  // Fund 49 (default parallel concurrency): `ctx.parallel` WITHOUT an explicit
  // concurrencyLimit clamps to the documented default of 20
  // (`Math.max(1, options?.concurrencyLimit ?? 20)` in createContext). With 25
  // tasks all parked on the gate, exactly 20 run at once — peak === 20, never 25
  // (would mean unbounded) and never 1 (would mean over-clamped). Deterministic via
  // the parked-task counter, no timing window.
  it.instance("parallel without an explicit limit defaults to a peak concurrency of 20", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PARALLEL_BARRIER_FIXTURE, PARALLEL_BARRIER_WORKFLOW))
      const workflow = yield* Workflow.Service
      const sync = installBarrier()
      // 25 tasks, NO concurrencyLimit ⇒ engine default 20.
      const run = yield* workflow.start({
        name: PARALLEL_BARRIER_FIXTURE,
        args: { __barrier: sync.token, count: 25 },
      })
      // Exactly the default (20) tasks become parked simultaneously; the remaining
      // 5 wait for a slot. Wait for that peak, then drain.
      yield* sync.awaitPeak(20)
      // The peak must not climb past the default even given a moment to settle: a
      // 21st parked task would mean the default cap was not applied.
      expect(sync.barrier.active).toBe(20)
      sync.barrier.release()
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("parallel did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as { peak: number; result: number[] }
      expect(result.result).toHaveLength(25)
      expect(result.peak).toBe(20)
      delete globalThis.__workflowTestBarriers![sync.token]
    }),
  )

  // Fund 49 (parallel limit floor): an explicit concurrencyLimit of 0 (and any
  // negative value) is floored to 1 — `Math.max(1, …)` — so the batch runs strictly
  // sequentially (peak === 1) rather than degenerating into "no tasks run" or
  // unbounded. Consistency guard for the clamp.
  it.instance("parallel concurrencyLimit 0 and negative are clamped to a peak of 1", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PARALLEL_BARRIER_FIXTURE, PARALLEL_BARRIER_WORKFLOW))
      const workflow = yield* Workflow.Service
      for (const limit of [0, -5]) {
        const sync = installBarrier()
        const run = yield* workflow.start({
          name: PARALLEL_BARRIER_FIXTURE,
          args: { __barrier: sync.token, count: 4, concurrencyLimit: limit },
        })
        // Only ONE task is ever parked at a time; release it so the next can run.
        yield* sync.awaitPeak(1)
        expect(sync.barrier.active).toBe(1)
        sync.barrier.release()
        const waited = yield* workflow.wait({ id: run.id })
        const done = waited.run ?? (yield* Effect.fail(new Error(`parallel(${limit}) did not finish`)))
        expect(done.status).toBe("completed")
        const result = done.result as { peak: number; result: number[] }
        expect(result.result).toHaveLength(4)
        expect(result.peak).toBe(1)
        delete globalThis.__workflowTestBarriers![sync.token]
      }
    }),
  )

  // Fund 49 (default pipeline concurrency): `ctx.pipeline` WITHOUT options runs its
  // items UNBOUNDED (the pipeline default differs from parallel's 20 — see
  // createContext: `options?.concurrencyLimit === undefined ? "unbounded" : …`). With
  // 25 items all parked in the single stage, ALL 25 run concurrently — peak === 25.
  it.instance("pipeline without options runs items unbounded", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PIPELINE_BARRIER_FIXTURE, PIPELINE_BARRIER_WORKFLOW))
      const workflow = yield* Workflow.Service
      const sync = installBarrier()
      const run = yield* workflow.start({
        name: PIPELINE_BARRIER_FIXTURE,
        args: { __barrier: sync.token, count: 25 },
      })
      // Unbounded ⇒ every item parks at once; the peak equals the item count.
      yield* sync.awaitPeak(25)
      expect(sync.barrier.active).toBe(25)
      sync.barrier.release()
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("pipeline did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as { peak: number; result: number[] }
      expect(result.result).toHaveLength(25)
      expect(result.peak).toBe(25)
      delete globalThis.__workflowTestBarriers![sync.token]
    }),
  )

  // Fund 49 (pipeline limit floor): a pipeline concurrencyLimit of 0 is floored to 1
  // (same `Math.max(1, …)` clamp as parallel), so items run strictly one at a time
  // (peak === 1) instead of unbounded — only an UNSET limit means unbounded.
  it.instance("pipeline concurrencyLimit 0 is clamped to a peak of 1", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PIPELINE_BARRIER_FIXTURE, PIPELINE_BARRIER_WORKFLOW))
      const workflow = yield* Workflow.Service
      const sync = installBarrier()
      const run = yield* workflow.start({
        name: PIPELINE_BARRIER_FIXTURE,
        args: { __barrier: sync.token, count: 4, concurrencyLimit: 0 },
      })
      yield* sync.awaitPeak(1)
      expect(sync.barrier.active).toBe(1)
      sync.barrier.release()
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("pipeline did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as { peak: number; result: number[] }
      expect(result.result).toHaveLength(4)
      expect(result.peak).toBe(1)
      delete globalThis.__workflowTestBarriers![sync.token]
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
      yield* Effect.promise(() => writeWorkflow(test.directory, DETACHED_AGENT_FIXTURE, DETACHED_AGENT_WORKFLOW))
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
      // Fund 51: per-agent cost/tokens (incl. the optional `total`) survive the
      // DB→fromRow roundtrip intact — not just output/status.
      expect(persisted.agents[0]?.cost).toBe(0.42)
      expect(persisted.agents[0]?.tokens).toEqual({
        total: 99,
        input: 11,
        output: 22,
        reasoning: 33,
        cache: { read: 44, write: 55 },
      })
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
      for (const internal of [
        "directory",
        "done",
        "runScope",
        "fiber",
        "sessions",
        "cancelSession",
        "cancelling",
        "removed",
        "budget",
        "budgetRemaining",
      ]) {
        expect(internal in liveAny).toBe(false)
      }
      // Exakt die deklarierten Run-Schlüssel (Teilmenge: optionale können fehlen).
      const allowed = new Set([
        "id",
        "session_id",
        "workflow",
        "args",
        "definition",
        "status",
        "started_at",
        "completed_at",
        "current_phase",
        "logs",
        "agents",
        "result",
        "error",
        "resume_of",
      ])
      for (const key of Object.keys(liveAny))
        expect(allowed.has(key)).toBe(true)

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
      yield* Effect.promise(() => writeWorkflow(test.directory, AGENT_THEN_HANG_FIXTURE, AGENT_THEN_HANG_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({ name: AGENT_THEN_HANG_FIXTURE, args: {}, prompt: tokensPromptOps(db) })

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
      yield* Effect.promise(() => writeWorkflow(test.directory, CIRCULAR_RESULT_FIXTURE, CIRCULAR_RESULT_WORKFLOW))
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
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          HELLO_FIXTURE,
          `export const meta = { name: "Hello" }
export async function run(args, ctx) { ctx.setPhase("run"); return { value: args.value } }
`,
        ),
      )
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
        db
          .run(
            sql`INSERT INTO ${WorkflowRunTable} (id, workflow, directory, status, started_at, completed_at, logs, agents, result, time_created, time_updated)
              VALUES (${id}, ${HELLO_FIXTURE}, ${test.directory}, 'completed', ${now}, ${now}, '[]', '[]', ${raw}, ${now}, ${now})`,
          )
          .pipe(Effect.orDie)
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

  // Fund 25 (a): wait() on a still-RUNNING run with a small timeout times out
  // honestly — `timedOut: true`, the snapshot status stays `running`, and the run
  // is NOT mutated by the timeout. Deterministic: the run is parked on a barrier
  // (genuinely live in the registry, never released until after the assertion), so
  // the timeout is the ONLY thing that ends the wait — no race with the body
  // completing. The barrier is released afterwards so the run can drain.
  it.instance("wait with a small timeout on a hanging run returns timedOut with status still running", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PARALLEL_BARRIER_FIXTURE, PARALLEL_BARRIER_WORKFLOW))
      const workflow = yield* Workflow.Service
      const sync = installBarrier()
      const run = yield* workflow.start({ name: PARALLEL_BARRIER_FIXTURE, args: { __barrier: sync.token, count: 1 } })
      // Ensure the run is genuinely live and parked (the single task is at the gate)
      // before testing the timeout, so wait() cannot resolve via completion.
      yield* sync.awaitPeak(1)

      const res = yield* workflow.wait({ id: run.id, timeout: 50 })
      expect(res.timedOut).toBe(true)
      // The snapshot reports the live status (still running); the timeout did not
      // flip or finish the run.
      expect(res.run?.status).toBe("running")
      // The run is still live and running afterwards (the timeout is observation-only).
      const stillLive = yield* workflow.get(run.id)
      expect(stillLive?.status).toBe("running")

      // Release the gate so the run finishes, then drain it.
      sync.barrier.release()
      const waited = yield* workflow.wait({ id: run.id })
      expect(waited.timedOut).toBe(false)
      expect(waited.run?.status).toBe("completed")
      delete globalThis.__workflowTestBarriers![sync.token]
    }),
  )

  // Fund 25 (b): wait() with timeout <= 0 returns an IMMEDIATE snapshot
  // (`timedOut: true`) without ever suspending on the run's done deferred — a
  // zero/negative timeout must not hang on a still-running run. Proven by parking
  // the run on a barrier (so it is genuinely running) and asserting wait({timeout:0})
  // returns at once with the running snapshot; a hung implementation would never
  // return because the gate is still closed.
  it.instance("wait with timeout <= 0 returns an immediate running snapshot without hanging", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PARALLEL_BARRIER_FIXTURE, PARALLEL_BARRIER_WORKFLOW))
      const workflow = yield* Workflow.Service
      const sync = installBarrier()
      const run = yield* workflow.start({ name: PARALLEL_BARRIER_FIXTURE, args: { __barrier: sync.token, count: 1 } })
      yield* sync.awaitPeak(1)

      for (const timeout of [0, -10]) {
        // awaitWithTimeout proves the call RETURNS promptly (no hang on the closed
        // gate); a non-short-circuiting implementation would block here forever.
        const res = yield* awaitWithTimeout(
          workflow.wait({ id: run.id, timeout }),
          `wait({timeout:${timeout}}) hung on a still-running run`,
          "2 seconds",
        )
        expect(res.timedOut).toBe(true)
        expect(res.run?.status).toBe("running")
      }

      sync.barrier.release()
      yield* workflow.wait({ id: run.id })
      delete globalThis.__workflowTestBarriers![sync.token]
    }),
  )

  it.instance("schema agent failure is recorded as failed, never silently completed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, SCHEMA_FAILING_FIXTURE, schemaWorkflow(SCHEMA_FAILING_FIXTURE)),
      )
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: SCHEMA_FAILING_FIXTURE,
        args: {},
        prompt: structuredPromptOps(db, "error"),
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
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: SCHEMA_UNDEFINED_FIXTURE,
        args: {},
        prompt: structuredPromptOps(db, "undefined"),
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
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: SCHEMA_SUCCESS_FIXTURE,
        args: {},
        prompt: structuredPromptOps(db, "structured"),
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
      const { db } = yield* Database.Service
      // Budget 1.0 USD, jeder Step kostet 1.0 — nach Step 1 ist das Budget
      // erschöpft (Rest 0), also scheitert der zweite ctx.agent am Gate.
      const run = yield* workflow.start({
        name: BUDGET_FIXTURE,
        args: {},
        prompt: costPromptOps(db, 1),
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

  // Fund 23 (best-effort soft cap under parallelism): the budget is enforced PER
  // STEP, checked BEFORE each ctx.agent and settled AFTER it. Steps launched
  // together via ctx.parallel all pass the gate while the budget is still positive,
  // so a run can OVERSPEND by the combined cost of the steps already in flight when
  // the budget runs out — documented soft-cap behavior, not a hard mid-step limit.
  // Deterministic proof: a Deferred barrier holds all 3 parallel prompts until ALL
  // have passed the gate, then releases them so they all charge. With budget 1.0 and
  // 3 parallel steps à 0.5 (total 1.5), the budget overspends to -0.5; the NEXT
  // (sequential) step then fails the exhausted-budget gate.
  it.instance("parallel steps all pass the gate and overspend; the next step fails (soft cap)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, BUDGET_PARALLEL_FIXTURE, BUDGET_PARALLEL_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      // 3 parallel agents à 0.5 USD, budget 1.0. All 3 pass the gate while the
      // budget is positive (the barrier holds them until all 3 have arrived), so
      // all 3 charge ⇒ overspend to -0.5.
      const run = yield* workflow.start({
        name: BUDGET_PARALLEL_FIXTURE,
        args: { count: 3 },
        prompt: budgetBarrierPromptOps(db, 0.5, 3),
        budget: 1,
      })
      const done = yield* workflow.wait({ id: run.id })
      // The run COMPLETES — the workflow body catches the post-batch budget failure.
      expect(done.run?.status).toBe("completed")
      const result = done.run?.result as { overspent: number; nextStarted: boolean; nextFailed: boolean }
      // Soft-cap overspend: all 3 parallel steps charged, driving the budget below 0.
      expect(result.overspent).toBeCloseTo(-0.5, 10)
      // All 3 parallel steps were charged (completed) — the documented overspend.
      const completed = done.run?.agents.filter((a) => a.status === "completed") ?? []
      expect(completed.length).toBe(3)
      const totalCost = completed.reduce((sum, a) => sum + (a.cost ?? 0), 0)
      expect(totalCost).toBeCloseTo(1.5, 10)
      // The NEXT (sequential) step after exhaustion hits the gate and fails.
      expect(result.nextStarted).toBe(true)
      expect(result.nextFailed).toBe(true)
      // The blocked 4th step never created a node (refused before dispatch).
      expect(done.run?.agents.length).toBe(3)
    }),
  )

  it.instance("budgetRemaining reflects real spend during the run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, BUDGET_REMAINING_FIXTURE, BUDGET_REMAINING_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: BUDGET_REMAINING_FIXTURE,
        args: {},
        prompt: costPromptOps(db, 0.25),
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

  // Fund N12 (high): a single ctx.agent step whose child session runs SEVERAL
  // provider turns (the normal case once the subagent uses tools) persists one
  // assistant message per turn, each with its own cost/tokens, but the runner
  // RETURNS only the last. Charging that last message alone discarded every
  // intermediate turn — under-reporting per-agent telemetry AND under-counting the
  // budget. The engine must sum cost/tokens across ALL assistant messages of the
  // child session: cost 0.01 + 0.02 + 0.03 = 0.06 (not just the final 0.03), tokens
  // summed field-wise, and the budget decremented by the full 0.06.
  it.instance("a multi-turn agent step charges the SUM of all turns, not just the last", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, BUDGET_REMAINING_FIXTURE, BUDGET_REMAINING_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: BUDGET_REMAINING_FIXTURE,
        args: {},
        prompt: multiTurnPromptOps(db, [
          { cost: 0.01, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } },
          { cost: 0.02, tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } } },
          { cost: 0.03, tokens: { input: 100, output: 200, reasoning: 300, cache: { read: 400, write: 500 } } },
        ]),
        budget: 1,
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      // Per-agent telemetry reflects the FULL multi-turn spend (0.06), not 0.03.
      const node = done.run!.agents[0]!
      expect(node.cost).toBeCloseTo(0.06, 10)
      expect(node.tokens).toEqual({ input: 111, output: 222, reasoning: 333, cache: { read: 444, write: 555 } })
      // Budget decremented by the SUM (1 - 0.06 = 0.94), observed live mid-run.
      const result = done.run?.result as { before: number; after: number }
      expect(result.before).toBe(1)
      expect(result.after).toBeCloseTo(0.94, 10)
    }),
  )

  // Fund 51 (telemetry populated from the assistant message): an agent step whose
  // session returns NON-null cost/tokens (including the optional `tokens.total`)
  // must have that telemetry copied onto the agent node — `run.agents[0].cost` and
  // `run.agents[0].tokens` (with `total`) reflect exactly what the assistant message
  // carried. A single-turn session yields exactly one assistant message, so the
  // node equals that message's telemetry verbatim (no summing artifact).
  it.instance("agent telemetry (cost + tokens incl. total) is populated from the assistant message", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SINGLE_AGENT_FIXTURE, SINGLE_AGENT_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: SINGLE_AGENT_FIXTURE,
        args: {},
        // A single turn with non-null cost AND a non-null tokens.total so a dropped
        // field would be observable.
        prompt: multiTurnPromptOps(db, [
          { cost: 0.17, tokens: { total: 60, input: 10, output: 20, reasoning: 30, cache: { read: 5, write: 7 } } },
        ]),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      const node = done.run!.agents[0]!
      expect(node.cost).toBeCloseTo(0.17, 10)
      // The whole tokens shape, including the summed-but-single `total`, is carried.
      expect(node.tokens).toEqual({ total: 60, input: 10, output: 20, reasoning: 30, cache: { read: 5, write: 7 } })
    }),
  )

  it.instance("no budget set means unlimited (Infinity) — unchanged default", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, BUDGET_UNLIMITED_FIXTURE, BUDGET_UNLIMITED_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: BUDGET_UNLIMITED_FIXTURE,
        args: {},
        prompt: costPromptOps(db, 5),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      expect((done.run?.result as { unlimited: boolean }).unlimited).toBe(true)
    }),
  )

  // ctx.budget (Claude-Code-Parität) neben ctx.budgetRemaining: mit gesetztem
  // Budget liefert total den Startwert, spent() den bisher ausgegebenen Betrag
  // (0 ohne Agent-Step) und remaining() den Rest (== total bei spent()===0).
  it.instance("ctx.budget exposes total/spent()/remaining() when started with a budget", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, BUDGET_API_FIXTURE, BUDGET_API_WORKFLOW))
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: BUDGET_API_FIXTURE, args: {}, budget: 5 })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      const result = done.run?.result as { total: number; spent: number; remaining: number }
      expect(result.total).toBe(5)
      expect(result.spent).toBe(0)
      expect(result.remaining).toBe(5)
    }),
  )

  // Ohne Budget: ctx.budget.total ist null und remaining() ist Infinity (nicht
  // endlich). Infinity überlebt JSON nicht, deshalb prüft das Fixture per Boolean.
  it.instance("ctx.budget.total is null and remaining() is Infinity without a budget", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, BUDGET_API_UNLIMITED_FIXTURE, BUDGET_API_UNLIMITED_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: BUDGET_API_UNLIMITED_FIXTURE, args: {} })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      const result = done.run?.result as { total: number | null; remainingFinite: boolean }
      expect(result.total).toBe(null)
      expect(result.remainingFinite).toBe(false)
    }),
  )

  it.instance("a failed-but-paid step still charges the budget by its actual cost", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, BUDGET_FAILED_PAID_FIXTURE, BUDGET_FAILED_PAID_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      // Schema-Agent scheitert (kein strukturiertes Ergebnis), hat aber 0.3 USD
      // gekostet. Der Workflow fängt den Fehler ab und läuft weiter.
      const run = yield* workflow.start({
        name: BUDGET_FAILED_PAID_FIXTURE,
        args: {},
        prompt: structuredPromptOps(db, "error", 0.3),
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

  // Fund 19 (medium): deklarierte Argument-Typen werden an der Engine-Grenze
  // erzwungen, VOR module.run. Ein String-Wert "42" für ein als `number`
  // deklariertes Argument erreicht run() als die Zahl 42; "true" für ein als
  // `boolean` deklariertes Argument als der Boolean true. Das deckt ALLE
  // Start-Pfade ab (HTTP-JSON-args, Tool, TUI), weil die Koerzierung zentral in
  // start() sitzt. Nicht deklarierte args (`bare`) bleiben unverändert.
  it.instance("declared number/boolean argument types are coerced from strings before run()", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, COERCE_FIXTURE, COERCE_WORKFLOW))
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({
        name: COERCE_FIXTURE,
        // String-eingehende args, wie sie über HTTP-JSON oder die TUI ankommen.
        args: { count: "42", flag: "true", label: 99, bare: { keep: 1 } },
      })
      const done = (yield* workflow.wait({ id: run.id })).run ?? (yield* Effect.fail(new Error("did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as Record<string, unknown>
      // number-Deklaration: "42" -> 42 (echte Zahl).
      expect(result.count).toBe(42)
      expect(result.countType).toBe("number")
      // boolean-Deklaration: "true" -> true (echter Boolean).
      expect(result.flag).toBe(true)
      expect(result.flagType).toBe("boolean")
      // string-Deklaration: ein primitiver Nicht-String (99) wird via String(...)
      // zu "99" koerziert.
      expect(result.label).toBe("99")
      expect(result.labelType).toBe("string")
      // Nicht deklariertes Argument bleibt unverändert durchgereicht.
      expect(result.bare).toEqual({ keep: 1 })
      expect(result.bareType).toBe("object")
    }),
  )

  // Fund 19 (medium): ein als `number` deklariertes Argument mit einem nicht
  // konvertierbaren String ("abc") scheitert mit einem InvalidError an der
  // Engine-Grenze — der Run startet NICHT (kein verwirrender NaN, der erst im
  // Workflow-Body auffliegt).
  it.instance("an unconvertible value for a declared number argument fails with InvalidError", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, COERCE_FIXTURE, COERCE_WORKFLOW))
      const workflow = yield* Workflow.Service
      const failed = yield* workflow.start({ name: COERCE_FIXTURE, args: { count: "abc" } }).pipe(Effect.flip)
      expect(failed._tag).toBe("WorkflowInvalidError")
      const invalid =
        failed instanceof Workflow.InvalidError ? failed : yield* Effect.fail(new Error("expected InvalidError"))
      expect(invalid.message).toMatch(/count/)
    }),
  )

  // Fund 19 (medium): ein als `boolean` deklariertes Argument akzeptiert nur
  // "true"/"false"; alles andere scheitert mit InvalidError.
  it.instance("an unconvertible value for a declared boolean argument fails with InvalidError", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, COERCE_FIXTURE, COERCE_WORKFLOW))
      const workflow = yield* Workflow.Service
      const failed = yield* workflow.start({ name: COERCE_FIXTURE, args: { flag: "maybe" } }).pipe(Effect.flip)
      expect(failed._tag).toBe("WorkflowInvalidError")
    }),
  )

  // Review-Fund 3i.1 (IMPORTANT): ein leerer / nur aus Whitespace bestehender
  // String darf für ein number-Argument NICHT still zu 0 koerzieren
  // (`Number("") === 0`, `Number("  ") === 0` — beide finite und würden sonst
  // durchschlüpfen). Beide müssen wie "abc" mit InvalidError scheitern.
  it.instance("empty / whitespace-only string for a declared number argument fails with InvalidError", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, COERCE_FIXTURE, COERCE_WORKFLOW))
      const workflow = yield* Workflow.Service
      for (const bad of ["", "  ", "\t\n"]) {
        const failed = yield* workflow.start({ name: COERCE_FIXTURE, args: { count: bad } }).pipe(Effect.flip)
        expect(failed._tag).toBe("WorkflowInvalidError")
        const invalid =
          failed instanceof Workflow.InvalidError ? failed : yield* Effect.fail(new Error("expected InvalidError"))
        expect(invalid.message).toMatch(/count/)
      }
    }),
  )

  // Review-Fund 3i.1 (IMPORTANT): non-string, non-number Werte (null, ein Objekt,
  // ein Boolean) für ein number-Argument dürfen nicht als NaN/true durchschlüpfen
  // — sie müssen sauber mit InvalidError scheitern, bevor run() startet.
  it.instance("non-string non-number value for a declared number argument fails with InvalidError", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, COERCE_FIXTURE, COERCE_WORKFLOW))
      const workflow = yield* Workflow.Service
      for (const bad of [null, {}, [], true] as const) {
        const failed = yield* workflow.start({ name: COERCE_FIXTURE, args: { count: bad } }).pipe(Effect.flip)
        expect(failed._tag).toBe("WorkflowInvalidError")
      }
    }),
  )

  // Review-Fund 3i.4 (LOW): wir akzeptieren bewusst die volle `Number()`-Semantik
  // inkl. Hex ("0x10" -> 16) und Exponent ("1e3" -> 1000) — siehe Doc-Kommentar
  // an coerceArgs. Das ist die geringste Überraschung für JSON/HTTP-Zahlen und
  // konsistent mit dem Rest der numerischen Koerzierung.
  it.instance("hex and exponent numeric strings are accepted via Number() for a declared number argument", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, COERCE_FIXTURE, COERCE_WORKFLOW))
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: COERCE_FIXTURE, args: { count: "0x10" } })
      const done = (yield* workflow.wait({ id: run.id })).run ?? (yield* Effect.fail(new Error("did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as Record<string, unknown>
      expect(result.count).toBe(16)
      expect(result.countType).toBe("number")
    }),
  )

  // Review-Fund 3i.3 (LOW): ein deklarierter STRING-Default ("7") für ein
  // number-Argument wird durch denselben Koerzierungspfad geschickt — run() sieht
  // die Zahl 7, nicht den rohen String "7". Gleiches für den boolean-Default.
  it.instance("declared string-shaped defaults are coerced to their declared type before run()", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, STRING_DEFAULT_FIXTURE, STRING_DEFAULT_WORKFLOW))
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: STRING_DEFAULT_FIXTURE, args: {} })
      const done = (yield* workflow.wait({ id: run.id })).run ?? (yield* Effect.fail(new Error("did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as Record<string, unknown>
      expect(result.count).toBe(7)
      expect(result.countType).toBe("number")
      expect(result.flag).toBe(true)
      expect(result.flagType).toBe("boolean")
    }),
  )

  // Fund 20 (medium): deklarierte Defaults greifen, wenn ein Argument NICHT
  // übergeben wird — run() sieht den typ-korrekten Default.
  it.instance("declared defaults are applied when an argument is not supplied", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, DEFAULT_FIXTURE, DEFAULT_WORKFLOW))
      const workflow = yield* Workflow.Service
      // Gar keine args übergeben: alle drei Defaults müssen einspringen.
      const run = yield* workflow.start({ name: DEFAULT_FIXTURE, args: {} })
      const done = (yield* workflow.wait({ id: run.id })).run ?? (yield* Effect.fail(new Error("did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as Record<string, unknown>
      expect(result.name).toBe("x")
      expect(result.nameType).toBe("string")
      expect(result.count).toBe(7)
      expect(result.countType).toBe("number")
      expect(result.flag).toBe(true)
      expect(result.flagType).toBe("boolean")
    }),
  )

  // Fund 20 (medium): ein explizit übergebener Wert gewinnt über den Default und
  // wird dabei dennoch gemäß dem deklarierten Typ koerziert.
  it.instance("an explicitly supplied argument wins over its declared default (and is still coerced)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, DEFAULT_FIXTURE, DEFAULT_WORKFLOW))
      const workflow = yield* Workflow.Service
      // count explizit als String "3" übergeben: gewinnt über default 7 und wird
      // zu 3 koerziert. name/flag fallen auf ihre Defaults zurück.
      const run = yield* workflow.start({ name: DEFAULT_FIXTURE, args: { count: "3" } })
      const done = (yield* workflow.wait({ id: run.id })).run ?? (yield* Effect.fail(new Error("did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as Record<string, unknown>
      expect(result.count).toBe(3)
      expect(result.countType).toBe("number")
      // Die nicht übergebenen behalten ihre Defaults.
      expect(result.name).toBe("x")
      expect(result.flag).toBe(true)
    }),
  )

  // #26514 regression / Fund N9 (security): a workflow subagent MUST inherit the
  // caller's deny/external_directory rules (and the caller agent's edit-class
  // denies, i.e. Plan Mode) — the same ruleset the task tool derives. Before the
  // fix the engine spawned the child session with NO `permission`, so a parent
  // `edit: deny` (Plan Mode) or `external_directory` confinement silently leaked.
  it.instance("workflow subagent inherits the caller session's deny/external_directory rules", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SINGLE_AGENT_FIXTURE, SINGLE_AGENT_WORKFLOW))
      const workflow = yield* Workflow.Service
      const sessions = yield* Session.Service

      // The caller session carries the exact rules a Plan-Mode / confined parent
      // would: an edit deny and an external_directory rule. The fix must forward
      // both onto every subagent session the run spawns.
      const caller = yield* sessions.create({
        title: "Caller",
        permission: [
          { permission: "edit", pattern: "**", action: "deny" },
          { permission: "external_directory", pattern: "/outside/**", action: "allow" },
        ],
      })

      const run = yield* workflow.start({
        name: SINGLE_AGENT_FIXTURE,
        args: {},
        prompt: immediatePromptOps(),
        caller: { sessionID: caller.id, agent: "build" },
      })
      const done = (yield* workflow.wait({ id: run.id })).run ?? (yield* Effect.fail(new Error("did not finish")))
      expect(done.status).toBe("completed")

      const childSessionID = done.agents[0]?.session_id
      expect(childSessionID).toBeDefined()
      // The projector persists the session row off the Created event, so poll the
      // read until the row (and its derived permission) is visible. A not-yet-
      // projected row fails get() with NotFound → map to undefined to keep polling.
      const child = yield* pollWithTimeout(
        sessions.get(SessionID.make(childSessionID!)).pipe(
          Effect.map((s) => (s.permission ? s : undefined)),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
        "child session permission never populated",
      )
      const rules = child.permission ?? []
      // Core security assertion: the caller's deny + external_directory rules are
      // present on the child (regression of #26514 would leave these absent).
      expect(rules).toContainEqual({ permission: "edit", pattern: "**", action: "deny" })
      expect(rules).toContainEqual({ permission: "external_directory", pattern: "/outside/**", action: "allow" })
    }),
  )

  // Security (compose, never override): per-step tool scoping must NEVER re-grant
  // a tool the inherited subagent permission denies. A caller in Plan Mode denies
  // `edit`; the step passes `tools: { edit: true }`.
  //
  // Before the fix, per-step tools were routed ONLY through PromptInput.tools,
  // whose prompt-loop handler does a FULL ASSIGNMENT `session.permission =
  // [tools→rules]` — clobbering the derived ruleset and re-enabling `edit` for the
  // step. After the fix, when a caller-derived permission exists the per-step
  // tools are instead COMPOSED into the child session's `permission` at creation,
  // placed BEFORE the derived denies so (under last-match-wins evaluation) an
  // inherited deny always beats a per-step grant — and the tools are NO LONGER
  // passed to prompt.prompt (so the clobbering assignment can't fire).
  //
  // Observability: the workflow tests inject fake prompt-ops, so the regression's
  // runtime clobber can't be seen via the prompt loop. We instead assert the two
  // fix-visible facts directly: (1) the composed child-session `permission`
  // CONTAINS the per-step edit grant yet still evaluates `edit` to deny (the
  // inherited deny wins by ordering); (2) the captured PromptInput carries NO
  // `tools` for this step (the engine stopped routing through the clobber path).
  // Both are FALSE before the fix: (1) the create permission never held the
  // per-step rule, and (2) `tools` was passed straight to prompt.prompt.
  it.instance("per-step tools cannot re-grant an inherited-denied tool (deny wins)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, TOOLS_REGRANT_FIXTURE, TOOLS_REGRANT_WORKFLOW))
      const workflow = yield* Workflow.Service
      const sessions = yield* Session.Service
      const { ops, inputs } = capturingPromptOps()

      // A Plan-Mode-style caller: edit is denied on the parent session.
      const caller = yield* sessions.create({
        title: "Caller",
        permission: [{ permission: "edit", pattern: "**", action: "deny" }],
      })

      const run = yield* workflow.start({
        name: TOOLS_REGRANT_FIXTURE,
        args: {},
        prompt: ops,
        caller: { sessionID: caller.id, agent: "build" },
      })
      const done = (yield* workflow.wait({ id: run.id })).run ?? (yield* Effect.fail(new Error("did not finish")))
      expect(done.status).toBe("completed")

      const childSessionID = done.agents[0]?.session_id
      expect(childSessionID).toBeDefined()
      const child = yield* pollWithTimeout(
        sessions.get(SessionID.make(childSessionID!)).pipe(
          Effect.map((s) => (s.permission ? s : undefined)),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
        "child session permission never populated",
      )
      const rules = child.permission ?? []
      // The inherited edit deny is still present...
      expect(rules).toContainEqual({ permission: "edit", pattern: "**", action: "deny" })
      // ...the per-step grant was COMPOSED into the SAME ruleset (proving tools
      // were folded into sessions.create, not routed to the clobbering prompt path)...
      const grantIdx = rules.findIndex((r) => r.permission === "edit" && r.action === "allow")
      const denyIdx = rules.findIndex((r) => r.permission === "edit" && r.action === "deny")
      expect(grantIdx).toBeGreaterThanOrEqual(0)
      // ...ordered BEFORE the inherited deny (last-match-wins ⇒ deny is later ⇒ deny wins)...
      expect(grantIdx).toBeLessThan(denyIdx)
      // ...so `edit` evaluates to deny despite the per-step `tools: { edit: true }`.
      expect(Permission.evaluate("edit", "anything.ts", rules).action).toBe("deny")
      // And the per-step tools were NOT routed to prompt.prompt (no clobber path).
      expect(inputs.length).toBe(1)
      expect(inputs[0]?.tools).toBeUndefined()
    }),
  )

  // Fallback (documented behavior): a programmatic start with NO caller context
  // keeps the prior behavior — the child session carries no derived `permission`.
  it.instance("workflow subagent has no inherited ruleset when no caller context is supplied", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SINGLE_AGENT_FIXTURE, SINGLE_AGENT_WORKFLOW))
      const workflow = yield* Workflow.Service
      const sessions = yield* Session.Service

      const run = yield* workflow.start({
        name: SINGLE_AGENT_FIXTURE,
        args: {},
        prompt: immediatePromptOps(),
      })
      const done = (yield* workflow.wait({ id: run.id })).run ?? (yield* Effect.fail(new Error("did not finish")))
      expect(done.status).toBe("completed")

      const childSessionID = done.agents[0]?.session_id
      expect(childSessionID).toBeDefined()
      // No caller ⇒ no derived ruleset. The session row exists (the run created
      // it), but its `permission` column stays unset (fromRow → undefined). Poll
      // until the row is visible (NotFound → undefined keeps polling), then assert
      // no permission was stored.
      const child = yield* pollWithTimeout(
        sessions.get(SessionID.make(childSessionID!)).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
        "child session never created",
      )
      expect(child.permission).toBeUndefined()
    }),
  )

  // Fund 18 (medium): die drei Workflow-Zeitfelder (LogEntry.time,
  // AgentRun.started_at/completed_at) sind Epoch-Millis und damit IMMER endlich.
  // Als `Schema.Number` erzeugte der SDK-Generator für sie eine NaN/Infinity-
  // String-Union (`number | "NaN" | "Infinity" | ...`), ein unehrlicher
  // Wire-Typ. Nach der Umstellung auf `Schema.Finite` dürfen die generierten
  // SDK-Typen für diese Felder KEINE String-Varianten mehr tragen — sie sind
  // schlicht `number`. Wir greppen die erzeugte types.gen.ts (statisch, kein
  // Laufzeit-Roundtrip nötig).
  test("generated SDK types for workflow time fields are plain numbers, no NaN-string variants", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "..", "..", "..", "sdk", "js", "src", "v2", "gen", "types.gen.ts"),
    ).text()
    // Hilfsextraktor: die Zeile, die ein Feld innerhalb eines benannten Typs
    // deklariert, anhand des Typ-Headers + Feldnamens.
    const fieldLine = (typeName: string, field: string) => {
      const block = source.slice(source.indexOf(`export type ${typeName} = {`))
      const line = block
        .split("\n")
        .find((l) => l.trimStart().startsWith(`${field}:`) || l.trimStart().startsWith(`${field}?:`))
      return line ?? ""
    }
    for (const [typeName, field] of [
      ["WorkflowLogEntry", "time"],
      ["WorkflowAgentRun", "started_at"],
      ["WorkflowAgentRun", "completed_at"],
    ] as const) {
      const line = fieldLine(typeName, field)
      expect(line).toContain("number")
      // Keine NaN/Infinity-String-Variante mehr.
      expect(line).not.toContain('"NaN"')
      expect(line).not.toContain('"Infinity"')
    }
  })

  // Track C: Builtin-Workflows als niedrigste Präzedenz-Wurzel (Projekt > Global >
  // Builtin). Ohne gleichnamige Projekt-/Global-Datei MUSS der gebündelte
  // deep-research-Workflow auftauchen, statisch lesbare Meta tragen und als
  // `source_kind: "builtin"` markiert sein. Sein `path` ist ein synthetischer
  // Marker (`builtin:deep-research`), kein echter Dateipfad.
  it.instance("the bundled deep-research workflow is discovered as a builtin with static meta", () =>
    Effect.gen(function* () {
      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      const info = list.find((item) => item.name === "deep-research")
      if (!info) return yield* Effect.fail(new Error("deep-research builtin not discovered"))
      expect(info.valid).toBe(true)
      expect(info.source_kind).toBe("builtin")
      expect(info.path).toBe("builtin:deep-research")
      // Meta wurde rein statisch (ohne Modul-Ausführung) gelesen.
      expect(info.meta.name).toBe("deep-research")
      expect(info.meta.phases).toEqual(["plan", "research", "verify", "synthesize"])
      expect(info.meta.arguments?.question?.type).toBe("string")
    }),
  )

  // Track C: first-wins-Präzedenz — eine gleichnamige Projektdatei beschattet den
  // gleichnamigen Builtin vollständig (genau EIN Eintrag, und es ist die Datei,
  // KEIN Builtin).
  it.instance("a project workflow takes precedence over a same-named builtin", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "deep-research",
          `export const meta = { name: "ProjectDeepResearch" }
export async function run() { return { from: "project" } }
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      const matches = list.filter((item) => item.name === "deep-research")
      expect(matches.length).toBe(1)
      // Es ist die Projektdatei (kein Builtin-Marker, kein source_kind).
      const projectWorkflows = path.join(test.directory, ".opencode", "workflows")
      expect(matches[0]?.path.startsWith(projectWorkflows)).toBe(true)
      expect(matches[0]?.source_kind).toBeUndefined()
      expect(matches[0]?.meta.name).toBe("ProjectDeepResearch")
      // start() löst denselben Namen ebenfalls zur Projektdatei auf.
      const run = yield* workflow.start({ name: "deep-research" })
      const done = (yield* workflow.wait({ id: run.id })).run
      expect(done?.result).toEqual({ from: "project" })
    }),
  )

  // Track C: ein gleichnamiger GLOBALER Workflow beschattet den Builtin ebenfalls
  // (Global > Builtin). Genau ein Eintrag, und es ist die globale Datei.
  it.instance("a global workflow takes precedence over a same-named builtin", () =>
    Effect.gen(function* () {
      const globalWorkflows = path.join(Global.Path.config, "workflows")
      const globalFile = path.join(globalWorkflows, "deep-research.js")
      yield* Effect.promise(() => fs.mkdir(globalWorkflows, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          globalFile,
          `export const meta = { name: "GlobalDeepResearch" }
export async function run() { return { from: "global" } }
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      const matches = list.filter((item) => item.name === "deep-research")
      expect(matches.length).toBe(1)
      expect(matches[0]?.path.startsWith(globalWorkflows)).toBe(true)
      expect(matches[0]?.source_kind).toBeUndefined()
      expect(matches[0]?.meta.name).toBe("GlobalDeepResearch")
      yield* Effect.promise(() => fs.rm(globalFile, { force: true }))
    }),
  )

  // Track C: der Builtin-Source kompiliert real und lädt über denselben
  // loadModule-Pfad — `run` ist eine Funktion und die Meta ist nach dem echten
  // Import konsistent. KEIN Live-Lauf (deep-research braucht Web-Tools); nur die
  // Lade-Integrität wird geprüft, indem der Builtin-Source via Datei real
  // importiert wird (identische loadModule-Mechanik wie zur Laufzeit).
  test("the deep-research builtin source compiles and exports a real run() via loadModule", async () => {
    const { BUILTIN_WORKFLOWS } = await import("@/workflow/builtin")
    const source = BUILTIN_WORKFLOWS["deep-research"]
    expect(typeof source).toBe("string")
    // INVARIANTE (PR #2 review): Builtin-Sources sind SELF-CONTAINED — keine
    // Imports. Der Temp-Copy wird unter dem GLOBALEN workflows-Verzeichnis
    // materialisiert; ein bare specifier würde dort über `<config>/node_modules`
    // aufgelöst — die PUBLIZIERTE @opencode-ai/plugin, die config.ts installiert,
    // nie der Dev-Workspace (der Reviewer musste das Workspace-Plugin manuell
    // global verlinken, bevor der Builtin lud). Import-frei lädt der Source
    // identisch in Dev, Tests und kompilierter Binary.
    expect(source).not.toMatch(/^\s*import\b/m)
    // Realer Import: in eine Temp-Datei schreiben und dynamisch laden (identisch
    // zur loadModule-Mechanik: GLOBALES workflows-Verzeichnis — der in der
    // kompilierten Bun-Binary beschreibbare Ort, anders als `import.meta.dir`
    // (/$bunfs/root, read-only) — mit TEMP_FILE_RE-Namensschema, laden, danach
    // löschen. Das Modul-Top-Level wird ausgeführt, also deckt dies
    // Syntax-/Compile-Fehler im Source-Literal auf.
    const workflowsDir = path.join(Global.Path.config, "workflows")
    await fs.mkdir(workflowsDir, { recursive: true })
    const file = path.join(workflowsDir, `.deep-research.${Date.now()}.${Math.random().toString(16).slice(2)}.mts`)
    await Bun.write(file, source)
    try {
      const imported = (await import(pathToFileURL(file).href)) as {
        default?: { meta?: { name?: string }; run?: unknown }
      }
      const mod = imported.default ?? (imported as never)
      expect(mod.meta?.name).toBe("deep-research")
      expect(typeof mod.run).toBe("function")
    } finally {
      await Bun.file(file)
        .delete()
        .catch(() => {})
    }
    // Temp-Datei wurde im globalen workflows-Verzeichnis geladen und ist danach
    // wieder weg (kein Orphan zurückgelassen).
    expect(await Bun.file(file).exists()).toBe(false)
  })

  // P1 (Claude parity): ctx.parallel now resolves a dropped (rejecting/agent-
  // erroring) task to `null` at its position, so the deep-research builtin MUST
  // filter the parallel results before dereferencing them (research findings and
  // verify verdicts). Source-string assertion only — a live run needs web tools.
  test("the deep-research builtin filters dropped parallel results before dereferencing", async () => {
    const { BUILTIN_WORKFLOWS } = await import("@/workflow/builtin")
    const src = BUILTIN_WORKFLOWS["deep-research"]
    expect(src).toContain(".filter((f) => f !== null)")
    expect(src).toContain(".filter((v) => v !== null)")
  })
  // ===========================================================================
  // Track B — Run-Caps (Concurrency + Lifetime) und Pause/Resume
  // ===========================================================================

  // Spec §5.1 (Concurrency-Cap): eine Run-weite Semaphore deckelt ALLE
  // ctx.agent-Dispatches auf min(16, max(2, cpus-2)) — unabhängig von einem
  // großzügigeren per-call concurrencyLimit. 30 parallele Quick-Agents, jeder am
  // Barrier-Gate über die Prompt-Ops geparkt, dürfen daher höchstens cap viele
  // gleichzeitig laufen lassen. Der Peak wird deterministisch über den Barrier-
  // Counter gemessen (wie die Fund-49-Tests), nicht über eine Timing-Window.
  it.instance("run-wide cap bounds concurrent ctx.agent dispatches regardless of per-call limit", () =>
    Effect.gen(function* () {
      const cap = Math.min(16, Math.max(2, os.cpus().length - 2))
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, AGENT_CAP_FIXTURE, AGENT_CAP_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const sync = installBarrier()
      // Prompt-Ops, die jeden Agent-Prompt am Barrier-Gate parken (Peak messbar)
      // und ihn dann mit Telemetrie beantworten.
      const capOps: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
        prompt: (input) =>
          Effect.gen(function* () {
            if (input.noReply) return assistantReply()
            const barrier = globalThis.__workflowTestBarriers![sync.token]
            barrier.active++
            barrier.peak = Math.max(barrier.peak, barrier.active)
            yield* Effect.promise(() => barrier.gate)
            barrier.active--
            return yield* persistTurns(db, input.sessionID, [
              { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
            ])
          }),
        cancel: () => Effect.void,
      }
      // 30 parallele Agenten, per-call-Limit 30 (>> cap): die Run-weite Semaphore
      // muss dennoch greifen.
      const run = yield* workflow.start({
        name: AGENT_CAP_FIXTURE,
        args: { count: 30 },
        prompt: capOps,
      })
      // Warten bis cap viele Agenten gleichzeitig am Gate parken.
      yield* sync.awaitPeak(cap)
      // Selbst nach einer Settle-Pause darf der Peak NIE über den Cap klettern:
      // ein (cap+1)-ter gleichzeitiger Dispatch würde die Semaphore verletzen.
      yield* Effect.sleep("200 millis")
      expect(sync.barrier.active).toBe(cap)
      expect(sync.barrier.peak).toBe(cap)
      // Gate öffnen, alle 30 abarbeiten lassen.
      sync.barrier.release()
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("cap run did not finish")))
      expect(done.status).toBe("completed")
      expect((done.result as { result: number }).result).toBe(30)
      delete globalThis.__workflowTestBarriers![sync.token]
    }),
  )

  // Spec §5.2 (Lifetime-Cap): ab 1.000 gestarteten Agenten wirft ctx.agent einen
  // WorkflowAgentLimitError. Über den Test-Seam __testHooks.agentLimit wird das
  // Limit auf 5 gesetzt: der 6. ctx.agent-Aufruf scheitert mit _tag
  // "WorkflowAgentLimitError", der Run failt EHRLICH, und genau 5 Agenten sind
  // sichtbar (completed).
  it.instance("agent lifetime limit fails the run at the configured ceiling with a tagged error", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, LIFETIME_FIXTURE, LIFETIME_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      Workflow.__testHooks.agentLimit(5)
      const run = yield* workflow.start({
        name: LIFETIME_FIXTURE,
        args: { count: 10 },
        prompt: costPromptOps(db, 0),
      })
      const done = (yield* workflow.wait({ id: run.id })).run ?? (yield* Effect.fail(new Error("did not finish")))
      expect(done.status).toBe("failed")
      expect(done.error ?? "").toMatch(/WorkflowAgentLimitError|agent.*limit/i)
      // Genau 5 Agenten gelangen; der 6. wird vom Lifetime-Gate geblockt (kein
      // Node für den geblockten Aufruf).
      expect(done.agents.filter((a) => a.status === "completed").length).toBe(5)
      expect(done.agents.length).toBe(5)
    }),
  )

  // Spec §5.3 (pause): ein am Agent-Gate hängender Run wird pausiert — die
  // Sessions werden abgebrochen (Recorder), der Scope geschlossen, der Fiber
  // unterbrochen, aber der Run finished mit Status `paused` (NICHT cancelled) und
  // das Journal (agents[]) bleibt erhalten. wait() liefert sofort den
  // paused-Snapshot (timedOut:false). Der Folge-Step läuft nie.
  it.instance("pause suspends a running run as paused, aborts sessions, keeps the journal", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PAUSE_FIXTURE, PAUSE_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, aborted } = hangingPromptOps()
      const run = yield* workflow.start({ name: PAUSE_FIXTURE, args: {}, prompt: ops })

      const live = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current && current.agents.some((a) => a.status === "running" && a.session_id) ? current : undefined
        }),
        "agent never started",
      )
      const childSession = live.agents[0]?.session_id
      expect(childSession).toBeDefined()

      const paused = yield* workflow.pause(run.id)
      expect(paused?.status).toBe("paused")
      // Die Child-Session wurde abgebrochen (wie cancel).
      expect(aborted.has(childSession!)).toBe(true)

      // Persistierte Row trägt paused; das Journal bleibt erhalten.
      const row = yield* fetchRunRow(run.id)
      expect(row.status).toBe("paused")
      expect(row.agents.length).toBeGreaterThanOrEqual(1)

      // wait() auf einen paused Run liefert sofort den paused-Snapshot (kein Timeout).
      const waited = yield* workflow.wait({ id: run.id })
      expect(waited.timedOut).toBe(false)
      expect(waited.run?.status).toBe("paused")

      // Der Folge-Step lief nie.
      const after = yield* workflow.get(run.id)
      expect(after?.logs.some((l) => l.message?.includes(PAUSE_AFTER_MARKER))).toBe(false)
    }),
  )

  // Spec §5.3 (Sweep lässt paused in Ruhe): der Orphan-Sweep darf NUR running-Rows
  // ohne Live-Fiber zu interrupted machen — paused-Rows bleiben unangetastet.
  it.instance("sweep leaves paused rows untouched", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const pausedId = "job_paused_sweep"
      const now = Date.now()
      yield* db
        .insert(WorkflowRunTable)
        .values({
          id: pausedId,
          workflow: HELLO_FIXTURE,
          status: "paused",
          started_at: now,
          directory: test.directory,
          logs: [],
          agents: [{ id: "1", status: "completed", started_at: now, completed_at: now, prompt: "done", output: "x" }],
        })
        .run()
        .pipe(Effect.orDie)
      yield* workflow.sweep()
      const row = yield* fetchRunRow(pausedId)
      expect(row.status).toBe("paused")
    }),
  )

  // Spec §5.3 (cancel auf paused → cancelled): ein cancel auf einen pausierten Run
  // überführt ihn in den terminalen Status cancelled.
  it.instance("cancel on a paused run transitions it to cancelled", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PAUSE_FIXTURE, PAUSE_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops } = hangingPromptOps()
      const run = yield* workflow.start({ name: PAUSE_FIXTURE, args: {}, prompt: ops })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current && current.agents.some((a) => a.status === "running" && a.session_id) ? current : undefined
        }),
        "agent never started",
      )
      const paused = yield* workflow.pause(run.id)
      expect(paused?.status).toBe("paused")
      const cancelled = yield* workflow.cancel(run.id)
      expect(cancelled?.status).toBe("cancelled")
      const after = yield* workflow.get(run.id)
      expect(after?.status).toBe("cancelled")
    }),
  )

  // Spec §5.4 (Resume-Journal): ein Run mit Agent A (completed) + B (durch pause
  // unterbrochen). Ein resume-Start mit resume_of übernimmt A aus dem Journal
  // (KEIN neuer Prompt für A, output/cost übernommen, cached:true), B läuft live;
  // das Budget des neuen Runs wird um As Kosten vor-dekrementiert.
  it.instance("resume replays the completed agent from the journal and runs the rest live", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, RESUME_FIXTURE, RESUME_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service

      // Erster Lauf: A completed sofort, B hängt → pause unterbricht B.
      const firstAborted = new Set<string>()
      const firstGates = new Map<string, Deferred.Deferred<void>>()
      let promptCount = 0
      const firstOps: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
        prompt: (input) =>
          Effect.gen(function* () {
            if (input.noReply) return assistantReply()
            promptCount++
            const text = input.parts?.[0]?.type === "text" ? input.parts[0].text : ""
            // Agent A beantwortet sofort mit Kosten 0.25; Agent B hängt.
            if (text === "agent A") {
              const last = yield* persistTurns(db, input.sessionID, [
                { cost: 0.25, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
              ])
              return { info: last.info, parts: [{ type: "text", text: "out:A" }] } as unknown as SessionV1.WithParts
            }
            const gate = yield* Deferred.make<void>()
            firstGates.set(input.sessionID, gate)
            yield* Effect.race(
              Effect.sleep("30 seconds"),
              Deferred.await(gate).pipe(Effect.flatMap(() => Effect.interrupt)),
            )
            return assistantReply()
          }),
        cancel: (sessionID) =>
          Effect.gen(function* () {
            firstAborted.add(sessionID)
            const gate = firstGates.get(sessionID)
            if (gate) yield* Deferred.succeed(gate, undefined)
          }),
      }
      const first = yield* workflow.start({ name: RESUME_FIXTURE, args: {}, prompt: firstOps })
      // Warten bis A completed und B running ist.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(first.id)
          const completed = current?.agents.filter((a) => a.status === "completed") ?? []
          const running = current?.agents.filter((a) => a.status === "running" && a.session_id) ?? []
          return completed.length >= 1 && running.length >= 1 ? current : undefined
        }),
        "first run did not reach A-completed + B-running",
      )
      const pausedFirst = yield* workflow.pause(first.id)
      expect(pausedFirst?.status).toBe("paused")
      const firstPromptCount = promptCount

      // Zweiter Lauf (resume): recordingPromptOps protokolliert jeden GEFEUERTEN
      // Prompt. A muss aus dem Journal kommen (NICHT in prompted), B live.
      const { ops: resumeOps, prompted } = recordingPromptOps(db, 0.5)
      const resumed = yield* workflow.start({
        name: RESUME_FIXTURE,
        args: {},
        prompt: resumeOps,
        resume_of: first.id,
        budget: 10,
      })
      const done =
        (yield* workflow.wait({ id: resumed.id })).run ?? (yield* Effect.fail(new Error("resume did not finish")))
      expect(done.status).toBe("completed")
      // A kam aus dem Journal: KEIN neuer Prompt "agent A" wurde gefeuert.
      expect(prompted).not.toContain("agent A")
      // B lief live.
      expect(prompted).toContain("agent B")
      // Das resume hat den Quell-Run NICHT erneut geprompt (firstPromptCount fix).
      expect(firstPromptCount).toBeGreaterThanOrEqual(1)
      // A's Output (aus dem Journal) und B's Live-Output sind im Resultat.
      const result = done.result as { a: string; b: string }
      expect(result.a).toBe("out:A")
      expect(result.b).toBe("out:agent B")
      // Agent-Node A ist als cached markiert, B nicht.
      const agentA = done.agents.find((a) => a.output === "out:A")
      expect(agentA?.cached).toBe(true)
      const agentB = done.agents.find((a) => a.output === "out:agent B")
      expect(agentB?.cached).not.toBe(true)
      // resume_of ist auf der Row vermerkt.
      const row = yield* fetchRunRow(resumed.id)
      expect(row.resume_of).toBe(first.id)
    }),
  )

  // Spec §5.4 (Occurrence-Index): zwei identische Prompts müssen beim Resume
  // getrennt aus dem Journal aufgelöst werden (je nach Aufruf-Reihenfolge), nicht
  // beide auf denselben Eintrag. Beide A-Agenten kommen aus dem Journal, also wird
  // KEIN Prompt erneut gefeuert.
  it.instance("resume caches two identical prompts separately by occurrence", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, RESUME_DUP_FIXTURE, RESUME_DUP_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service

      // Erster Lauf: beide identischen Prompts completen sofort mit
      // UNTERSCHEIDBAREN Outputs (out:0, out:1), damit der Test beweisen kann, dass
      // die zwei Journal-Einträge getrennt aufgelöst werden.
      let counter = 0
      const firstOps: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
        prompt: (input) =>
          Effect.gen(function* () {
            if (input.noReply) return assistantReply()
            const idx = counter++
            const last = yield* persistTurns(db, input.sessionID, [
              { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
            ])
            return { info: last.info, parts: [{ type: "text", text: "out:" + idx }] } as unknown as SessionV1.WithParts
          }),
        cancel: () => Effect.void,
      }
      const first = yield* workflow.start({ name: RESUME_DUP_FIXTURE, args: {}, prompt: firstOps })
      const firstDone =
        (yield* workflow.wait({ id: first.id })).run ?? (yield* Effect.fail(new Error("first dup run did not finish")))
      expect(firstDone.status).toBe("completed")
      expect(firstDone.result).toEqual({ first: "out:0", second: "out:1" })

      // Nur paused/interrupted Runs sind gültige Resume-Quellen (Status-Guard). Der
      // erste Lauf completed mit beiden Journal-Einträgen; wir versetzen die Row auf
      // `paused` (Journal/agents bleiben erhalten), um eine legitime Resume-Quelle
      // zu erhalten — der Occurrence-Index ist das, was dieser Test prüft. Das Update
      // wird im Poll wiederholt, bis es sichtbar `paused` ist (der terminale Run wird
      // ASYNCHRON aus der Registry evictet — bis dahin könnte ein letzter Snapshot die
      // DB-Mutation überschreiben; nach Eviction fällt get() auf die Row zurück).
      yield* pollWithTimeout(
        Effect.gen(function* () {
          yield* db
            .update(WorkflowRunTable)
            .set({ status: "paused" })
            .where(eq(WorkflowRunTable.id, first.id))
            .run()
            .pipe(Effect.orDie)
          const current = yield* workflow.get(first.id)
          return current?.status === "paused" ? current : undefined
        }),
        "source run never became paused",
      )

      // Resume: beide identischen Prompts müssen aus dem Journal kommen (kein neuer
      // Prompt), und zwar getrennt: first→out:0, second→out:1 (Occurrence-Reihenfolge).
      const { ops: resumeOps, prompted } = recordingPromptOps(db, 0)
      const resumed = yield* workflow.start({
        name: RESUME_DUP_FIXTURE,
        args: {},
        prompt: resumeOps,
        resume_of: first.id,
      })
      const done =
        (yield* workflow.wait({ id: resumed.id })).run ?? (yield* Effect.fail(new Error("resume dup did not finish")))
      expect(done.status).toBe("completed")
      // Kein Prompt wurde gefeuert: beide kamen aus dem Journal.
      expect(prompted).toHaveLength(0)
      // Getrennt aufgelöst, in Occurrence-Reihenfolge.
      expect(done.result).toEqual({ first: "out:0", second: "out:1" })
    }),
  )

  // Spec §5.4 (invalidate_agents): mit invalidate_agents:[0] läuft Agent #0 live
  // neu, alle anderen cachen.
  it.instance("resume with invalidate_agents reruns the named index live and caches the rest", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, RESUME_FIXTURE, RESUME_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service

      // Erster Lauf: beide Agenten completen sofort.
      const firstOps = recordingPromptOps(db, 0)
      const first = yield* workflow.start({ name: RESUME_FIXTURE, args: {}, prompt: firstOps.ops })
      const firstDone =
        (yield* workflow.wait({ id: first.id })).run ?? (yield* Effect.fail(new Error("first run did not finish")))
      expect(firstDone.status).toBe("completed")

      // Status-Guard: nur paused/interrupted Runs sind gültige Resume-Quellen. Die
      // completed-Row auf `paused` versetzen (Journal bleibt), damit der Resume die
      // invalidate_agents-Semantik prüfen kann. Im Poll wiederholt, bis sichtbar
      // `paused` (asynchrone Eviction des terminalen Runs — siehe oben).
      yield* pollWithTimeout(
        Effect.gen(function* () {
          yield* db
            .update(WorkflowRunTable)
            .set({ status: "paused" })
            .where(eq(WorkflowRunTable.id, first.id))
            .run()
            .pipe(Effect.orDie)
          const current = yield* workflow.get(first.id)
          return current?.status === "paused" ? current : undefined
        }),
        "source run never became paused",
      )

      // Resume mit invalidate_agents:[0] → Agent #0 (A) läuft live neu, B cacht.
      const { ops: resumeOps, prompted } = recordingPromptOps(db, 0)
      const resumed = yield* workflow.start({
        name: RESUME_FIXTURE,
        args: {},
        prompt: resumeOps,
        resume_of: first.id,
        invalidate_agents: [0],
      })
      const done =
        (yield* workflow.wait({ id: resumed.id })).run ?? (yield* Effect.fail(new Error("resume did not finish")))
      expect(done.status).toBe("completed")
      // Nur Agent A (#0) lief live neu; B kam aus dem Journal.
      expect(prompted).toContain("agent A")
      expect(prompted).not.toContain("agent B")
      const agentA = done.agents.find((a) => a.prompt === "agent A")
      expect(agentA?.cached).not.toBe(true)
      const agentB = done.agents.find((a) => a.prompt === "agent B")
      expect(agentB?.cached).toBe(true)
    }),
  )

  // Status-Guard (Fund: kein Guard auf dem Resume-Source-Status): nur paused/
  // interrupted Runs sind gültige Resume-Quellen. Ein COMPLETED Quell-Run darf
  // NICHT resumt werden — das würde seine Arbeit verdoppeln. Erwartung: ehrlicher
  // WorkflowInvalidError (HTTP 400), dessen Message den Status nennt, statt stillem
  // Degradieren zu einem Normallauf.
  it.instance("resume from a completed source run fails with WorkflowInvalidError", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, RESUME_FIXTURE, RESUME_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service

      // Quell-Run läuft regulär bis completed.
      const firstOps = recordingPromptOps(db, 0)
      const first = yield* workflow.start({ name: RESUME_FIXTURE, args: {}, prompt: firstOps.ops })
      const firstDone =
        (yield* workflow.wait({ id: first.id })).run ?? (yield* Effect.fail(new Error("first run did not finish")))
      expect(firstDone.status).toBe("completed")

      // Resume von einer completed-Quelle MUSS scheitern.
      const { ops: resumeOps } = recordingPromptOps(db, 0)
      const failed = yield* workflow
        .start({ name: RESUME_FIXTURE, args: {}, prompt: resumeOps, resume_of: first.id })
        .pipe(Effect.flip)
      expect(failed._tag).toBe("WorkflowInvalidError")
      const invalid =
        failed instanceof Workflow.InvalidError ? failed : yield* Effect.fail(new Error("expected InvalidError"))
      // Die Message nennt den tatsächlichen Status der Quelle.
      expect(invalid.message).toContain("completed")
      expect(invalid.message).toContain(first.id)
    }),
  )

  // Status-Guard / cancel-paused-Race: ein CANCELLED Quell-Run (hier: hängender Run
  // → pause → cancel, exakt die cancel-of-a-paused-run-Semantik) darf NICHT resumt
  // werden. Ein direkter DB-UPDATE auf cancelled (die Race) wäre sonst re-resumebar.
  // Erwartung: WorkflowInvalidError, der den Status `cancelled` nennt.
  it.instance("resume from a cancelled source run fails with WorkflowInvalidError", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PAUSE_FIXTURE, PAUSE_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service

      // Hängenden Run starten, pausieren, dann cancellen → terminal cancelled.
      const { ops } = hangingPromptOps()
      const run = yield* workflow.start({ name: PAUSE_FIXTURE, args: {}, prompt: ops })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current && current.agents.some((a) => a.status === "running" && a.session_id) ? current : undefined
        }),
        "agent never started",
      )
      const paused = yield* workflow.pause(run.id)
      expect(paused?.status).toBe("paused")
      const cancelled = yield* workflow.cancel(run.id)
      expect(cancelled?.status).toBe("cancelled")

      // Resume von einer cancelled-Quelle MUSS scheitern.
      const { ops: resumeOps } = recordingPromptOps(db, 0)
      const failed = yield* workflow
        .start({ name: PAUSE_FIXTURE, args: {}, prompt: resumeOps, resume_of: run.id })
        .pipe(Effect.flip)
      expect(failed._tag).toBe("WorkflowInvalidError")
      const invalid =
        failed instanceof Workflow.InvalidError ? failed : yield* Effect.fail(new Error("expected InvalidError"))
      expect(invalid.message).toContain("cancelled")
      expect(invalid.message).toContain(run.id)
    }),
  )

  // Schema/Journal-Drift (Fund: ungeschütztes JSON.parse(cached.output)): der
  // Journal-Key ignoriert das Schema. Ein PLAINTEXT-Quell-Node kann beim Resume
  // eine Schema-Anfrage matchen, wenn die Workflow-Datei zwischen Lauf und Resume
  // driftet (gleicher Name/Prompt/Phase, jetzt mit schema im agent-Call). Statt am
  // JSON.parse des Plaintext-Outputs zu defecten, MUSS der Resume das als Cache-MISS
  // behandeln und den Agenten LIVE laufen lassen (PromptOps-Zähler +1, Run completed).
  it.instance("a schema call matching a plaintext journal node runs live instead of defecting", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // V1: Plaintext-Agent (kein Schema) → Journal-Node mit nicht-JSON-Output.
      yield* Effect.promise(() => writeWorkflow(test.directory, DRIFT_FIXTURE, DRIFT_WORKFLOW_PLAINTEXT))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service

      const { ops: firstOps, state: firstState } = driftPromptOps(db)
      const first = yield* workflow.start({ name: DRIFT_FIXTURE, args: {}, prompt: firstOps })
      const firstDone =
        (yield* workflow.wait({ id: first.id })).run ?? (yield* Effect.fail(new Error("first run did not finish")))
      expect(firstDone.status).toBe("completed")
      // Der Quell-Node trägt Plaintext (kein gültiges JSON).
      expect(firstDone.result).toEqual({ value: "not json at all" })
      expect(firstState.count).toBe(1)

      // Quell-Row auf `paused` versetzen → legitime Resume-Quelle (Journal bleibt).
      // Im Poll wiederholt, bis sichtbar `paused` (asynchrone Eviction, siehe oben).
      yield* pollWithTimeout(
        Effect.gen(function* () {
          yield* db
            .update(WorkflowRunTable)
            .set({ status: "paused" })
            .where(eq(WorkflowRunTable.id, first.id))
            .run()
            .pipe(Effect.orDie)
          const current = yield* workflow.get(first.id)
          return current?.status === "paused" ? current : undefined
        }),
        "source run never became paused",
      )

      // Drift: SELBE Datei (gleicher Name → gleicher path/journalKey) wird zu V2
      // überschrieben — derselbe Agent-Call fordert jetzt ein Schema an.
      yield* Effect.promise(() => writeWorkflow(test.directory, DRIFT_FIXTURE, DRIFT_WORKFLOW_SCHEMA))

      // Resume: die Schema-Anfrage matcht den Plaintext-Journal-Node. Kein Defect —
      // der Agent läuft LIVE und liefert ein echtes structured-Ergebnis.
      const { ops: resumeOps, state: resumeState } = driftPromptOps(db)
      const resumed = yield* workflow.start({
        name: DRIFT_FIXTURE,
        args: {},
        prompt: resumeOps,
        resume_of: first.id,
      })
      const done =
        (yield* workflow.wait({ id: resumed.id })).run ?? (yield* Effect.fail(new Error("resume did not finish")))
      // Kein Defect: der Run completed sauber.
      expect(done.status).toBe("completed")
      // Der Agent lief LIVE (Zähler +1), NICHT aus dem Journal repliziert.
      expect(resumeState.count).toBe(1)
      // Das Live-Ergebnis ist das geparste Schema-Objekt, nicht der Plaintext.
      expect(done.result).toEqual({ value: SCHEMA_OBJECT })
      // Der Agent-Node ist NICHT als cached markiert (Cache-MISS → Live-Lauf).
      const node = done.agents.find((a) => a.prompt === "drift agent")
      expect(node?.cached).not.toBe(true)
    }),
  )

  // Task 6: a per-step reasoning `variant` passed to ctx.agent must be threaded
  // verbatim into the underlying prompt run. The recording prompt-ops capture the
  // real PromptInput, so the dispatched `variant` is asserted directly — proving
  // ctx.agent({ prompt, variant }) reaches SessionPrompt.prompt as input.variant.
  it.instance("ctx.agent variant is threaded into the prompt run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, VARIANT_FIXTURE, VARIANT_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, inputs } = capturingPromptOps()

      const started = yield* workflow.start({ name: VARIANT_FIXTURE, args: {}, prompt: ops })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("variant workflow did not finish")))
      expect(done.status).toBe("completed")

      // Exactly one real agent dispatch, carrying the requested variant.
      expect(inputs.length).toBe(1)
      expect(inputs[0]?.variant).toBe("max")
    }),
  )

  // Task 7: ctx.agent({ model: "small" }) must resolve to the configured
  // small_model and dispatch the prompt against that provider/model. The
  // capturing prompt-ops record the real PromptInput, so the resolved model is
  // asserted directly against the configured small_model's providerID/modelID.
  it.instance(
    'ctx.agent model:"small" routes to the configured small_model',
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => writeWorkflow(test.directory, SMALL_MODEL_FIXTURE, SMALL_MODEL_WORKFLOW))
        const workflow = yield* Workflow.Service
        const { ops, inputs } = capturingPromptOps()

        const started = yield* workflow.start({ name: SMALL_MODEL_FIXTURE, args: {}, prompt: ops })
        const waited = yield* workflow.wait({ id: started.id })
        const done = waited.run ?? (yield* Effect.fail(new Error("small-model workflow did not finish")))
        expect(done.status).toBe("completed")

        // The dispatch resolved to the configured small_model, not the default agent model.
        expect(inputs.length).toBe(1)
        expect(String(inputs[0]?.model?.providerID)).toBe("smallprov")
        expect(String(inputs[0]?.model?.modelID)).toBe("small-model")
      }),
    { config: { small_model: "smallprov/small-model" } },
  )

  // Task 7 (error path): requesting model:"small" with NO small_model configured
  // is an authoring error. The agent step must fail with a clear message rather
  // than silently falling back; the prompt is never dispatched.
  it.instance("ctx.agent model:\"small\" fails clearly when no small_model is configured", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SMALL_MODEL_FIXTURE, SMALL_MODEL_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, inputs } = capturingPromptOps()

      const started = yield* workflow.start({ name: SMALL_MODEL_FIXTURE, args: {}, prompt: ops })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("small-model workflow did not finish")))

      // The run failed because the only agent step could not resolve a model.
      expect(done.status).toBe("failed")
      const node = done.agents[0]
      expect(node?.status).toBe("failed")
      expect(node?.error).toContain("small_model")
      // The prompt was never dispatched (no model to run against).
      expect(inputs.length).toBe(0)
    }),
  )

  // Task 8: a per-step `tools` whitelist/blacklist passed to ctx.agent must be
  // threaded verbatim into the underlying prompt run. opencode's tool-scoping
  // mechanism is PromptInput.tools (a Record<string,boolean> with glob-able
  // keys), which the prompt loop turns into session permission rules — so the
  // capturing prompt-ops record it directly and the dispatched object is
  // asserted unchanged.
  it.instance("ctx.agent tools scoping is threaded into the prompt run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, TOOLS_FIXTURE, TOOLS_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, inputs } = capturingPromptOps()

      const started = yield* workflow.start({ name: TOOLS_FIXTURE, args: {}, prompt: ops })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("tools workflow did not finish")))
      expect(done.status).toBe("completed")

      // Exactly one real agent dispatch, carrying the requested tools object unchanged.
      expect(inputs.length).toBe(1)
      expect(inputs[0]?.tools).toEqual({ webfetch: false })
    }),
  )

  // Task 9: a per-step `skills` array passed to ctx.agent must be honoured.
  // opencode only loads skills via the runtime `skill` tool (no structured
  // create/prompt field), so the engine prepends a load directive naming the
  // skills to the prompt text and enables the `skill` tool for the step. Both
  // are asserted on the captured PromptInput.
  it.instance("ctx.agent skills are loaded via a prompt directive and the enabled skill tool", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SKILLS_FIXTURE, SKILLS_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, inputs } = capturingPromptOps()

      const started = yield* workflow.start({ name: SKILLS_FIXTURE, args: {}, prompt: ops })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("skills workflow did not finish")))
      expect(done.status).toBe("completed")

      expect(inputs.length).toBe(1)
      // The skill tool is enabled for this step.
      expect(inputs[0]?.tools?.skill).toBe(true)
      // The text part carries a directive naming both skills, ahead of the prompt.
      const textPart = inputs[0]?.parts.find((p) => p.type === "text")
      expect(textPart?.type).toBe("text")
      const text = textPart?.type === "text" ? textPart.text : ""
      expect(text).toContain("pdf")
      expect(text).toContain("xlsx")
      expect(text).toContain("do it")
      // Directive comes BEFORE the author's prompt.
      expect(text.indexOf("pdf")).toBeLessThan(text.indexOf("do it"))
    }),
  )

  // Task 10: a per-step `files` array passed to ctx.agent attaches files
  // declaratively. Each path resolves relative to the run's workspace directory;
  // the engine appends a file part (after the text part) whose URL is the
  // absolute file:// URL of the attachment.
  it.instance("ctx.agent files are resolved against the workspace and appended as file parts", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "ATTACH.md"), "# attached\n"))
      yield* Effect.promise(() => writeWorkflow(test.directory, FILES_FIXTURE, FILES_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, inputs } = capturingPromptOps()

      const started = yield* workflow.start({ name: FILES_FIXTURE, args: {}, prompt: ops })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("files workflow did not finish")))
      expect(done.status).toBe("completed")

      expect(inputs.length).toBe(1)
      const parts = inputs[0]?.parts ?? []
      // Text part first, file part appended after it.
      expect(parts[0]?.type).toBe("text")
      const filePart = parts.find((p) => p.type === "file")
      expect(filePart?.type).toBe("file")
      // The file part resolves to the absolute attachment in the workspace directory.
      const expectedUrl = pathToFileURL(path.join(test.directory, "ATTACH.md")).href
      expect(filePart?.type === "file" ? filePart.url : undefined).toBe(expectedUrl)
    }),
  )

  // Task 10 (error path): a non-existent attachment is an authoring error. The
  // agent step must fail with a WorkflowInvalidError naming the missing file
  // rather than dispatching a broken prompt.
  it.instance("ctx.agent files fails clearly when an attachment does not exist", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, FILES_MISSING_FIXTURE, FILES_MISSING_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, inputs } = capturingPromptOps()

      const started = yield* workflow.start({ name: FILES_MISSING_FIXTURE, args: {}, prompt: ops })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("files-missing workflow did not finish")))

      expect(done.status).toBe("failed")
      const node = done.agents[0]
      expect(node?.status).toBe("failed")
      expect(node?.error).toContain("DOES_NOT_EXIST.md")
      // The prompt was never dispatched (the attachment could not be resolved).
      expect(inputs.length).toBe(0)
    }),
  )

  // Task 11: ctx.agent({ isolation: "worktree" }) runs the subagent inside a
  // FRESH git worktree so parallel agents that mutate files do not conflict. The
  // load-bearing assertion is that the EFFECTIVE instance directory the prompt
  // runs under (what the subagent's file tools resolve cwd against) is the
  // worktree path — NOT the run's workspace directory. The directory-capturing
  // prompt-ops read InstanceState.directory from inside the dispatch, so we can
  // assert real isolation rather than merely "a worktree was created". After the
  // run finishes the worktree must be gone (run-scope finalizer cleaned it up).
  it.instance(
    "ctx.agent isolation:\"worktree\" runs the subagent in a fresh git worktree and cleans it up",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => writeWorkflow(test.directory, ISOLATION_FIXTURE, ISOLATION_WORKFLOW))
        const workflow = yield* Workflow.Service
        const { ops, inputs, directories, wasGitWorktree } = directoryCapturingPromptOps()

        const started = yield* workflow.start({ name: ISOLATION_FIXTURE, args: {}, prompt: ops })
        const waited = yield* workflow.wait({ id: started.id })
        const done = waited.run ?? (yield* Effect.fail(new Error("isolation workflow did not finish")))
        expect(done.status).toBe("completed")

        // Exactly one real agent dispatch.
        expect(inputs.length).toBe(1)
        const effectiveDir = directories[0]
        // The subagent ran under a DIFFERENT directory than the workspace — this
        // is the load-bearing proof of real isolation: the prompt run (and so the
        // subagent's file tools) resolves cwd against the worktree, not the
        // workspace. Before the InstanceRef override this was the workspace dir.
        expect(effectiveDir).toBeDefined()
        expect(effectiveDir).not.toBe(test.directory)
        // It was a real git worktree at dispatch time: it had a `.git` entry (a
        // worktree's `.git` is a file pointing at the parent's gitdir), observed
        // live before the finalizer removed it.
        expect(wasGitWorktree[0]).toBe(true)
        // The worktree lived OUTSIDE the workspace (a sibling temp dir), so it can
        // never collide with the workspace or another step's worktree.
        expect(effectiveDir!.startsWith(test.directory)).toBe(false)

        // Run-scope finalizer cleans up the worktree. On a normal finish the run
        // scope is closed fire-and-forget (so the terminal return is never delayed
        // by a finalizer), meaning cleanup is async relative to wait() — poll for
        // the directory to disappear rather than asserting it synchronously.
        yield* pollWithTimeout(
          Effect.promise(() =>
            fs
              .stat(effectiveDir!)
              .then(() => undefined)
              .catch(() => true as const),
          ),
          `worktree ${effectiveDir} was not cleaned up after the run finished`,
        )
      }),
    { git: true },
  )

  // Task 11 (error path): isolation:"worktree" in a NON-git workspace is an
  // authoring/environment error. The step must fail with a clear
  // WorkflowInvalidError naming the missing git repository rather than crashing,
  // and the prompt is never dispatched.
  it.instance("ctx.agent isolation:\"worktree\" fails clearly outside a git repository", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, ISOLATION_FIXTURE, ISOLATION_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, inputs } = capturingPromptOps()

      const started = yield* workflow.start({ name: ISOLATION_FIXTURE, args: {}, prompt: ops })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("isolation workflow did not finish")))

      expect(done.status).toBe("failed")
      expect(done.error ?? "").toContain("requires a git repository")
      const node = done.agents[0]
      expect(node?.status).toBe("failed")
      // The prompt was never dispatched (no worktree to run in).
      expect(inputs.length).toBe(0)
    }),
  )

  // Task 11a: ctx.shell runs a real command in the run's workspace and returns
  // { output, exitCode } without an LLM turn. A successful command reports
  // exitCode 0 and its stdout; a non-zero exit is returned (failCode === 3), never
  // thrown; and ctx.budget.spent() is 0 because shell never touches the budget.
  it.instance("ctx.shell runs a deterministic non-LLM step returning output + exitCode without touching budget", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SHELL_FIXTURE, SHELL_WORKFLOW))
      const workflow = yield* Workflow.Service

      const started = yield* workflow.start({ name: SHELL_FIXTURE, args: {} })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("shell workflow did not finish")))

      expect(done.status).toBe("completed")
      const result = done.result as { out: string; okCode: number; failCode: number; spent: number }
      expect(result.out).toBe("hello-workflow")
      expect(result.okCode).toBe(0)
      // A non-zero exit is mapped to the return value, NOT a throw.
      expect(result.failCode).toBe(3)
      // Shell does not touch the budget — spend stays at 0.
      expect(result.spent).toBe(0)
    }),
  )

  // Task 11b (a): a parent runs a DISCOVERED child inline via ctx.workflow under
  // the SAME run. The parent completes, the child's result flows back
  // (fromChild === 42), exactly ONE run row exists for this start (no separate
  // child run row), and the parent's logs include the child's prefixed log entry.
  it.instance("ctx.workflow runs a discovered child inline under the same run with prefixed logs", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, NEST_CHILD_FIXTURE, NEST_CHILD_WORKFLOW))
      yield* Effect.promise(() => writeWorkflow(test.directory, NEST_PARENT_FIXTURE, NEST_PARENT_WORKFLOW))
      const workflow = yield* Workflow.Service

      const started = yield* workflow.start({ name: NEST_PARENT_FIXTURE, args: {} })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("parent workflow did not finish")))

      expect(done.status).toBe("completed")
      expect((done.result as { fromChild: number }).fromChild).toBe(42)

      // Exactly ONE run row exists for this start: no separate child run row.
      const runs = yield* workflow.runs()
      expect(runs.length).toBe(1)
      expect(runs[0]!.id).toBe(started.id)

      // The parent's logs include the child's prefixed log entry.
      const messages = done.logs.map((l) => l.message)
      expect(messages).toContain("child: child-ran")
    }),
  )

  // Task 11b (b): nesting is limited to depth 1. A child that itself calls
  // ctx.workflow must be refused — the nested call throws a WorkflowInvalidError
  // mentioning the depth limit, and the run fails with that error.
  it.instance("ctx.workflow enforces a depth-1 limit: a nested ctx.workflow call fails the run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, NEST_GRANDCHILD_FIXTURE, NEST_GRANDCHILD_WORKFLOW))
      yield* Effect.promise(() => writeWorkflow(test.directory, NEST_DEEP_CHILD_FIXTURE, NEST_DEEP_CHILD_WORKFLOW))
      yield* Effect.promise(() => writeWorkflow(test.directory, NEST_DEEP_PARENT_FIXTURE, NEST_DEEP_PARENT_WORKFLOW))
      const workflow = yield* Workflow.Service

      const started = yield* workflow.start({ name: NEST_DEEP_PARENT_FIXTURE, args: {} })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("deep-parent workflow did not finish")))

      expect(done.status).toBe("failed")
      expect(done.error ?? "").toMatch(/WorkflowInvalidError|nesting|depth/i)

      // Still exactly ONE run row — the failed nesting never created a second run.
      const runs = yield* workflow.runs()
      expect(runs.length).toBe(1)
    }),
  )

  // Task 11b (c): the child's agent dispatches count against the SAME run's
  // agent-lifetime cap. With the cap lowered to 3, the parent's one agent plus the
  // child's dispatches collectively exceed it, so the over-cap dispatch (inside
  // the child) fails the WHOLE run with a tagged AgentLimitError — proving the cap
  // is shared, not reset per nested workflow.
  it.instance("ctx.workflow shares the run's agent-lifetime cap with the child", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, NEST_AGENT_CHILD_FIXTURE, NEST_AGENT_CHILD_WORKFLOW))
      yield* Effect.promise(() => writeWorkflow(test.directory, NEST_AGENT_PARENT_FIXTURE, NEST_AGENT_PARENT_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      Workflow.__testHooks.agentLimit(3)

      const started = yield* workflow.start({
        name: NEST_AGENT_PARENT_FIXTURE,
        args: {},
        prompt: costPromptOps(db, 0),
      })
      const waited = yield* workflow.wait({ id: started.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("agent-parent workflow did not finish")))

      expect(done.status).toBe("failed")
      expect(done.error ?? "").toMatch(/WorkflowAgentLimitError|agent.*limit/i)
      // The cap is shared across parent + child: exactly 3 agents (1 parent + 2
      // child) reach `completed` before the 4th dispatch is refused.
      expect(done.agents.filter((a) => a.status === "completed").length).toBe(3)
      // One run row only — the child never created its own run.
      const runs = yield* workflow.runs()
      expect(runs.length).toBe(1)
    }),
  )
})
