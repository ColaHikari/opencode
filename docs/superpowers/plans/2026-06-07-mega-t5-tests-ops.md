# Mega Phase-2 Track T5 — Tests/Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the genuine test/ops gaps the review found on top of the large Phase-1 coverage — resume-replay edge cases, orphan-sweep vs question runs, a full HTTP workflow lifecycle e2e, a budget-race AUDIT (test-pin, no fix), a gitlab finding, and a `/init` "Available workflows" section — without re-testing anything Phase 1 already pins.

**Architecture:** All work lands in the worktree `/Users/manuelguttmann/Projekte/oc-mega-t1` (branch `mega/t5-tests`, which already contains the merged Phase 1 + T2 + T3 + T4). Tests use the established Effect test harnesses (`testEffect` + `it.instance` in `test/workflow/`, `testEffect` + `it.live` + `provideTmpdirInstance` in `test/command/`, and the real `httpApiLayer` + `requestInDirectory` harness in `test/server/`). The only non-test code change is one engine-adjacent comment at the budget gate and the `/init` template injection in `src/command/index.ts`. **No SDK regen** (that is Phase 3, central).

**Tech Stack:** TypeScript, Bun test runner, Effect (`Effect.gen`, `Layer`, `Deferred`), Drizzle (in-memory SQLite via `Database.defaultLayer`), the Effect `HttpApi` test server (`@effect/platform-node` `NodeHttpServer.layerTest`).

---

## Grounding: what Phase 1 already covers (DO NOT re-test)

Read these before writing any test. They are the reason most of the §5.4 "gaps" are already closed; only the deltas below are genuine.

**Resume-replay (`packages/opencode/test/workflow/workflow.test.ts`), ALREADY covered — skip:**

- `"resume replays the completed agent from the journal and runs the rest live"` (line 4223) — A cached, B live, `resume_of` on the row, `cached:true`.
- `"resume caches two identical prompts separately by occurrence"` (line 4315) — occurrence index.
- `"resume with invalidate_agents reruns the named index live and caches the rest"` (line 4386) — `invalidate_agents:[0]`.
- `"resume from a completed source run fails with WorkflowInvalidError"` (line 4445) and `"... from a cancelled source run ..."` (line 4477) — status guards.
- `"a schema call matching a plaintext journal node runs live instead of defecting"` (line 4518) — schema/journal drift.
- `"ctx.question waits live for an answer, records it on the journal node, clears pending_question"` (line 4584).
- `"an unanswered ctx.question times out, parks as paused, and answer() resumes serving the reply"` (line 4637).
- `"answer() forwards prompt ops so a resumed run can dispatch agents after the question"` (line 4679) — question parks, resume runs the LIVE agent after replaying the question.

**Orphan-sweep, ALREADY covered — skip:**

- `"orphaned running rows are marked interrupted on service start"` (line 2352).
- `"orphan sweep normalizes still-running agent nodes to failed"` (line 2371) — Fund 15.
- `"sweep leaves paused rows untouched"` (line 4168) — but the paused row here has NO `pending_question` (genuine gap below).
- `"cancel on a paused run transitions it to cancelled"` (line 4196).

**Budget, ALREADY covered — skip:**

- `"agent calls beyond exhausted budget fail the run with a budget error"` (line 2959).
- `"parallel steps all pass the gate and overspend; the next step fails (soft cap)"` (line 2993) — Fund 23: 3 parallel à 0.5, budget 1.0, a Deferred barrier holds all 3 until all pass the gate ⇒ overspend to −0.5, next step fails. **This already proves the documented soft-cap overspend deterministically.** Task 4 adds only the minimal "2 agents, budget for 1" framing the review asked for plus a gate comment — NOT a fix.
- `"budgetRemaining reflects real spend during the run"` (3027), `"ctx.budget exposes total/spent()/remaining()"` (3136), etc.

**HTTP, ALREADY covered — skip:**

- `test/server/httpapi-workflow-answer.test.ts` only asserts the route `POST /workflow/run/{id}/answer` is registered in the OpenAPI spec. It does NOT exercise any lifecycle (genuine gap below).

**`/init` / commands, ALREADY covered — skip:**

- `test/command/workflow-source.test.ts` proves workflows become `Command.Info` entries (`source:"workflow"`) and that a name colliding with a built-in (`init`) keeps `source:"command"`. It does NOT test the init PROMPT template content (genuine gap below).

**Budget-race code AUDIT verdict (for Task 4):** In `src/workflow/workflow.ts` the `agent = async (agentInput) => { … }` body (lines 2080–2131) runs the abort gate, the `budgetRemaining <= 0` gate (line 2090), the lifetime gate, `active.agentStarted += 1`, and pushes the node ALL SYNCHRONOUSLY — there is no `await`/`yield` between the budget check and `dispatch(...)` (line 2131). The actual spend (`active.budgetRemaining -= node.cost`, line 2539) happens inside an `Effect.ensuring` that runs AFTER the prompt completes, behind `active.agentSemaphore.withPermits(1)` (line 2550) which is acquired INSIDE the dispatched effect. So multiple `ctx.parallel` tasks each call `agent()` and all pass the synchronous gate before any of them spends — exactly the documented best-effort soft cap, not a hidden hard-limit violation. **Verdict: benign-by-design. Deliverable = a pin test + a one-line gate comment. NO `SynchronizedRef.modify` reservation fix.**

**gitlab finding (for Task 5):** `grep -rln "gitlab" packages/opencode/src --include="*.ts"` hits only `plugin/index.ts` (auth plugin import), `provider/provider.ts` (a model provider `gitlab-ai-provider`), and `session/llm.ts`. There is NO gitlab command/webhook handler. The github engine-bypass concern lives in `src/cli/cmd/github.handler.ts`, which drives `Session`/`SessionPrompt` directly (bypassing the workflow engine). **There is no gitlab equivalent, so the engine-bypass question is github-only — a one-line documented finding, no code.**

**`/init` seam (for Task 6):** `/init` is a built-in Command built in `src/command/index.ts` (line 79, `commands[Default.INIT]`); its `template` getter returns `PROMPT_INITIALIZE.replace("${path}", ctx.worktree)` where `PROMPT_INITIALIZE` is `./template/initialize.txt`. The same `init` gen already resolves `yield* workflow.list()` (line 165). `Workflow.list()` returns `Info[]` with `.valid`, `.name`, and `.meta.description` / `.meta.whenToUse`. So the section is computed once at build time and baked into the template string.

---

## File Structure

