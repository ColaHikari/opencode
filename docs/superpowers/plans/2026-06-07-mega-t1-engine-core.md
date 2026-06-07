# Mega-PR Track 1: engine-core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alle Engine-Änderungen der Spec (§4) in `workflow.ts`/`plugin/workflow.ts` als kohärente TDD-Commit-Serie: P1/P2-Fehlersemantik, Bus-Events, AgentInput-Erweiterungen, `ctx.shell`/`ctx.workflow`/`ctx.question`, OTel, strukturierte Phasen, `ctx.budget`.

**Architecture:** Ein Worktree (`/Users/manuelguttmann/Projekte/oc-mega-t1`, Branch `mega/engine-core`), ein Baustein = ein Commit (Test zuerst). Reihenfolge: risikoarm → risikoreich; `ctx.question` zuletzt, weil es auf Events + Journal aufbaut.

**Tech Stack:** Effect (Service-Pattern, `Effect.forEach`, `SynchronizedRef`), Drizzle/SQLite-Migrationen, bestehender Test-Harness in `packages/opencode/test/workflow/workflow.test.ts`.

**Harness-Konvention für alle Test-Steps:** Neue Tests kommen in `packages/opencode/test/workflow/workflow.test.ts`. Prelude/Imports/Service-Zugriff IMMER von einem benachbarten Test kopieren — Anker ist jeweils angegeben (z.B. „neben dem Test, der `PIPELINE_ORDER` nutzt"). Workflows werden als Temp-Datei-Source über denselben Helper gestartet wie in den Nachbartests (Datei in Projekt-`.opencode/workflows/` des Test-Fixtures schreiben, `workflow.start({name})`, `workflow.wait({id})`). Die Assertion-Bodies unten sind vollständig; nur das Harness-Gerüst wird vom Anker übernommen.

**Pfad-Konvention:** Alle Pfade relativ zu `/Users/manuelguttmann/Projekte/oc-mega-t1`. `W` = `packages/opencode/src/workflow/workflow.ts`, `P` = `packages/plugin/src/workflow.ts`, `T` = `packages/opencode/test/workflow/workflow.test.ts`.

---

### Task 1: P1 — `parallel()` toleriert fehlschlagende Tasks (`(T|null)[]`)

**Files:**
- Modify: `P` (Typ `parallel` in `WorkflowContext`), `W` (`ContextApi.parallel`-Typ ~Z.392 + Impl ~Z.1144), `T`

- [ ] **Step 1: Failing Test schreiben** (Anker: nachbarschaftlich zu den deterministischen Concurrency-Tests, Suche `PIPELINE_ORDER` in `T`). Workflow-Source des Tests:

```ts
export default {
  meta: { name: "par-err", description: "parallel error tolerance" },
  async run(_args, ctx) {
    const out = await ctx.parallel([
      () => Promise.resolve("ok-1"),
      () => Promise.reject(new Error("boom")),
      () => Promise.resolve("ok-3"),
    ])
    return { out }
  },
}
```

Assertions nach `start`+`wait` (Harness vom Anker):

```ts
expect(run.status).toBe("completed")                       // Batch überlebt
expect((run.result as { out: unknown[] }).out).toEqual(["ok-1", null, "ok-3"])
const dropLog = run.logs.find((l) => l.message.includes("parallel task 2 dropped"))
expect(dropLog?.message).toContain("boom")                  // Drop wird geloggt, nicht verschluckt
```

- [ ] **Step 2: Rot verifizieren**

Run: `cd packages/opencode && bun test test/workflow/workflow.test.ts -t "parallel error tolerance" 2>&1 | tail -4`
Expected: FAIL — Run-Status `failed` (alter Code reißt den Batch ab). **Falsifikations-Beweis festhalten.**

- [ ] **Step 3: Typen ändern** — in `P`, `WorkflowContext.parallel`:

```ts
parallel<T>(tasks: readonly (() => Promise<T>)[], options?: WorkflowParallelOptions): Promise<(T | null)[]>
```

und in `W` (~Z.396): `readonly parallel: <T>(tasks: readonly (() => Promise<T>)[], options?: ParallelOptions) => Promise<(T | null)[]>`

- [ ] **Step 4: Impl** — in `W`, `parallel`-Impl (~Z.1144), den Task-Lambda ersetzen:

```ts
return input.dispatch(
  Effect.forEach(
    tasks,
    (task, index) =>
      Effect.promise(() => {
        checkpoint()
        // P1 (Claude-Parität): ein fehlschlagender Task wird zu `null` an seiner
        // Position statt den ganzen Batch abzureißen. CancelledError bleibt fatal
        // (Abbruch ist kein Task-Fehler). Der Drop wird geloggt — nie still.
        return task().then(
          (value) => value as T | null,
          (error) => {
            if (error instanceof WorkflowCancelledError) throw error
            input.active.run.logs.push({
              time: Date.now(),
              phase: input.active.run.current_phase,
              message: `parallel task ${index + 1} dropped: ${error instanceof Error ? error.message : String(error)}`,
            })
            input.persist()
            return null
          },
        )
      }),
    { concurrency },
  ),
)
```

- [ ] **Step 5: Grün verifizieren + Bestand**

Run: `bun test test/workflow/workflow.test.ts --timeout 30000 2>&1 | tail -4`
Expected: neuer Test PASS, alle bestehenden PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin/src/workflow.ts packages/opencode/src/workflow/workflow.ts packages/opencode/test/workflow/workflow.test.ts
git commit -m "feat(workflow): parallel() drops a rejecting task to null instead of failing the batch"
```

### Task 2: P2 — `pipeline()` droppt nur das werfende Item

**Files:** wie Task 1 (`P`-Typen: `WorkflowPipelineFn`-Overloads → `Promise<(X | null)[]>`)

- [ ] **Step 1: Failing Test** (gleicher Anker). Workflow-Source:

```ts
export default {
  meta: { name: "pipe-err", description: "pipeline per-item drop" },
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
```

Assertions:

```ts
expect(run.status).toBe("completed")
const r = run.result as { out: unknown[]; calls: string[] }
expect(r.out).toEqual([11, null, 31])                    // nur Item 2 gedroppt
expect(r.calls).not.toContain("s2:2")                    // Reststufen von Item 2 übersprungen
expect(run.logs.some((l) => l.message.includes("pipeline item 2 dropped") && l.message.includes("stage1-boom"))).toBe(true)
```

- [ ] **Step 2: Rot verifizieren** — Run wie Task 1 Step 2, Expected: FAIL (Status `failed`).
- [ ] **Step 3: Typen** — in `P` jede `WorkflowPipelineFn`-Overload-Rückgabe von `Promise<A[]>`/`Promise<B[]>`/… auf `Promise<(A | null)[]>` usw. ändern (4 Overloads).
- [ ] **Step 4: Impl** — in `W`, pipeline-Item-Lambda (~Z.1192):

```ts
Effect.promise(async () => {
  let current: unknown = item
  try {
    for (const stage of stages) {
      checkpoint()
      current = await stage(current, item)
    }
    return current
  } catch (error) {
    // P2: eine werfende Stage droppt NUR dieses Item (null) und überspringt
    // dessen Reststufen; andere Items laufen weiter. Abbruch bleibt fatal.
    if (error instanceof WorkflowCancelledError) throw error
    input.active.run.logs.push({
      time: Date.now(),
      phase: input.active.run.current_phase,
      message: `pipeline item ${items.indexOf(item) + 1} dropped: ${error instanceof Error ? error.message : String(error)}`,
    })
    input.persist()
    return null
  }
})
```

(`items.indexOf` ist hier ok: Items sind die Original-Referenzen des Aufrufs. Falls der umgebende `Effect.forEach` bereits einen Index liefert, den stattdessen verwenden.)

- [ ] **Step 5: Grün + Bestand** (wie Task 1 Step 5) · **Step 6: Commit** `feat(workflow): pipeline() drops only the throwing item to null and skips its remaining stages`

### Task 3: deep-research-Builtin auf Null-Semantik umstellen

**Files:** Modify: `packages/opencode/src/workflow/builtin.ts` (DEEP_RESEARCH-Source-String), `T`

- [ ] **Step 1: Failing Test** — bestehenden Builtin-Load-Test ergänzen (Anker: `the deep-research builtin source compiles`):

```ts
expect(source).toContain(".filter(")   // Source filtert Nulls aus parallel-Ergebnissen
```

Zusätzlich statisch: `expect(source).not.toMatch(/findings\.some\(\(f\) => \(f\.data/)` schlägt fehl, solange der ungefilterte Zugriff existiert → präziser: nach Step 3 müssen `findings`/`verified` IMMER zuerst gefiltert werden.

- [ ] **Step 2: Rot verifizieren** (Run wie gehabt; Expected: FAIL).
- [ ] **Step 3: Impl** — im DEEP_RESEARCH-String nach jedem `ctx.parallel(...)`-Await filtern:

```ts
const findings = (await ctx.parallel(...)).filter((f) => f !== null)
...
const verified = (await ctx.parallel(..., { concurrencyLimit: 8 })).filter((v) => v !== null)
```

(Die beiden Aufrufstellen sind `ctx.setPhase("research")` und `ctx.setPhase("verify")`; Logik dahinter unverändert.)

- [ ] **Step 4: Grün** — auch der Import-frei-Guard (`not.toMatch(/^\s*import\b/m)`) muss weiter PASS sein. · **Step 5: Commit** `fix(workflow): deep-research filters dropped parallel results`

### Task 4: QW1 — Bus-Events `workflow.run.updated` / `workflow.run.finished`

**Files:**
- Modify: `W` (`persistRun` ~Z.633, `finish`-Pfad), neue Event-Definitionen
- Test: `T`

- [ ] **Step 1: Event-API grounden** (Lese-Step, kein Code):

Run: `sed -n '650,675p' packages/opencode/src/tool/workflow.ts && grep -rn "EventV2" packages/opencode/src/tool/workflow.ts | head -5`
Expected: das exakte Publish-Muster (Import + `publish`-Aufruf) der EventV2Bridge; dieses Muster in Step 4 1:1 übernehmen.

- [ ] **Step 2: Failing Test** — Anker: ein bestehender Test, der Events abonniert (`grep -n "subscribe" T` → nächstgelegenes Muster; existiert keins im Workflow-Test, das Muster aus dem Tool-/Server-Test übernehmen). Assertion-Kern:

```ts
const seen: Array<{ type: string; status: string; finished: boolean }> = []
// Subscription nach Anker-Muster auf "workflow.run.updated" + "workflow.run.finished"
const run = yield* workflow.start({ name: "two-phase" })   // Fixture mit 2 Phasen + 1 Agent-Stub
yield* workflow.wait({ id: run.id })
expect(seen.some((e) => e.type === "workflow.run.updated" && e.status === "running")).toBe(true)
expect(seen.at(-1)).toMatchObject({ type: "workflow.run.finished", status: "completed", finished: true })
// Schlanke Payload: KEIN agents-Array, nur Zähler
```

- [ ] **Step 3: Rot verifizieren.**
- [ ] **Step 4: Impl** — Event-Typen + Emission in `persistRun` (NACH erfolgreichem Write, damit Konsumenten nie einen Stand sehen, der nicht persistiert ist):

```ts
const WorkflowRunUpdated = /* EventV2-Definition nach Bridge-Muster, name: "workflow.run.updated" */
const WorkflowRunFinished = /* name: "workflow.run.finished" */

// in persistRun, nach dem Upsert-Effect:
Effect.tap(() =>
  publish(active.run.status === terminal ? WorkflowRunFinished : WorkflowRunUpdated, {
    id: active.run.id,
    workflow: active.run.workflow,
    status: active.run.status,
    current_phase: active.run.current_phase ?? null,
    directory: active.directory,
    agents: {
      total: active.run.agents.length,
      running: active.run.agents.filter((a) => a.status === "running").length,
      failed: active.run.agents.filter((a) => a.status === "failed").length,
    },
    pending_question: active.run.pending_question !== undefined,   // Feld kommt in Task 12; bis dahin `false`
    error: active.run.error ?? null,
  }),
)
```

(`terminal` = `completed|failed|cancelled|interrupted` — exakt die bestehende Status-Menge; `pending_question` bis Task 12 hart `false`.)

- [ ] **Step 5: Grün + Bestand** (voller `test/workflow/`-Lauf — `persistRun` ist heiß!). · **Step 6: Commit** `feat(workflow): publish workflow.run.updated/finished bus events from persistRun`

### Task 5: `ctx.budget`-Wrapper

**Files:** Modify: `P` (WorkflowContext), `W` (ContextApi + makeContext), `T`

- [ ] **Step 1: Failing Test** (Workflow-Source-Fixture):

```ts
async run(_args, ctx) {
  return { total: ctx.budget.total, spent: ctx.budget.spent(), remaining: ctx.budget.remaining() }
}
```

Start mit `budget: 5`; Assertions: `total === 5`, `spent === 0`, `remaining === 5`. Zweiter Start OHNE budget: `total === null`, `remaining === Infinity`... **Achtung:** `Infinity` überlebt JSON nicht — Fixture gibt `Number.isFinite(ctx.budget.remaining())` zurück und asserted `false`.

- [ ] **Step 2: Rot.** · **Step 3+4: Typ + Impl** in `makeContext` — zwei neue `Active`-Felder: `budgetTotal?: number` (bei `start()` aus dem validierten Budget) und `costSpent: number` (init 0; an der bestehenden Decrement-Stelle `budgetRemaining -= node.cost` zusätzlich `costSpent += node.cost`, IMMER, auch ohne Budget):

```ts
budget: {
  get total() { return input.active.budgetTotal ?? null },
  spent: () => input.active.costSpent,
  remaining: () =>
    input.active.budgetTotal === undefined
      ? Infinity
      : Math.max(0, input.active.budgetTotal - input.active.costSpent),
},
```

(`budgetRemaining`-Getter bleibt unverändert für Back-compat; `remaining()` rechnet bewusst aus `costSpent`, nicht aus `budgetRemaining`, damit beide Pfade unabhängig prüfbar sind.)

- [ ] **Step 5: Grün.** · **Step 6: Commit** `feat(workflow): ctx.budget {total, spent(), remaining()} alongside budgetRemaining`

### Task 6: `variant` auf AgentInput + `Provider.parseModel`-3-Segment-Fix

**Files:** Modify: `W` (AgentInput ~Z.374, Agent-Dispatch ~Z.1799), `P` (WorkflowAgentInput), Test: `T`

- [ ] **Step 1: parseModel grounden**: Run `grep -n "parseModel" packages/opencode/src/provider/* packages/opencode/src/workflow/workflow.ts | head` — Aufrufstelle + Signatur notieren.
- [ ] **Step 2: Failing Tests** (zwei): (a) Unit: `Provider.parseModel("anthropic/claude/max")` → `{providerID:"anthropic", modelID:"claude", variant:"max"}` (heute: modelID falsch). (b) Integration: Agent-Stub-Fixture mit `ctx.agent({prompt, variant:"max"})` — der Prompt-Spy (Anker: bestehende Agent-Dispatch-Tests mit Prompt-Stub) muss `variant:"max"` im PromptInput sehen.
- [ ] **Step 3: Rot.** · **Step 4: Impl**: `parseModel` splittet auf max. 3 Segmente (`provider/model[/variant]`); `AgentInput.variant?: string`; Dispatch reicht `variant: agentInput.variant ?? parsed.variant` in `prompt.prompt({...})` und `sessions.create` (falls Session-Create variant trägt — grounden, sonst nur Prompt).
- [ ] **Step 5: Grün + Bestand.** · **Step 6: Commit** `feat(workflow): per-step reasoning variant; parseModel understands provider/model/variant`

### Task 7: `model: "small"`-Schlüsselwort

**Files:** Modify: `W` (Dispatch ~Z.1693), Test: `T`

- [ ] **Step 1: Failing Test** — Config-Fixture mit `small_model: "stub/mini"`; `ctx.agent({prompt, model:"small"})` → Session-Create-Spy sieht `{providerID:"stub", modelID:"mini"}`.
- [ ] **Step 2: Rot.** · **Step 3: Impl**:

```ts
const modelInfo = agentInput.model === "small"
  ? Provider.parseModel(yield* resolveSmallModel())   // liest config.small_model; Fehler wenn unkonfiguriert: WorkflowInvalidError("model \"small\" requires small_model in config")
  : agentInput.model ? Provider.parseModel(agentInput.model) : selected.model
```

(`resolveSmallModel` liest über den bereits injizierten `Config.Service`; exaktes Config-Feld grounden: `grep -rn "small_model" packages/opencode/src/config packages/core/src | head -3`.)

- [ ] **Step 4: Grün.** · **Step 5: Commit** `feat(workflow): model:"small" routes to the configured small_model`

### Task 8: `tools`-Scoping pro Step

**Files:** Modify: `W` (AgentInput + sessions.create-Aufruf ~Z.1771), `P`, Test: `T`

- [ ] **Step 1: Grounden**: Run `grep -n "tools" packages/opencode/src/session/*.ts packages/core/src/public/agent.ts | head -8` — wie trägt eine Session/Agent-Config eine Tool-Whitelist (`Record<string, boolean>` mit Glob-Keys)? Exaktes Feld + Typ notieren.
- [ ] **Step 2: Failing Test** — Fixture `ctx.agent({prompt, tools: { "webfetch": false, "skill_*": true }})`; Session-Create-Spy sieht das tools-Objekt unverändert durchgereicht.
- [ ] **Step 3: Rot.** · **Step 4: Impl**: `AgentInput.tools?: Record<string, boolean>`; im Dispatch `sessions.create({ ..., tools: agentInput.tools })` (Feldname aus Step 1). Builtin deep-research bekommt in seinen research/verify-Agenten KEIN tools-Feld (Default bleibt) — aber der Source erhält einen Kommentar, dass Autoren Web-Tools so erzwingen können.
- [ ] **Step 5: Grün.** · **Step 6: Commit** `feat(workflow): per-step tools scoping on ctx.agent`

### Task 9: `skills`-Feld pro Step

**Files:** Modify: `W`, `P`, Test: `T`

- [ ] **Step 1: Grounden**: Run `grep -rn "skill" packages/opencode/src/session/prompt.ts packages/opencode/src/tool/registry.ts | head -10` — Mechanismus klären: Skills sind über das `skill`-Tool ladbar; Whitelisting läuft über tools (`skill`-Tool + erlaubte Namen) ODER Prompt-Injektion. **Entscheidungsregel (Spec §4.3):** wenn die Tool-Whitelist Skill-Namen granular abbilden kann → tools-Mechanik; sonst Prompt-Präfix `Load these skills before starting: <names>` als dokumentierter Mechanismus.
- [ ] **Step 2: Failing Test** gegen den in Step 1 gewählten Mechanismus (Spy auf Session-Create-tools ODER auf PromptInput-Text-Präfix).
- [ ] **Step 3: Rot → Impl → Grün.** `AgentInput.skills?: string[]`. · **Step 4: Commit** `feat(workflow): per-step skills on ctx.agent`

### Task 10: `files`-Anhänge pro Step

**Files:** Modify: `W` (Dispatch: PromptInput-Parts), `P`, Test: `T`

- [ ] **Step 1: Grounden**: Run `grep -n "parts" packages/opencode/src/session/prompt.ts | head -8` — exakte FilePart-Form im PromptInput (Vorbild: wie TUI File-Parts baut, `packages/tui/src/component/prompt/index.tsx`, FilePart-Konstruktion).
- [ ] **Step 2: Failing Test** — `ctx.agent({prompt, files:["./README.md"]})` → Prompt-Spy sieht 1 Text-Part + 1 File-Part mit absolutem Pfad/URL; nicht-existente Datei → `WorkflowInvalidError` mit Dateiname.
- [ ] **Step 3: Rot → Impl → Grün** (Pfade relativ zum Workspace-Directory des Runs auflösen; `Bun.file(p).exists()`-Check vor Dispatch). · **Step 4: Commit** `feat(workflow): declarative file attachments on ctx.agent`

### Task 11: `isolation: "worktree"`

**Files:** Modify: `W` (Dispatch + runScope-Finalizer), `P`, Test: `T`

- [ ] **Step 1: Failing Tests** (zwei): (a) in einem Git-Fixture-Repo: `ctx.agent({prompt, isolation:"worktree"})` → Session-Create-Spy sieht ein cwd/directory ≠ Workspace, das ein `.git`-File enthält; nach Run-Ende existiert das Worktree-Verzeichnis nicht mehr. (b) in einem Nicht-Git-Fixture: Run endet `failed`, `error` enthält `isolation: "worktree" requires a git repository`.
- [ ] **Step 2: Rot.** · **Step 3: Impl**:

```ts
if (agentInput.isolation === "worktree") {
  const base = path.join(os.tmpdir(), `oc-wf-${active.run.id}-${node.id}`)
  const res = Bun.spawnSync(["git", "worktree", "add", "--detach", base], { cwd: active.directory })
  if (res.exitCode !== 0) throw new WorkflowInvalidError(`isolation: "worktree" requires a git repository (${stderr})`)
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    Bun.spawnSync(["git", "worktree", "remove", "--force", base], { cwd: active.directory })
  }))   // am runScope, nicht am Step — überlebt parallele Steps, räumt bei Cancel auf
  sessionDirectory = base
}
```

(`sessionDirectory` → `sessions.create({ directory })`-Feld; exakten Feldnamen grounden: `grep -n "directory" packages/opencode/src/session/index.ts | head -5`.)

- [ ] **Step 4: Grün.** · **Step 5: Commit** `feat(workflow): per-agent git-worktree isolation`

### Task 11a: `ctx.shell(command, opts?)` — deterministische Steps ohne LLM

**Files:** Modify: `W` (ContextApi + makeContext), `P` (WorkflowContext.shell), Test: `T`

- [ ] **Step 1: Grounden**: Run `grep -n "shell" packages/opencode/src/session/prompt.ts | head -6` — Signatur von `SessionPrompt.shell` (Session-ID, command, agent?) + Rückgabeform notieren; außerdem prüfen, wie der Workflow-Layer an die Prompt-Ops kommt (`input.prompt` im Engine-Layer — dieselbe Injektion wie `prompt.prompt`/`prompt.cancel`).
- [ ] **Step 2: Failing Test** — Fixture:

```ts
async run(_args, ctx) {
  const ok = await ctx.shell("echo hello-workflow")
  const fail = await ctx.shell("exit 3")
  return { out: ok.output.trim(), okCode: ok.exitCode, failCode: fail.exitCode }
}
```

Assertions: `run.status === "completed"` (non-zero Exit wirft NICHT), `result.out === "hello-workflow"`, `okCode === 0`, `failCode === 3`; Budget-Felder unverändert (`ctx.budget.spent()` bleibt 0 — Shell zählt nicht aufs Budget).

- [ ] **Step 3: Rot.** · **Step 4: Impl**: `ContextApi.shell: (command: string, opts?: { timeout?: number; cwd?: string }) => Promise<{ output: string; exitCode: number }>`; Ausführung über die in Step 1 gegroundete `SessionPrompt.shell`-Vector in der Run-Container-Session (`active.run.session_id`), via `input.dispatch(...)` als Kind des Run-Scopes (abbrechbar), `checkpoint()` davor; Output/ExitCode aus dem Shell-Ergebnis mappen; KEIN `costSpent`/Budget-Touch.
- [ ] **Step 5: Grün + Bestand.** · **Step 6: Commit** `feat(workflow): ctx.shell for deterministic non-LLM steps`

### Task 11b: `ctx.workflow(name, args?)` — Nesting Tiefe 1

**Files:** Modify: `W` (ContextApi + makeContext + Depth-Flag auf Active), `P`, Test: `T`

- [ ] **Step 1: Failing Tests** (drei, ein Fixture-Paar `parent`/`child`):

```ts
// child.ts
export default { meta: { name: "child", description: "child" }, async run(args, ctx) {
  ctx.log("child-ran"); return { doubled: Number(args.n) * 2 }
} }
// parent.ts
export default { meta: { name: "parent", description: "parent" }, async run(_a, ctx) {
  const r = await ctx.workflow("child", { n: 21 })
  return { fromChild: (r as { doubled: number }).doubled }
} }
```

(a) `parent` → `completed`, `result.fromChild === 42`; es existiert GENAU EIN Run-Row (kein zweiter für child); Parent-Logs enthalten `child: child-ran` (Präfix). (b) Agent-Lifetime-Cap zählt Child-Agenten mit (Fixture: Child dispatcht 1 Agent-Stub, Parent-Limit via Test-Override auf 1 → zweiter Dispatch im Parent schlägt mit `WorkflowAgentLimitError` fehl). (c) `child` ruft selbst `ctx.workflow` → `WorkflowInvalidError` mit `nesting depth`.

- [ ] **Step 2: Rot.** · **Step 3: Impl**: `ContextApi.workflow: (name: string, args?: Record<string, unknown>) => Promise<unknown>`; Implementierung lädt via bestehendem Discovery+`loadModule`-Pfad (KEIN Permission-Ask — der Parent-Run ist bereits genehmigt; Kommentar im Code), `coerceArgs` gegen Child-Meta, baut einen Child-Context über `makeContext` mit DEMSELBEN `input.active`/`dispatch`/`persist`, aber: `logPrefix: name + ": "` (log/setPhase präfixieren) und `depth: 1`; bei `depth >= 1` wirft `ctx.workflow` sofort `WorkflowInvalidError("ctx.workflow nesting is limited to depth 1")`. Semaphore/Budget/Cap teilen sich automatisch über das geteilte `Active`.
- [ ] **Step 4: Grün + Bestand.** · **Step 5: Commit** `feat(workflow): ctx.workflow depth-1 nesting sharing caps, budget and abort scope`

### Task 12: Migration `pending_question` + Question-Persistenz-Fundament

**Files:**
- Create: `packages/core/src/database/migration/<timestamp>_workflow_run_pending_question.ts` (+ `packages/core/migration/<timestamp>_workflow_run_pending_question/{migration.sql,snapshot.json}` via Generator)
- Modify: `packages/core/src/workflow/sql.ts` (Spalte), `W` (Run-Schema + persistRun-Snapshot)

- [ ] **Step 1: Vorbild kopieren**: Run `cat packages/core/src/database/migration/20260606172815_workflow_run_paused_resume.ts` — exakt dieses Muster (11 Zeilen) für `pending_question TEXT` (JSON: `{question, options?, asked_at}`) nachbauen; `sql.ts`-Spalte ergänzen; Snapshot via `bun script/generate.ts` regenerieren (nur falls der Generator Migrations-Snapshots schreibt — sonst Snapshot-Verzeichnis des Vorbilds spiegeln).
- [ ] **Step 2: Test**: bestehender Migrations-/Schema-Test (Anker: `grep -n "paused_resume\|resume_of" T` → Schema-Roundtrip-Test kopieren) für `pending_question`: Run mit gesetzter Frage persistieren, lesen, Objekt identisch; Run ohne Frage → `undefined`.
- [ ] **Step 3: Rot → Impl → Grün.** `Run`-Schema: `pending_question: Schema.optional(Schema.Struct({ question: Schema.String, options: Schema.optional(Schema.Array(Schema.String)), asked_at: Schema.Number }))`; persistRun-Snapshot + readRuns-Decode symmetrisch zu `result`-Handling. Task-4-Event-Feld `pending_question` jetzt echt (`!== undefined`).
- [ ] **Step 4: Commit** `feat(workflow): pending_question column + run schema`

### Task 13: `ctx.question` — Live-Wait, Park, Answer, Journal-Replay

**Files:** Modify: `W` (ContextApi, makeContext, Journal-Node-Kinds, `answer()`-Service-Methode, resume-Replay), `P` (WorkflowContext.question), Test: `T`

- [ ] **Step 1: Failing Test A (Live-Antwort)** — Fixture:

```ts
async run(_args, ctx) {
  const a = await ctx.question({ question: "deploy?", options: ["yes", "no"] })
  return { answer: a.answer }
}
```

Testablauf: `start` → poll `workflow.get` bis `pending_question.question === "deploy?"` → `workflow.answer({ id, answer: "yes" })` → `wait` → `run.status === "completed"`, `result.answer === "yes"`, `pending_question === undefined`, Journal (`run.agents`) enthält einen Node mit `kind: "question"` und `answer: "yes"`.

- [ ] **Step 2: Failing Test B (Park + Resume)** — gleicher Fixture mit `timeout: 50` (ms, test-niedrig): `start` → `wait` kehrt mit `status === "paused"` zurück (Frage persistiert) → `workflow.answer({ id, answer: "no" })` → liefert NEUEN Run (resume_of = alter Run) → `wait(neu)` → `completed`, `result.answer === "no"`; der Frage-Step kam aus dem Journal-Replay (kein zweites Frage-Event).
- [ ] **Step 3: Rot (beide).** · **Step 4: Impl** in dieser Reihenfolge:
  1. Journal-Node-Kind: `AgentRun`-Schema um `kind: Schema.optional(Schema.Literals(["agent","question"]))` + `answer?: string` erweitern (JSON-kompatibel, keine Migration — Nodes leben im `agents`-JSON).
  2. `ctx.question(input)`: Node anlegen (`kind:"question"`, status `running`), `pending_question` setzen, persist (Event feuert mit Flag), dann `Deferred` erwarten mit Timeout-Race: Antwort → Node `completed` + `answer`, `pending_question` löschen, weiter; Timeout → `pause()`-Pfad des Runs auslösen (bestehende Maschinerie; Journal inkl. Frage-Node bleibt) und die Run-Body-Promise via CancelledError-Äquivalent beenden.
  3. Service-Methode `answer({id, answer})`: lebender Run mit offener Frage → Deferred füllen; geparkter Run (`paused` + `pending_question`) → intern `start({resume_of: id})` MIT der Antwort als vorab gefülltem Journal-Replay-Wert; sonst → `undefined` (HTTP-409-Mapping macht T-Tool).
  4. Resume-Replay: `journalKey` für question-Nodes = `[kind, question, phase]`; Replay liefert `{answer}` an den wartenden `ctx.question`-Aufruf (cached-Pfad analog Agent-Replay).
- [ ] **Step 5: Grün (A+B) + kompletter Bestand** (`bun test test/workflow/ --timeout 30000`) — besonders: bestehende pause/resume- und sweep-Tests unverändert grün. · **Step 6: Commit** `feat(workflow): ctx.question — live answer, timeout-park to paused, journal-replayed resume`

### Task 14: OTel-Spans

**Files:** Modify: `W` (Run-Body, setPhase, Agent-Dispatch), Test: `T`

- [ ] **Step 1: Grounden**: Run `sed -n '1,40p' packages/opencode/src/cli/cmd/run/otel.ts 2>/dev/null; grep -rn "withSpan" packages/opencode/src/tool/tool.ts | head -3` — Span-Konvention übernehmen.
- [ ] **Step 2: Test** (Anker: existierende Telemetrie-/deterministische Tests, Suche `telemetry` in `T`): Test-Tracer/Span-Collector des Harness nutzen; nach einem 1-Agent-Run existieren Spans `workflow.run`, `workflow.agent` mit Attributen `workflow.run_id`, `workflow.name`, `workflow.agent.model`. Wenn der Harness keinen Span-Collector hat: Spans via `Effect.withSpan` einbauen und stattdessen einen Smoke-Test, dass der Run unverändert grün läuft (Spans sind transparent) + manueller Nachweis `OTEL_...`-Lauf im Gate dokumentieren.
- [ ] **Step 3: Impl**: `dispatch`-Agent-Effect in `Effect.withSpan("workflow.agent", { attributes })`, Run-Body-Fiber in `Effect.withSpan("workflow.run", ...)`, `setPhase` annotiert das aktuelle Span-Event. · **Step 4: Grün + Commit** `feat(workflow): otel spans for run/phase/agent`

### Task 15: Strukturierte Phasen

**Files:** Modify: `packages/opencode/src/workflow/meta.ts`, `meta-reader.ts`, `W` (setPhase-Warnung, Phase-Default-Model im Dispatch), `P` (workflow()-Helper-Typ), Test: `T` + `packages/opencode/test/workflow/meta-reader.test.ts`

- [ ] **Step 1: Failing Tests**: (a) meta-reader: `phases: ["a", { title: "b", model: "stub/mini", detail: "x" }]` wird statisch gelesen (`meta.phases[1].title === "b"`); (b) Engine: Agent OHNE model in Phase "b" → Session-Create-Spy sieht `stub/mini`; expliziter `ctx.agent({model})` gewinnt; (c) `setPhase("undeclared")` → Warn-Log `phase "undeclared" is not declared in meta.phases`, kein Fehler.
- [ ] **Step 2: Rot → Impl → Grün.** Schema: `Schema.Union(Schema.String, Schema.Struct({title, detail?, model?}))`-Array; intern auf `{title, detail?, model?}[]` normalisieren (eine Stelle, direkt nach dem Read). · **Step 3: Commit** `feat(workflow): structured phases with per-phase default model`

### Task 16: Track-Gate + Doku-Stub

**Files:** Modify: `packages/core/src/plugin/skill/workflows-instructions.md` (NUR neue Engine-Felder nüchtern listen — die redaktionelle Doku macht T-Docs)

- [ ] **Step 1: Voll-Gate**

Run:
```bash
cd packages/opencode && bun run typecheck && bun test test/workflow/ test/tool/workflow.test.ts --timeout 30000 2>&1 | tail -4
cd ../plugin && bun run typecheck 2>/dev/null || npx tsgo --noEmit
```
Expected: alles grün.

- [ ] **Step 2: Kontrakt-Freeze-Notiz** — am Ende von `docs/superpowers/plans/2026-06-07-workflows-mega-pr-master.md` unter Task 3 die finalen Signaturen (AgentInput, ContextApi, Event-Payloads, answer()-Service) als „Phase-1-Kontrakt (frozen)" einfügen — Input für die T2–T6-Plan-Generierung.
- [ ] **Step 3: Commit + Review-Trigger**

```bash
git add -A && git commit -m "docs(workflow): instructions stub for new engine surface; freeze phase-1 contract"
```

Danach: Zwischenreview (Master-Plan Task 2 Step 1) anfordern.