- **Modify** `packages/opencode/test/workflow/workflow.test.ts` — add 3 resume-replay edge-case tests (Task 1) + 2 orphan-sweep-vs-question tests (Task 2) + 1 budget-race pin test (Task 4). Reuses the existing fixtures/helpers (`writeWorkflow`, `recordingPromptOps`, `immediatePromptOps`, `pollWithTimeout`, `QUESTION_TIMEOUT_WORKFLOW`, `seedRunningRow`, `WorkflowRunTable`, `reloadTestInstance`). New fixture constants are added near the existing fixture block (~line 1296–1400).
- **Create** `packages/opencode/test/server/httpapi-workflow-lifecycle.test.ts` — full HTTP lifecycle e2e (Task 3) via `httpApiLayer` + `requestInDirectory`.
- **Modify** `packages/opencode/src/workflow/workflow.ts:2090` — one explanatory comment at the budget gate (Task 4). No logic change.
- **Modify** `packages/opencode/src/command/index.ts` — inject an "Available workflows" section into the `/init` template (Task 6).
- **Create** `packages/opencode/test/command/init-workflows.test.ts` — TDD for the `/init` section (Task 6).
- **Append** a "Findings" appendix to THIS plan file (Task 5: gitlab) — documented finding, no code file.

---

## Task 1: Resume-replay genuine gaps (3 tests)

The replay basics, occurrence index, single-index `invalidate_agents:[0]`, status guards, schema drift, and the three question-resume flows are all pinned (see Grounding). The genuine gaps are: (1a) `invalidate_agents` at a NON-zero index combined with a kept earlier agent (proves the index is honored positionally, not just "rerun the first"); (1b) a fully-cached MIXED journal (question + agent) replayed on a single resume where BOTH come from the journal and NEITHER is re-asked/re-prompted; (1c) resume across a simulated engine restart via `reloadTestInstance` (the re-layer seam exists in the fixture but is never used for resume).

**Files:**

- Test: `packages/opencode/test/workflow/workflow.test.ts` (add tests after the existing `invalidate_agents` test, ~line 4438; add fixtures near line 1400)

- [ ] **Step 1: Write the failing test for invalidate_agents at a non-zero index**

Add this fixture next to `RESUME_WORKFLOW` (the existing two-agent fixture at ~line 1316 already has agents A then B). Reuse it; no new fixture needed. Add the test after line 4438:

```ts
// T5 gap (invalidate_agents positional): the existing invalidate test only
// rebuilds index [0]. Pin that a NON-zero index reruns ONLY that agent live
// while the EARLIER agent stays cached — proving the index is honored
// positionally, not "always rerun the first". RESUME_WORKFLOW dispatches A
// (index 0) then B (index 1); invalidate_agents:[1] must rerun B live, cache A.
it.instance("resume with invalidate_agents reruns a NON-zero index live and caches the earlier agent", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Effect.promise(() => writeWorkflow(test.directory, RESUME_FIXTURE, RESUME_WORKFLOW))
    const workflow = yield* Workflow.Service
    const { db } = yield* Database.Service

    const firstOps = recordingPromptOps(db, 0)
    const first = yield* workflow.start({ name: RESUME_FIXTURE, args: {}, prompt: firstOps.ops })
    const firstDone =
      (yield* workflow.wait({ id: first.id })).run ?? (yield* Effect.fail(new Error("first run did not finish")))
    expect(firstDone.status).toBe("completed")

    // completed → paused so it is a legitimate resume source (journal kept).
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

    const { ops: resumeOps, prompted } = recordingPromptOps(db, 0)
    const resumed = yield* workflow.start({
      name: RESUME_FIXTURE,
      args: {},
      prompt: resumeOps,
      resume_of: first.id,
      invalidate_agents: [1],
    })
    const done =
      (yield* workflow.wait({ id: resumed.id })).run ?? (yield* Effect.fail(new Error("resume did not finish")))
    expect(done.status).toBe("completed")
    // Only B (index 1) reran live; A (index 0) came from the journal.
    expect(prompted).toContain("agent B")
    expect(prompted).not.toContain("agent A")
    const agentA = done.agents.find((a) => a.prompt === "agent A")
    expect(agentA?.cached).toBe(true)
    const agentB = done.agents.find((a) => a.prompt === "agent B")
    expect(agentB?.cached).not.toBe(true)
  }),
)
```

- [ ] **Step 2: Run it to verify it fails (or passes) and confirm the assertion is real**

Run: `cd packages/opencode && bun test test/workflow/workflow.test.ts -t "NON-zero index" --timeout 30000 2>&1 | tail -15`
Expected: If the engine already honors positional indices, this PASSES (it pins behavior the suite did not assert before). If `invalidate_agents` were mis-implemented as "rerun first", it FAILS at `expect(prompted).toContain("agent B")`. Either way the assertion is real — confirm the test actually ran (not skipped). If it passes, that is the intended outcome for a pin test; proceed.

- [ ] **Step 3: Write the failing test for a fully-cached MIXED (question + agent) journal replay**

The existing `q-then-agent` resume (line 4679) reruns the agent LIVE. The gap: a resume where BOTH the question AND the following agent are served from the journal (no re-ask, no re-prompt). Add this fixture near line 1400:

```ts
// T5 gap (mixed cached replay): a workflow that asks a question THEN dispatches
// an agent. On the first run both complete (question answered live, agent
// prompted live). On a resume of the parked/paused run, BOTH must come from the
// journal: the question is NOT re-asked (no pending_question) and the agent is
// NOT re-prompted (recordingPromptOps records nothing).
const MIXED_REPLAY_FIXTURE = "mixed-question-agent"
const MIXED_REPLAY_WORKFLOW = `export const meta = { name: "${MIXED_REPLAY_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const a = await ctx.question({ question: "ship?", options: ["yes", "no"] })
  const r = await ctx.agent({ prompt: "do-" + a.answer })
  return { answer: a.answer, work: r.text }
}
`
```

Add the test after the Step 1 test:

```ts
// T5 gap (fully-cached mixed journal): question + agent BOTH replayed from the
// journal on a single resume. The existing q-then-agent test reruns the agent
// LIVE; here neither is re-executed.
it.instance("resume replays a question AND a following agent both from the journal without re-running either", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Effect.promise(() => writeWorkflow(test.directory, MIXED_REPLAY_FIXTURE, MIXED_REPLAY_WORKFLOW))
    const workflow = yield* Workflow.Service
    const { db } = yield* Database.Service

    // First run: answer the question live, agent runs live with a recorded prompt.
    const firstOps = recordingPromptOps(db, 0)
    const first = yield* workflow.start({ name: MIXED_REPLAY_FIXTURE, args: {}, prompt: firstOps.ops })
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const current = yield* workflow.get(first.id)
        return current?.pending_question?.question === "ship?" ? current : undefined
      }),
      "pending question never appeared",
    )
    yield* workflow.answer({ id: first.id, answer: "yes" })
    const firstDone =
      (yield* workflow.wait({ id: first.id })).run ?? (yield* Effect.fail(new Error("first mixed run did not finish")))
    expect(firstDone.status).toBe("completed")
    expect(firstOps.prompted).toContain("do-yes")
    const firstResult = firstDone.result as { answer: string; work: string }
    expect(firstResult.answer).toBe("yes")

    // completed → paused so it is a legitimate resume source (journal kept).
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

    // Resume: BOTH the question and the agent are served from the journal.
    const { ops: resumeOps, prompted } = recordingPromptOps(db, 0)
    const resumed = yield* workflow.start({
      name: MIXED_REPLAY_FIXTURE,
      args: {},
      prompt: resumeOps,
      resume_of: first.id,
    })
    const done =
      (yield* workflow.wait({ id: resumed.id })).run ?? (yield* Effect.fail(new Error("mixed resume did not finish")))
    expect(done.status).toBe("completed")
    // No agent was re-prompted on the resume — it came from the journal.
    expect(prompted).toHaveLength(0)
    // The question was NOT re-asked: no open pending_question on the resumed run.
    expect(done.pending_question).toBeUndefined()
    // Both journal nodes are present and the result matches the first run.
    const qnode = done.agents.find((a) => a.kind === "question")
    expect(qnode?.answer).toBe("yes")
    const anode = done.agents.find((a) => a.prompt === "do-yes")
    expect(anode?.cached).toBe(true)
    expect(done.result).toEqual(firstResult)
  }),
)
```

- [ ] **Step 4: Run it to verify behavior**

Run: `cd packages/opencode && bun test test/workflow/workflow.test.ts -t "both from the journal" --timeout 30000 2>&1 | tail -15`
Expected: PASS (pins that a mixed journal fully replays). If the question replay path does not clear `pending_question` on resume, it FAILS at `expect(done.pending_question).toBeUndefined()` — a real regression the test would catch.

- [ ] **Step 5: Write the failing test for resume across a simulated engine restart**

The fixture import is `reloadTestInstance` from `../fixture/fixture`. Add it to the existing import line (`import { TestInstance, provideInstance, tmpdirScoped } from "../fixture/fixture"`) → add `reloadTestInstance`. This test runs OUTSIDE `it.instance` (which owns the instance lifecycle); use a `tmpdirScoped`-based `it.live` shape so the test controls reload. Add after the Step 3 test:

```ts
// T5 gap (resume after engine restart): the resume path is proven within ONE
// service lifetime; here we PROVE it survives a process restart. A run parks as
// paused (its journal persisted in SQLite), then we reload the instance
// (reloadTestInstance → fresh Workflow.Service over the SAME directory/DB,
// running the startup orphan sweep). The reload must NOT touch the paused row
// (it has no live fiber by design but is parked, not lost), and a resume started
// by the fresh service must still replay the journaled question from disk.
it.live("a resume after an engine restart (service re-layer) replays the journaled question from disk", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    yield* Effect.promise(() => writeWorkflow(directory, QUESTION_TIMEOUT_FIXTURE, QUESTION_TIMEOUT_WORKFLOW))

    // Lifetime 1: start the run; its 50ms-timeout question parks it as paused
    // with the open question persisted on the row.
    const pausedId = yield* Effect.gen(function* () {
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: QUESTION_TIMEOUT_FIXTURE, args: {}, prompt: immediatePromptOps() })
      const paused =
        (yield* workflow.wait({ id: run.id })).run ?? (yield* Effect.fail(new Error("timeout run did not settle")))
      expect(paused.status).toBe("paused")
      expect(paused.pending_question?.question).toBe("deploy?")
      return run.id
    }).pipe(provideInstance(directory))

    // Restart: drop the instance and rebuild a fresh one over the SAME directory.
    yield* Effect.promise(() => reloadTestInstance({ directory }))

    // Lifetime 2: the fresh service ran its startup sweep. The paused row must be
    // intact (not swept to interrupted), and answer() must start a resume that
    // replays the question from disk and completes.
    yield* Effect.gen(function* () {
      const workflow = yield* Workflow.Service
      const reloaded = yield* workflow.get(pausedId)
      expect(reloaded?.status).toBe("paused")
      expect(reloaded?.pending_question?.question).toBe("deploy?")
      const resumed = yield* workflow.answer({ id: pausedId, answer: "no" })
      expect(resumed).toBeDefined()
      expect(resumed!.resume_of).toBe(pausedId)
      const done =
        (yield* workflow.wait({ id: resumed!.id })).run ??
        (yield* Effect.fail(new Error("post-restart resume did not finish")))
      expect(done.status).toBe("completed")
      expect((done.result as { answer: string }).answer).toBe("no")
      const replayed = done.agents.find((a) => a.kind === "question")
      expect(replayed?.answer).toBe("no")
    }).pipe(provideInstance(directory))
  }),
)
```

- [ ] **Step 6: Run it to verify behavior**

Run: `cd packages/opencode && bun test test/workflow/workflow.test.ts -t "engine restart" --timeout 30000 2>&1 | tail -20`
Expected: PASS. If the startup sweep wrongly swept the paused row, it FAILS at `expect(reloaded?.status).toBe("paused")`. If the journal did not survive across the re-layer, the resume fails. NOTE: `it.live` is the harness variant that does NOT auto-provide an instance — confirm it exists (`grep -n "it.live\|\.live" test/lib/effect.ts`); if the harness for this file only exposes `it.instance`, fall back to wrapping the whole body in a single `it.instance` is NOT possible (it owns one lifetime). Instead use the raw `testEffect`-built `it` exported in this file — it exposes `.live` (see `test/command/workflow-source.test.ts` which uses `it.live`). The `it` const in `workflow.test.ts` is built the same way, so `it.live` is available.

- [ ] **Step 7: Run the full workflow suite to confirm no regression**

Run: `cd packages/opencode && bun test test/workflow/workflow.test.ts --timeout 30000 2>&1 | tail -6`
Expected: all tests pass (existing + 3 new).

- [ ] **Step 8: Commit**

```bash
cd /Users/manuelguttmann/Projekte/oc-mega-t1
git add packages/opencode/test/workflow/workflow.test.ts
git commit -m "test(workflow): resume-replay gaps — non-zero invalidate index, fully-cached mixed journal, resume after engine restart (T-Tests)"
```

---

## Task 2: Orphan-sweep vs question runs (2 tests)

`"sweep leaves paused rows untouched"` (line 4168) uses a paused row WITHOUT a `pending_question`. The §5.4 gaps are: (2a) sweep must leave a paused row that carries a persisted `pending_question` untouched AND preserve the question (so a later answer can still resume); (2b) the orphan sweep must NOT interrupt a LIVE-waiting question run (it has a live fiber by design, so the live-id set passed to `sweep()` protects it).

**Files:**

- Test: `packages/opencode/test/workflow/workflow.test.ts` (add after the existing sweep tests, ~line 4192)

- [ ] **Step 1: Write the failing test for sweep vs paused-with-pending_question**

Reuse the direct-insert pattern from the existing `"sweep leaves paused rows untouched"` test (line 4168). Add after it:

```ts
// T5 gap (sweep vs parked question): the existing "leaves paused rows untouched"
// test uses a paused row WITHOUT a pending_question. A run parked by an
// unanswered ctx.question carries a persisted pending_question; the sweep must
// leave BOTH the paused status AND the question intact so a later answer() can
// still resume it.
it.instance("sweep leaves a paused run that carries a pending_question untouched (status + question preserved)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const workflow = yield* Workflow.Service
    const { db } = yield* Database.Service
    const pausedId = "job_paused_pending_question"
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
        agents: [
          {
            id: "1",
            status: "completed",
            started_at: now,
            completed_at: now,
            kind: "question",
            prompt: "deploy?",
            answer: undefined,
          },
        ],
        pending_question: { question: "deploy?", options: ["yes", "no"], asked_at: now },
      })
      .run()
      .pipe(Effect.orDie)

    yield* workflow.sweep()

    const row = yield* fetchRunRow(pausedId)
    expect(row.status).toBe("paused")
    // The persisted question survives the sweep.
    expect(row.pending_question?.question).toBe("deploy?")
    expect(row.pending_question?.options).toEqual(["yes", "no"])
    // The open question node is not flipped to failed (it is a parked question,
    // not a lost running agent).
    const qnode = row.agents.find((a) => a.kind === "question")
    expect(qnode?.status).not.toBe("failed")
  }),
)
```

- [ ] **Step 2: Run it to verify behavior**

Run: `cd packages/opencode && bun test test/workflow/workflow.test.ts -t "carries a pending_question untouched" --timeout 30000 2>&1 | tail -15`
Expected: PASS. If the sweep stripped `pending_question` or flipped the paused status, it FAILS — a real ops regression (a parked question would become un-answerable). NOTE: confirm `fetchRunRow` decodes `pending_question` (the engine schema includes it at `Run` line 225); if `fetchRunRow` returns the raw row, read `row.pending_question` as the decoded object.

- [ ] **Step 3: Write the failing test for sweep NOT interrupting a live-waiting question run**

A live `ctx.question` run has a real fiber; `sweep()` is called with the set of currently-live ids, so it must skip it. Reuse `QUESTION_WORKFLOW` (line 1368, no timeout → waits live) and `immediatePromptOps`. Add after the Step 1 test:

```ts
// T5 gap (sweep vs live-waiting question): a run blocked LIVE on ctx.question
// has a real fiber by design — the sweep (which only heals fiber-less zombie
// running rows) must NOT interrupt it. Start the question run, wait until its
// pending_question is live, sweep, and assert it is still running and still
// answerable.
it.instance("sweep does not interrupt a run waiting live on a question", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Effect.promise(() => writeWorkflow(test.directory, QUESTION_FIXTURE, QUESTION_WORKFLOW))
    const workflow = yield* Workflow.Service

    const run = yield* workflow.start({ name: QUESTION_FIXTURE, args: {}, prompt: immediatePromptOps() })
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const current = yield* workflow.get(run.id)
        return current?.pending_question?.question === "deploy?" ? current : undefined
      }),
      "pending question never appeared",
    )

    // sweep() keys off the live-id set; the live-waiting run must be protected.
    yield* workflow.sweep()

    const afterSweep = yield* workflow.get(run.id)
    expect(afterSweep?.status).toBe("running")
    expect(afterSweep?.pending_question?.question).toBe("deploy?")

    // Still answerable: the live fiber resolves and the run completes.
    yield* workflow.answer({ id: run.id, answer: "yes" })
    const done =
      (yield* workflow.wait({ id: run.id })).run ?? (yield* Effect.fail(new Error("live question run did not finish")))
    expect(done.status).toBe("completed")
    expect((done.result as { answer: string }).answer).toBe("yes")
  }),
)
```

- [ ] **Step 4: Run it to verify behavior**

Run: `cd packages/opencode && bun test test/workflow/workflow.test.ts -t "waiting live on a question" --timeout 30000 2>&1 | tail -15`
Expected: PASS. If the sweep interrupted the live run, the status would be `interrupted` and the answer/wait would fail — a real correctness bug the test catches.

- [ ] **Step 5: Run the full workflow suite**

Run: `cd packages/opencode && bun test test/workflow/workflow.test.ts --timeout 30000 2>&1 | tail -6`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/manuelguttmann/Projekte/oc-mega-t1
git add packages/opencode/test/workflow/workflow.test.ts
git commit -m "test(workflow): orphan-sweep vs question runs — parked pending_question preserved, live-waiting run not interrupted (T-Tests)"
```

---

## Task 3: HTTP lifecycle e2e through the real httpapi

`httpapi-workflow-answer.test.ts` only checks route registration. The genuine gap is a full lifecycle sequence through the REAL `httpApiLayer` + `requestInDirectory`: start → (question) answer (live) → completed; and start → pause → (answer-as-resume) → completed; and start → cancel. Use a workflow fixture that ONLY uses `ctx.question` (no `ctx.agent`) so no LLM is needed — the question waits live, the answer route resolves it. For pause/cancel, a hanging-question (tiny-timeout) fixture parks as paused; cancel is exercised on a live-waiting question run.

**Files:**

- Create: `packages/opencode/test/server/httpapi-workflow-lifecycle.test.ts`

Read first: `packages/opencode/test/server/httpapi-workflow-answer.test.ts` (imports), `packages/opencode/test/server/httpapi-layer.ts` (`httpApiLayer`, `request`, `requestInDirectory`), and a representative directory-scoped server test for the harness shape: `packages/opencode/test/server/httpapi-session.test.ts` (how `tmpdirScoped` + `x-opencode-directory` + the `it`/`testEffectShared` harness are wired). The workflow routes are `POST /workflow/:name/start`, `POST /workflow/run/:id/answer`, `POST /workflow/run/:id/cancel`, `GET /workflow/run/:id` (see `src/server/routes/instance/httpapi/groups/workflow.ts:62`). The answer payload is `{ answer: string }`; start payload is optional.

- [ ] **Step 1: Inspect the server-test harness to copy the exact boot shape**

Run: `cd packages/opencode && grep -n "testEffectShared\|httpApiLayer\|requestInDirectory\|tmpdirScoped\|x-opencode-directory\|it.live\|it.instance" test/server/httpapi-session.test.ts | head -25`
Expected: shows the harness const (`const it = testEffectShared(httpApiLayer)` or similar) and the `requestInDirectory(path, directory, init)` usage. Copy that exact harness construction into the new file. Confirm the workflow file must live under `<directory>/.opencode/workflows/<name>.ts` (same as `writeWorkflow` in the unit suite) so discovery picks it up under the request directory.

- [ ] **Step 2: Write the failing lifecycle e2e test**

```ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { testEffectShared } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

// Full HTTP lifecycle through the REAL instance httpapi (the answer-route test
// only checks registration; this drives the actual request sequence). The
// fixtures use ONLY ctx.question (no ctx.agent), so no LLM/prompt-ops are needed:
// the question waits live and the answer route resolves it.
const it = testEffectShared(httpApiLayer)

const LIVE_Q = `export const meta = { name: "http-live-q", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const a = await ctx.question({ question: "deploy?", options: ["yes", "no"] })
  return { answer: a.answer }
}
`
const PARK_Q = `export const meta = { name: "http-park-q", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const a = await ctx.question({ question: "deploy?", options: ["yes", "no"], timeout: 50 })
  return { answer: a.answer }
}
`

async function writeWorkflow(dir: string, name: string, source: string) {
  const workflows = path.join(dir, ".opencode", "workflows")
  await fs.mkdir(workflows, { recursive: true })
  await Bun.write(path.join(workflows, `${name}.ts`), source)
}

async function readJson(res: { json: () => Promise<unknown> }) {
  return res.json() as Promise<Record<string, unknown>>
}

async function poll<T>(fn: () => Promise<T | undefined>, label: string, attempts = 100): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const r = await fn()
    if (r !== undefined) return r
    await new Promise((res) => setTimeout(res, 25))
  }
  throw new Error("poll timed out: " + label)
}

describe("workflow HTTP lifecycle e2e", () => {
  it.live("start -> question -> answer (live) completes through the httpapi", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => writeWorkflow(directory, "http-live-q", LIVE_Q))

      const startRes = yield* requestInDirectory("/workflow/http-live-q/start", directory, { method: "POST" })
      expect(startRes.status).toBe(200)
      const started = yield* Effect.promise(() => readJson(startRes))
      const id = started["id"] as string
      expect(id).toMatch(/^job/)

      // Poll GET until the pending question is live.
      yield* Effect.promise(() =>
        poll(async () => {
          const res = await Effect.runPromise(requestInDirectory(`/workflow/run/${id}`, directory))
          const run = (await res.json()) as Record<string, any>
          return run?.pending_question?.question === "deploy?" ? run : undefined
        }, "pending question via GET"),
      )

      // Answer it live.
      const answerRes = yield* requestInDirectory(`/workflow/run/${id}/answer`, directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes" }),
      })
      expect(answerRes.status).toBe(200)
      const answered = yield* Effect.promise(() => readJson(answerRes))
      // Live answer returns the SAME run id (resolved in place).
      expect(answered["id"]).toBe(id)

      // Poll GET until completed.
      const done = yield* Effect.promise(() =>
        poll(async () => {
          const res = await Effect.runPromise(requestInDirectory(`/workflow/run/${id}`, directory))
          const run = (await res.json()) as Record<string, any>
          return run?.status === "completed" ? run : undefined
        }, "run completed via GET"),
      )
      expect((done as any).result).toEqual({ answer: "yes" })
    }),
  )

  it.live("start -> park (timeout) -> answer-as-resume -> completed through the httpapi", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => writeWorkflow(directory, "http-park-q", PARK_Q))

      const startRes = yield* requestInDirectory("/workflow/http-park-q/start", directory, { method: "POST" })
      const started = yield* Effect.promise(() => readJson(startRes))
      const id = started["id"] as string

      // Poll GET until the 50ms-timeout parks it as paused with the question kept.
      yield* Effect.promise(() =>
        poll(async () => {
          const res = await Effect.runPromise(requestInDirectory(`/workflow/run/${id}`, directory))
          const run = (await res.json()) as Record<string, any>
          return run?.status === "paused" && run?.pending_question?.question === "deploy?" ? run : undefined
        }, "run parked paused via GET"),
      )

      // answer() on a PARKED run returns a NEW resumed run (resume_of = parked id).
      const answerRes = yield* requestInDirectory(`/workflow/run/${id}/answer`, directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "no" }),
      })
      expect(answerRes.status).toBe(200)
      const resumed = yield* Effect.promise(() => readJson(answerRes))
      expect(resumed["id"]).not.toBe(id)
      expect(resumed["resume_of"]).toBe(id)
      const resumedId = resumed["id"] as string

      const done = yield* Effect.promise(() =>
        poll(async () => {
          const res = await Effect.runPromise(requestInDirectory(`/workflow/run/${resumedId}`, directory))
          const run = (await res.json()) as Record<string, any>
          return run?.status === "completed" ? run : undefined
        }, "resumed run completed via GET"),
      )
      expect((done as any).result).toEqual({ answer: "no" })
    }),
  )

  it.live("start -> cancel (live-waiting question) transitions to cancelled through the httpapi", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => writeWorkflow(directory, "http-live-q", LIVE_Q))

      const startRes = yield* requestInDirectory("/workflow/http-live-q/start", directory, { method: "POST" })
      const started = yield* Effect.promise(() => readJson(startRes))
      const id = started["id"] as string

      yield* Effect.promise(() =>
        poll(async () => {
          const res = await Effect.runPromise(requestInDirectory(`/workflow/run/${id}`, directory))
          const run = (await res.json()) as Record<string, any>
          return run?.pending_question?.question === "deploy?" ? run : undefined
        }, "pending question via GET"),
      )

      const cancelRes = yield* requestInDirectory(`/workflow/run/${id}/cancel`, directory, { method: "POST" })
      expect(cancelRes.status).toBe(200)
      const cancelled = yield* Effect.promise(() => readJson(cancelRes))
      expect(cancelled["status"]).toBe("cancelled")

      // 409 on answering a run with no open question (now terminal).
      const lateAnswer = yield* requestInDirectory(`/workflow/run/${id}/answer`, directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes" }),
      })
      expect(lateAnswer.status).toBe(409)
    }),
  )
})
```

- [ ] **Step 3: Run it to verify behavior**

Run: `cd packages/opencode && bun test test/server/httpapi-workflow-lifecycle.test.ts --timeout 30000 2>&1 | tail -25`
Expected: all 3 pass. Common failure to resolve here: the harness const — if `testEffectShared`/`it.live` is not the pattern this repo's server tests use, copy the EXACT harness from `httpapi-session.test.ts` (Step 1). The response object from `requestInDirectory` is an Effect `HttpClientResponse`; if `.json()`/`.status` are not directly available, use `res.json` via the Effect response API exactly as `httpapi-session.test.ts` reads bodies (adapt `readJson`/status access to that shape). Also confirm the answer 409 status maps from the engine's "no open question" path (`ConflictError`, declared at `groups/workflow.ts:186`).

- [ ] **Step 4: Confirm the registration test still passes (no overlap, no breakage)**

Run: `cd packages/opencode && bun test test/server/httpapi-workflow-answer.test.ts --timeout 30000 2>&1 | tail -5`
Expected: PASS (unchanged).

- [ ] **Step 5: Commit**

```bash
cd /Users/manuelguttmann/Projekte/oc-mega-t1
git add packages/opencode/test/server/httpapi-workflow-lifecycle.test.ts
git commit -m "test(server): HTTP workflow lifecycle e2e — start/question/answer/pause-resume/cancel through the real httpapi (T-Tests)"
```

---

## Task 4: Budget-race AUDIT (pin test + gate comment, NO fix)

**Verdict (grounded, see Grounding):** benign-by-design. The budget gate and `agentStarted` increment run synchronously in the `agent` async body with no `await` before `dispatch(...)`; the spend happens in `Effect.ensuring` after the prompt, behind the per-run semaphore acquired INSIDE the dispatched effect. The existing Fund-23 test (line 2993, 3 parallel à 0.5 / budget 1.0) already proves the soft-cap overspend deterministically. This task adds the precise "2 parallel agents, budget for 1" framing the review asked for as an additional pin, plus a one-line comment at the gate documenting why the soft cap is intentional. **No `SynchronizedRef.modify` reservation.**

**Files:**

- Modify: `packages/opencode/src/workflow/workflow.ts:2090` (comment only)
- Test: `packages/opencode/test/workflow/workflow.test.ts` (add after the Fund-23 soft-cap test, ~line 3025)

- [ ] **Step 1: Write the failing/pin test for "2 parallel agents, budget for 1"**

This reuses the same barrier mechanism as the Fund-23 test so it is deterministic, not timing-dependent. Check the existing helpers: `budgetBarrierPromptOps(db, costPerAgent, count)` and `BUDGET_PARALLEL_WORKFLOW` (used by the Fund-23 test at line 2993, declared near the budget fixtures). If `BUDGET_PARALLEL_WORKFLOW` takes `args.count`, parametrize with `count: 2`. Add after line 3025:

```ts
// T5 budget-race AUDIT (verdict: benign soft cap, no fix). The review asked
// specifically: "2 parallel agents, budget for exactly 1 — does the second
// double-spend BEYOND the documented soft cap?" Deterministic proof via the
// same Deferred barrier as the Fund-23 test: 2 agents à 1.0, budget 1.0. The
// barrier holds BOTH until both have passed the synchronous gate, so both
// charge ⇒ overspend to -1.0 (exactly one extra step's worth, the cost already
// in flight). This is the DOCUMENTED soft cap — NOT an unbounded race: the gate
// refuses any FURTHER step once the budget is non-positive. This test pins that
// boundary so a future refactor that turns the soft cap into either a hard limit
// OR an unbounded leak fails here.
it.instance(
  "budget-race audit: 2 parallel agents with budget for 1 overspend by exactly one step (soft cap, bounded)",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, BUDGET_PARALLEL_FIXTURE, BUDGET_PARALLEL_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: BUDGET_PARALLEL_FIXTURE,
        args: { count: 2 },
        prompt: budgetBarrierPromptOps(db, 1, 2),
        budget: 1,
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      const result = done.run?.result as { overspent: number; nextStarted: boolean; nextFailed: boolean }
      // Exactly one extra step's worth of overspend: 2 * 1.0 charged against a 1.0
      // budget ⇒ remaining -1.0. Bounded, not unbounded.
      expect(result.overspent).toBeCloseTo(-1, 10)
      // Both parallel steps charged (the in-flight cost), and exactly two nodes
      // exist — no third step slipped past the gate.
      const completed = done.run?.agents.filter((a) => a.status === "completed") ?? []
      expect(completed.length).toBe(2)
      expect(done.run?.agents.length).toBe(2)
      // The NEXT sequential step after exhaustion is refused (bounded soft cap).
      expect(result.nextStarted).toBe(true)
      expect(result.nextFailed).toBe(true)
    }),
)
```

- [ ] **Step 2: Run it; if the fixture body does not expose `overspent`/`nextStarted`/`nextFailed` for count:2, reconcile**

Run: `cd packages/opencode && bun test test/workflow/workflow.test.ts -t "budget-race audit" --timeout 30000 2>&1 | tail -20`
Expected: PASS. If `BUDGET_PARALLEL_WORKFLOW` hardcodes 3 agents instead of reading `args.count`, read its definition (`grep -n "BUDGET_PARALLEL_WORKFLOW =" test/workflow/workflow.test.ts`) and EITHER pass the count it expects and adjust the `overspent` math, OR add a sibling fixture `BUDGET_PARALLEL2_WORKFLOW` that dispatches exactly 2 parallel agents then one sequential step (copy the existing fixture's body, change the loop bound to 2). Keep the assertion math consistent with the chosen cost/budget.

- [ ] **Step 3: Add the gate comment (documentation only, no logic change)**

In `packages/opencode/src/workflow/workflow.ts`, at the budget gate (line 2090, `if (active.budgetRemaining <= 0) {`), append to the existing comment block above it (lines 2084–2089) one sentence pinning the audited semantics. Edit the existing comment:

Find (line 2087–2089):

```ts
// Once the prior steps have consumed the whole budget we refuse to spend
// again: fail the step with a BudgetExceededError, which propagates like
// any other agent failure (node `failed`, run `failed` unless caught).
```

Replace with:

```ts
// Once the prior steps have consumed the whole budget we refuse to spend
// again: fail the step with a BudgetExceededError, which propagates like
// any other agent failure (node `failed`, run `failed` unless caught).
// AUDITED soft cap (T5): this gate + the post-step spend (ensuring, below)
// run on SEPARATE turns, so N parallel ctx.parallel tasks can all pass this
// synchronous check before any of them charges ⇒ a run may overspend by the
// combined cost of the steps already in flight. That overspend is BOUNDED
// (the next step after exhaustion is refused here), so it is best-effort by
// design, not an unbounded leak — no atomic reservation is needed. Pinned by
// "budget-race audit: 2 parallel agents with budget for 1 …".
```

- [ ] **Step 4: Run the full budget block + typecheck**

Run: `cd packages/opencode && bun run typecheck && bun test test/workflow/workflow.test.ts -t "budget" --timeout 30000 2>&1 | tail -10`
Expected: typecheck clean; all budget tests pass (the comment change is inert).

- [ ] **Step 5: Commit**

```bash
cd /Users/manuelguttmann/Projekte/oc-mega-t1
git add packages/opencode/test/workflow/workflow.test.ts packages/opencode/src/workflow/workflow.ts
git commit -m "test(workflow): budget-race audit — pin bounded soft-cap overspend (2 agents, budget 1); document gate semantics, no fix (T-Tests)"
```

---

## Task 5: gitlab finding (documented, no code)

Grounded: there is NO gitlab command/webhook handler in `packages/opencode/src`. `gitlab` appears only as a model provider (`provider/provider.ts`, `gitlab-ai-provider`), an auth plugin import (`plugin/index.ts`), and a provider id reference (`session/llm.ts`). The github engine-bypass concern lives in `src/cli/cmd/github.handler.ts`, which drives `Session`/`SessionPrompt` directly (bypassing the workflow engine). With no gitlab equivalent, the engine-bypass question is github-only — nothing to fix.

**Files:**

- Append to: this plan file (`docs/superpowers/plans/2026-06-07-mega-t5-tests-ops.md`) — the "Findings" appendix at the bottom.

- [ ] **Step 1: Re-verify the finding holds at execution time (the worktree may have advanced)**

Run:

```bash
cd /Users/manuelguttmann/Projekte/oc-mega-t1
grep -rln "gitlab" packages/opencode/src --include="*.ts"
ls packages/opencode/src/cli/cmd/ | grep -iE "gitlab|github"
```

Expected: gitlab hits are only `provider/provider.ts`, `plugin/index.ts`, `session/llm.ts` (model-provider scope); `cmd/` lists `github.handler.ts` (and `github*.ts`) but NO `gitlab*` file. If a gitlab handler HAS since appeared, escalate: that turns this into a real audit task (read it, compare to `github.handler.ts`'s `Session`-direct bypass) — STOP and flag to the orchestrator rather than silently documenting "none".

- [ ] **Step 2: Record the finding in this plan's appendix**

Append the "Findings" appendix (see bottom of this file) text confirming: no gitlab workflow-trigger handler exists; engine-bypass is github-only via `src/cli/cmd/github.handler.ts`; no code change in T5.

- [ ] **Step 3: Commit**

```bash
cd /Users/manuelguttmann/Projekte/oc-mega-t1
git add docs/superpowers/plans/2026-06-07-mega-t5-tests-ops.md
git commit -m "docs(t5): document gitlab finding — no gitlab handler exists; engine-bypass is github-only (T-Tests)"
```

---

## Task 6: `/init` — "Available workflows" section in the generated AGENTS.md prompt

The `/init` command is prompt-template driven (`src/command/template/initialize.txt`); the model writes AGENTS.md from that prompt. The seam is `src/command/index.ts` `commands[Default.INIT]` (line 79), whose `template` getter renders `PROMPT_INITIALIZE.replace("${path}", ctx.worktree)`. The same `init` gen already resolves `yield* workflow.list()` (line 165). Inject an "Available workflows" section (names + descriptions) into the rendered init template ONLY when at least one VALID workflow exists. TDD against the existing command-discovery harness.

**Files:**

- Modify: `packages/opencode/src/command/index.ts` (init command body, ~line 74–87 and the `workflow.list()` loop at ~line 165)
- Test: `packages/opencode/test/command/init-workflows.test.ts` (new)

Read first: `packages/opencode/src/command/index.ts` (lines 66–198 — the layer, the `init` gen, the existing `workflow.list()` loop), `packages/opencode/test/command/workflow-source.test.ts` (the exact harness: `testEffect(Layer.mergeAll(Command.defaultLayer, CrossSpawnSpawner.defaultLayer))`, `provideTmpdirInstance`, `writeWorkflow`), and `Workflow.Info` (`src/workflow/workflow.ts:76` — `.valid`, `.name`, `.meta.description`, `.meta.whenToUse`).

- [ ] **Step 1: Write the failing test for the init template carrying a workflows section**

```ts
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Command } from "@/command"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Command.defaultLayer, CrossSpawnSpawner.defaultLayer))

async function writeWorkflow(dir: string, name: string, source: string) {
  const workflows = path.join(dir, ".opencode", "workflows")
  await fs.mkdir(workflows, { recursive: true })
  await Bun.write(path.join(workflows, `${name}.ts`), source)
}

const DEPLOY = `export const meta = { name: "deploy", description: "Ship the app to prod.", phases: ["run"] }
export async function run(args, ctx) { ctx.setPhase("run"); return { ok: true } }
`
const AUDIT = `export const meta = { name: "audit", whenToUse: "Run a security audit pass.", phases: ["run"] }
export async function run(args, ctx) { ctx.setPhase("run"); return { ok: true } }
`

async function initTemplate() {
  const command = await Effect.runPromise(Command.Service.pipe(Effect.flatMap((c) => c.get("init"))) as any)
  return typeof command.template === "string" ? command.template : await command.template
}

describe("/init lists available workflows in its AGENTS.md prompt", () => {
  afterEach(() => disposeAllInstances())

  it.live("the init template includes an Available workflows section with names + descriptions", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeWorkflow(dir, "deploy", DEPLOY))
        yield* Effect.promise(() => writeWorkflow(dir, "audit", AUDIT))
        const command = yield* Command.Service
        const init = yield* command.get("init")
        const template =
          typeof init!.template === "string" ? init!.template : yield* Effect.promise(() => init!.template)
        expect(template).toContain("Available workflows")
        expect(template).toContain("deploy")
        expect(template).toContain("Ship the app to prod.")
        expect(template).toContain("audit")
        // Falls back to whenToUse when description is absent.
        expect(template).toContain("Run a security audit pass.")
        // The base init prompt is preserved.
        expect(template).toContain("Create or update `AGENTS.md`")
      }),
    ),
  )

  it.live("the init template has NO workflows section when no workflows exist", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        const init = yield* command.get("init")
        const template =
          typeof init!.template === "string" ? init!.template : yield* Effect.promise(() => init!.template)
        expect(template).not.toContain("Available workflows")
        expect(template).toContain("Create or update `AGENTS.md`")
      }),
    ),
  )

  it.live("a broken (invalid) workflow file is not listed in the init template", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeWorkflow(dir, "broken", "this is not a valid workflow module"))
        const command = yield* Command.Service
        const init = yield* command.get("init")
        const template =
          typeof init!.template === "string" ? init!.template : yield* Effect.promise(() => init!.template)
        // No valid workflows ⇒ no section at all.
        expect(template).not.toContain("Available workflows")
        expect(template).not.toContain("broken")
      }),
    ),
  )
})
```

Remove the unused `initTemplate` helper if the inline `init.template` resolution is used in every test (it is — delete the helper to keep the file lint-clean).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/opencode && bun test test/command/init-workflows.test.ts --timeout 30000 2>&1 | tail -20`
Expected: FAIL — the first test fails at `expect(template).toContain("Available workflows")` because the init template does not yet include the section.

- [ ] **Step 3: Implement the section injection in `src/command/index.ts`**

The `workflow.list()` loop is at line 165. Compute the rendered section in the SAME gen (before building `commands[Default.INIT]`, since the loop currently runs after). Move the list resolution up OR compute the section from a separate `workflow.list()` (cheap; discovery is static). Add, inside the `init` gen near the top (after `const commands = {}` at line 77), a section builder, then use it in the INIT template getter.

Add after line 77 (`const commands: Record<string, Info> = {}`):

```ts
// T5 (/init): surface discovered workflows in the generated AGENTS.md prompt
// so the init pass documents them. Names + descriptions (falling back to
// whenToUse). Only VALID workflows are listed; the section is omitted
// entirely when none exist, so a repo with no workflows gets the unchanged
// prompt. list() is the static (never-executed) reader — safe at build time.
const initWorkflows = (yield * workflow.list()).filter((wf) => wf.valid !== false)
const workflowsSection =
  initWorkflows.length === 0
    ? ""
    : "\n\n## Available workflows\n\nThis repository defines OpenCode workflows. Mention them in `AGENTS.md` so future sessions know they exist:\n\n" +
      initWorkflows
        .map((wf) => {
          const desc = wf.meta.description ?? wf.meta.whenToUse
          return desc ? `- \`${wf.name}\` — ${desc}` : `- \`${wf.name}\``
        })
        .join("\n")
```

Then change the INIT template getter (line 83–85) from:

```ts
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
```

to:

```ts
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree) + workflowsSection
        },
```

Then DELETE the now-redundant separate `workflow.list()` loop at lines 165–177 ONLY IF it is still needed for command discovery — it IS (it registers workflows as `source:"workflow"` commands), so DO NOT delete it. Keep both: the new `initWorkflows` (for the init prompt section) and the existing loop (for command registration). They both call `workflow.list()`; that is acceptable (static, cached via InstanceState). To avoid a double call, reuse `initWorkflows` in the existing loop: change line 165 `for (const wf of yield* workflow.list()) {` to `for (const wf of initWorkflows) {` — note `initWorkflows` already filtered out invalid ones, and the loop's own `if (wf.valid === false) continue` (line 166) becomes redundant but harmless; leave it for clarity OR remove it. Keep the change minimal: reuse `initWorkflows` in the loop.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/opencode && bun test test/command/init-workflows.test.ts --timeout 30000 2>&1 | tail -15`
Expected: all 3 pass.

- [ ] **Step 5: Confirm the existing command-discovery test still passes (the loop change is safe)**

Run: `cd packages/opencode && bun test test/command/workflow-source.test.ts --timeout 30000 2>&1 | tail -8`
Expected: PASS (workflows still register as `source:"workflow"`; `init` collision still keeps `source:"command"`).

- [ ] **Step 6: Typecheck + commit**

Run: `cd packages/opencode && bun run typecheck 2>&1 | tail -5`
Expected: clean.

```bash
cd /Users/manuelguttmann/Projekte/oc-mega-t1
git add packages/opencode/src/command/index.ts packages/opencode/test/command/init-workflows.test.ts
git commit -m "feat(init): append 'Available workflows' section to the /init AGENTS.md prompt from Workflow.list() (T-Tests)"
```

---

## Task 7: Track gate (final verification)

**Files:** none (verification only).

- [ ] **Step 1: Typecheck opencode**

Run: `cd packages/opencode && bun run typecheck 2>&1 | tail -5`
Expected: no errors.

- [ ] **Step 2: Run the affected suites**

Run:

```bash
cd packages/opencode && bun test test/workflow/workflow.test.ts test/server/httpapi-workflow-lifecycle.test.ts test/server/httpapi-workflow-answer.test.ts test/command/init-workflows.test.ts test/command/workflow-source.test.ts --timeout 30000 2>&1 | tail -10
```

Expected: all pass (existing workflow suite + the new resume/sweep/budget tests + the HTTP lifecycle e2e + both command tests).

- [ ] **Step 3: Run the full workflow + server + command suites (regression guard)**

Run:

```bash
cd packages/opencode && bun test test/workflow/ test/server/ test/command/ --timeout 30000 2>&1 | tail -12
```

Expected: green. If a pre-existing unrelated server test is flaky/red on this base, note it explicitly (do NOT attribute it to T5) and re-run the specific T5 files to confirm they pass in isolation.

- [ ] **Step 4: Final commit if anything is uncommitted**

Run: `cd /Users/manuelguttmann/Projekte/oc-mega-t1 && git status --short`
Expected: clean (all task commits already landed). If anything dangling, commit it with a descriptive message. **Do NOT merge, do NOT push — Phase 3 owns integration. No SDK regen.**

---

## Findings appendix

### gitlab handler (Task 5) — DOCUMENTED FINDING, no code change

- `grep -rln "gitlab" packages/opencode/src --include="*.ts"` hits only model-provider/auth scope: `src/provider/provider.ts` (the `gitlab-ai-provider` model provider + discovery), `src/plugin/index.ts` (`opencode-gitlab-auth` plugin import), `src/session/llm.ts` (provider-id reference).
- There is NO gitlab command/webhook/trigger handler under `src/cli/cmd/` (only `github.handler.ts` / `github*.ts` exist).
- The "engine-bypass" concern the review raised (a handler that starts work by driving `Session`/`SessionPrompt` directly instead of going through the workflow engine) applies ONLY to `src/cli/cmd/github.handler.ts`. That file imports `Session`, `SessionPrompt`, `EventV2Bridge` and dispatches prompts itself — a deliberate CI/automation path, not a workflow-engine consumer.
- **Conclusion:** no gitlab equivalent exists, so there is nothing to bring onto (or bypass) the workflow engine for gitlab. No T5 code change. If a gitlab handler appears in a future upstream sync, re-open this as a real audit (compare against the github bypass).
- **Execution-time re-verification (T5 run):** confirmed at HEAD `ee96042cb`+ — `grep -rln "gitlab" packages/opencode/src --include="*.ts"` → `src/plugin/index.ts`, `src/provider/provider.ts`, `src/session/llm.ts` only; `ls packages/opencode/src/cli/cmd/ | grep -iE "gitlab|github"` → `github.handler.ts`, `github.shared.ts`, `github.ts`, NO `gitlab*` file. Finding holds; finding-only, no code.

---

## Self-Review

**Spec §5.4 coverage:**

- Resume-replay (incl. question steps): Phase 1 covers the bulk; Task 1 adds the 3 genuine gaps (non-zero invalidate index, fully-cached mixed journal, resume-after-restart). ✓
- Orphan-sweep: Phase 1 covers orphan→interrupted, node normalization, plain-paused-untouched, cancel-on-paused; Task 2 adds the 2 genuine gaps (paused-with-pending_question, live-waiting question run). ✓
- HTTP lifecycle e2e (start→question→answer→pause→resume→cancel): Task 3, new file, real httpapi. ✓
- Budget-race (audit; fix only if confirmed): Task 4 — audited benign, pin test + gate comment, NO `SynchronizedRef.modify` fix (the existing Fund-23 test already proves the soft cap; Task 4 adds the precise 2-agent framing). ✓
- gitlab check: Task 5 — documented finding, no handler exists, github-only bypass. ✓
- `/init` "Available workflows": Task 6 — template injection from `Workflow.list()`, TDD against the command harness, omitted when no workflows. ✓
- Track gate (workflow+server+cli/command suites, typecheck, no SDK regen): Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows the actual test/impl code; exact paths and line anchors given; the only deliberate "reconcile at execution" notes are for harness-shape details that depend on reading the sibling test file (Step 1 of Task 3, Step 2 of Task 4) — these point at the exact file to copy from, not vague guidance.

**Type/name consistency:** Test helpers reused verbatim from the existing suite (`writeWorkflow`, `recordingPromptOps`, `immediatePromptOps`, `budgetBarrierPromptOps`, `pollWithTimeout`, `WorkflowRunTable`, `fetchRunRow`, `reloadTestInstance`, `provideInstance`, `tmpdirScoped`, `TestInstance`). Route paths (`/workflow/:name/start`, `/workflow/run/:id/answer|cancel`, `GET /workflow/run/:id`) match `groups/workflow.ts`. `Workflow.Info` fields (`valid`, `name`, `meta.description`, `meta.whenToUse`) match `workflow.ts:76` and `meta.ts:51`. The `init` template getter and `workflow.list()` call site match `command/index.ts:79,165`.

**Task count:** 6 implementation tasks (Tasks 1–4, 6 produce real tests/code: 6 new workflow-suite tests + 3 HTTP e2e tests + 1 budget pin + 3 command tests + 1 init code change + 1 gate comment) + 1 finding-only task (Task 5, gitlab) + 1 gate task (Task 7).
