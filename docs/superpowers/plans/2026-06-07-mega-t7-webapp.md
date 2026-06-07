# Mega T7 — Port the FULL workflow UI to the opencode WEB APP (`packages/app`)

Branch: `mega/t7-webapp` · Worktree: `/Users/manuelguttmann/Projekte/oc-mega-t7`

PLAN ONLY. Do not implement from this document in the same pass; execute it task-by-task with TDD.

## Goal

Bring the desktop window (the Solid renderer in `packages/app`, shown by the Electron shell) to TUI parity for workflows:

1. `/ultracode` session toggle + standalone `ultracode` keyword injection on submit.
2. `/workflow ` starter command and `/workflows` dashboard command; surface every DISCOVERED `/<name>` workflow command and dispatch it like the TUI.
3. A full workflow dashboard panel: live run list, run detail (phases / agents / result / usage), pause/resume, save-run-as-command.
4. A question dialog: surface a run's `pending_question`, answer via `workflow.answer`, follow the resumed run.
5. i18n strings for all of the above.

The TUI is the reference implementation. The web app currently has NONE of this — it only renders server custom commands in the slash popover (`packages/app/src/components/prompt-input.tsx:677-699`) and, on submit, dispatches them via `session.command` (`packages/app/src/components/prompt-input/submit.ts:458-489`). There is no `/workflow` routing, no ultracode, no dashboard.

---

## Load-bearing grounding (verified, with file:line)

### Command system (`packages/app/src/context/command.tsx`)
- `CommandOption` shape: `{ id, title, description?, category?, keybind?, slash?, suggested?, disabled?, hidden?, onSelect?(source?: "palette"|"keybind"|"slash"), onHighlight? }` (`command.tsx:75-87`).
- Dynamic registration: `register(key, cb)` / `register(cb)` where `cb: () => CommandOption[]`; keyed registrations are replaced via `upsertCommandRegistration` (`command.tsx:388-403`, `command.tsx:105-108`). `onCleanup` removes the registration.
- Dispatch: `command.trigger(id, source)` → `run(id, source)` → `optionMap().get(id)?.onSelect?.(source)` (`command.tsx:352-355`, `command.tsx:407-409`). `optionMap` keys both the full id and `actionId(id)` (`command.tsx:343-350`).
- `command.options` (getter, `command.tsx:432-434`) is the resolved option list including a duplicated `suggested.*` block.
- Server command store: `sdk.command.list()` → `setStore("command", x.data ?? [])` in BOTH `packages/app/src/context/server-sync.tsx:226-227` (per-directory child via `onMcp`) and `packages/app/src/context/global-sync/bootstrap.ts:258`. These populate `sync.data.command` (used by the prompt input).
- **Source filtering — there is NONE.** The slash list is built in `prompt-input.tsx:677-699`: `builtin` from `command.options.filter(opt => !disabled && !id.startsWith("suggested.") && opt.slash)`, plus `custom` = `sync.data.command.map(...)` with NO `source` filter. So `source: "workflow"` discovered commands ALREADY surface in the slash popover. The slash-popover badge only special-cases `source !== "command"` for a label (`slash-popover.tsx:119-127`); nothing drops them. **No "unfilter" change is needed** — the gap is purely DISPATCH (see below).

### The DISPATCH gap (the real work for §2)
- TUI: a discovered workflow surfaces as `/<name>` and is routed exactly like `/workflow <name>` (`packages/tui/src/component/prompt/workflow-autocomplete.ts:workflowCommandOptions`), and on submit `parseWorkflowCommand` (`packages/tui/src/component/dialog-workflow-helpers.ts:193-203`) decides dashboard-vs-start, then `index.tsx:1184-1265` calls `sdk.client.workflow.start({ name, workflowStartPayload: { args, permissionSessionID } })`.
- Web app today: selecting a `custom` slash entry only inserts `"/<trigger> "` text (`prompt-input.tsx:706-712`); on SUBMIT, ANY `/<name>` that matches `sync.data.command` is sent through `session.command` (`submit.ts:458-489` and the followup path `submit.ts:75-105`). A workflow command IS a server command (it shows in `command.list()`), so today it would be sent as a plain `session.command` rather than a `workflow.start`. **We must intercept `/workflow`, `/workflows`, and discovered `/<name>` workflow names BEFORE the generic `session.command` branch and route them to `workflow.start` / the dashboard.**
- Decision: keep the web app's behavior of running `/<name>` as `session.command` for genuine custom commands, and ALSO support `/workflow <name>` + `/workflows` explicitly. For the per-name `/<name>` parity, route a name to `workflow.start` only when that name resolves to a `workflow.list()` entry (and is NOT shadowed by a real command). This mirrors the TUI's `workflowCommandOptions` shadow filter.

### Slash popover + prompt input (`packages/app/src/components/prompt-input.tsx`, `prompt-input/slash-popover.tsx`, `prompt-input/submit.ts`)
- Slash detection on input: `/^\/(\S*)$/` match opens the `"slash"` popover (`prompt-input.tsx:945-952`).
- `handleSlashSelect` (`prompt-input.tsx:701-717`): custom → insert text; builtin → `command.trigger(cmd.id, "slash")`.
- Prompt-input already has all the contexts wired: `command` (`:141`), `dialog` (`:139`), `sdk` (`:128`), `sync` (`:132`), `prompt` (`:135`), `language`. It already calls `command.register("prompt-input", ...)` at `:512-537`. This is the natural home for the new commands and the ultracode toggle state.
- SUBMIT path: `createPromptSubmit` in `submit.ts:205-589`. The leading-`/` command branch is `submit.ts:458-489`; the shell branch is `:439-456`; the normal prompt build is `:491-582` (`sendFollowupDraft` builds `parts` via `buildRequestParts`). The followup-send path `sendFollowupDraft` has its own `/command` branch at `submit.ts:75-105`. **Ultracode directive injection and `/workflow` routing both belong in `handleSubmit` (`submit.ts:292`), before the existing `/command` branch.**

### Ultracode helpers — must be RE-GROUNDED (cannot be imported)
- The pure helpers live ONLY in the TUI: `packages/tui/src/component/prompt/ultracode.ts` (`detectUltracodeKeyword`, `stripUltracodeKeyword`, `ULTRACODE_PROMPT_DIRECTIVE`, `ULTRACODE_SESSION_DIRECTIVE`) and the `/workflow` parsing in `packages/tui/src/component/dialog-workflow-helpers.ts` + `workflow-autocomplete.ts`.
- `@opencode-ai/tui` is `private: true` and is NOT a dependency of `@opencode-ai/app` (verified: app deps are `@opencode-ai/core`, `@opencode-ai/sdk`, `@opencode-ai/ui`). The tui's `exports` map does NOT expose `./component/prompt/ultracode` or `./component/dialog-workflow-helpers`. There is no shared `@opencode-ai/core` home for them either.
- **Conclusion: copy the pure helpers verbatim into `packages/app/src/components/prompt-input/` (new files), keeping them pure and unit-tested.** They are tiny, dependency-free string functions and `WorkflowInfo`/`WorkflowRun`-typed derivations. Do not introduce a tui dependency. (If a future refactor wants a shared package, that is out of scope here.)

### Dialog / panel system (`@opencode-ai/ui/context/dialog`)
- API: `dialog.show(element, onClose?)`, `dialog.push(...)`, `dialog.close()`, `dialog.active` (`packages/ui/src/context/dialog.tsx:181-196`). NOTE: there is NO `replace` (the TUI uses `dialog.replace`); the web equivalent is `dialog.show`.
- Existing dialogs are lazy-imported then `dialog.show(() => <X .../>)` — e.g. `dialog-select-mcp`, `dialog-fork`, `dialog-select-model` (`packages/app/src/pages/session/use-session-commands.tsx:219-265`). Components use `<Dialog title=... description=...>` + `<List>` from `@opencode-ai/ui` (`packages/app/src/components/dialog-select-mcp.tsx`).

### Live runs — the event-subscription seam
- The per-directory SDK exposes a typed event emitter: `sdk.event.on(type, cb)` / `sdk.event.listen(cb)` over the union `Event` (`packages/app/src/context/server-sdk.tsx:293-304`, the `SDKEventMap`). `sdk.event` is the dir-scoped emitter created in `createDirSdkContext`.
- Usage pattern (subscribe + `onCleanup`): `packages/app/src/pages/session.tsx:719-729` (`sdk.event.listen(evt => { if (evt.details.type !== "..." ) return; ... })`).
- The generated `Event` union HAS `workflow.run.updated` and `workflow.run.finished` members (`packages/sdk/js/src/v2/gen/types.gen.ts:1476-1511`). Their `properties` carry `{ id, workflow, status, current_phase, directory, agents:{total,running,failed}, pending_question: boolean, error }` — a LEAN shape (no full agent array; `pending_question` is a boolean here, not the question object).
- **Dashboard strategy (mirror TUI `dialog-workflow.tsx:425-437`):** subscribe to `workflow.run.*` for instant refetch, PLUS a 1s `setInterval` poll fallback (`workflow.runs()`), cleared on cleanup. The run list refetches; the lean event only triggers a refetch (the web port can simply refetch rather than overlay, matching the TUI's `void refetch()` on every event; the TUI's `mergeRunEvent` overlay is an optimization we can skip initially).

### SDK client — full workflow surface CONFIRMED present
- `packages/sdk/js/src/v2/gen/sdk.gen.ts:5054-5316` defines class `Workflow` with: `list(params?)`, `runs(params?)`, `delete({id})`, `get({id})`, `start({name, workflowStartPayload?})`, `cancel({id})`, `pause({id})`, `answer({id, workflowAnswerPayload?})`. All accept `directory?`/`workspace?` query params. `sdk.client.workflow` is the getter (`sdk.gen.ts:6239-6241`).
- `start()` returns `WorkflowRun` (`types.gen.ts:9816-9820`); it carries `session_id?`.
- Types present: `WorkflowInfo` (`types.gen.ts:2815-2822`, has `name/path/meta/valid/error/source_kind`), `WorkflowMeta` (`:2805`, has `description?/phases?/arguments?`), `WorkflowRun` (`:2867-2889`, has `status` ∈ running|completed|failed|cancelled|interrupted|paused, `current_phase?`, `logs`, `agents`, `result?`, `error?`, `resume_of?`, `pending_question?: { question, options?, asked_at }`, `definition?`), `WorkflowAgentRun` (`:2838-2865`), `WorkflowStartPayload` (`:2891-2899`, has `args?`, `permissionSessionID?`, `resume_of?`, `invalidate_agents?`), `WorkflowAnswerPayload` (`:2908-2914`, `{ answer, permissionSessionID? }`).
- The web app's `sdk` context returns the dir-scoped client (`packages/app/src/context/sdk.tsx`, `server-sdk.tsx:287-312`) — `sdk.client.workflow.*` is available wherever `useSDK()` is used. `sdk.directory` is the dir to forward as the `directory` param.

### config flags (`sync.data.config.workflows`)
- The app `Config` type carries `workflows?: { ultracode_keyword?: boolean; approval?: "always"|"first-run"|"never"; approved?: string[] }` (`packages/sdk/js/src/v2/gen/types.gen.ts:2092-2096`).
- `sync.data.config` is the live config in the app (used at `packages/app/src/pages/session/use-session-commands.tsx:356`, `local.tsx:147`). So `sync.data.config.workflows?.ultracode_keyword ?? true` and `...?.approved ?? []` are readable.

### i18n
- `language.t(key, params?)` is typed against `keyof Dictionary`, where `Dictionary` = flatten of `@/i18n/en` + `@opencode-ui/ui/i18n/en` (`packages/app/src/context/language.tsx:29-30,218-221`). **New keys MUST be added to `packages/app/src/i18n/en.ts`** or `t()` will not typecheck.
- Non-English locales are `satisfies Partial<Record<Keys, string>>` (verified in `de.ts` tail and `ar.ts`), so they need NOT contain every key. The parity test only checks two specific session keys (`packages/app/src/i18n/parity.test.ts:22`). **Add new strings to `en.ts` (required) and `de.ts` (user's locale, optional but expected); no parity break.**

### Test harness
- App tests: `bun test --preload ./happydom.ts ./src` (happy-dom preloaded → DOM + `KeyboardEvent` exist). Tests are COLOCATED next to source (no `packages/app/test` dir).
- Pure-helper test pattern: `packages/app/src/components/titlebar-history.test.ts`, `packages/app/src/context/command.test.ts`, `command-keybind.test.ts` — `import { describe, expect, test } from "bun:test"`, import the pure fn, assert real values.
- There is no Solid component-render test harness in `packages/app` (no `@solidjs/testing-library` usage found). **Solid component wiring is harness-limited: extract pure logic into helper modules and unit-test those; the `.tsx` rendering/wiring is verified by typecheck + manual run, not by unit test.**

---

## Tasks (TDD, bite-sized, ordered)

Each task: write the failing test FIRST with real assertions, then the implementation. Run `cd packages/app && bun test <file>` after each.

### Task 1 — Port ultracode pure helpers
**New file:** `packages/app/src/components/prompt-input/ultracode.ts`
Copy verbatim from `packages/tui/src/component/prompt/ultracode.ts`: `KEYWORD`/`BOUNDARY`/`KEYWORD_RE`, `ULTRACODE_PROMPT_DIRECTIVE`, `ULTRACODE_SESSION_DIRECTIVE`, `detectUltracodeKeyword`, `stripUltracodeKeyword`. No TUI imports (none exist in that file — it is pure). Keep the comments.

**Test FIRST:** `packages/app/src/components/prompt-input/ultracode.test.ts`
```ts
import { describe, expect, test } from "bun:test"
import { detectUltracodeKeyword, stripUltracodeKeyword,
  ULTRACODE_PROMPT_DIRECTIVE, ULTRACODE_SESSION_DIRECTIVE } from "./ultracode"

describe("ultracode keyword", () => {
  test("detects standalone keyword and reports span", () => {
    expect(detectUltracodeKeyword("please ultracode this")).toEqual({ index: 7, length: 9 })
    expect(detectUltracodeKeyword("ULTRACODE: audit")).toEqual({ index: 0, length: 9 })
  })
  test("ignores keyword glued to word chars", () => {
    expect(detectUltracodeKeyword("ultracodex")).toBeUndefined()
    expect(detectUltracodeKeyword("ultracode2")).toBeUndefined()
    expect(detectUltracodeKeyword("ultracode_mode")).toBeUndefined()
    expect(detectUltracodeKeyword("öultracode")).toBeUndefined()
  })
  test("strips keyword and collapses leftover whitespace/colon", () => {
    expect(stripUltracodeKeyword("ultracode: audit the repo")).toBe("audit the repo")
    expect(stripUltracodeKeyword("please ultracode this now")).toBe("please this now")
  })
  test("directives are distinct non-empty constants", () => {
    expect(ULTRACODE_PROMPT_DIRECTIVE).not.toBe(ULTRACODE_SESSION_DIRECTIVE)
    expect(ULTRACODE_PROMPT_DIRECTIVE.length).toBeGreaterThan(0)
  })
})
```
(Anchored to the TUI's own `ultracode` semantics; assertions are the documented behavior in the source comments.)

### Task 2 — Port `/workflow` command parser + arg parser + discovered-name filter
**New file:** `packages/app/src/components/prompt-input/workflow-command.ts`
Copy/port these PURE helpers (no TUI runtime, no `TextareaRenderable`):
- `parseWorkflowCommand(input): { type:"dashboard" } | { type:"start"; name; args } | undefined` (from `dialog-workflow-helpers.ts:193-203`).
- `parseWorkflowArgs(input, declaration)` + its private `tokenizeWorkflowArgs` (from `workflow-autocomplete.ts`).
- `workflowCommandOptions(workflows: WorkflowInfo[], existingCommandNames: Set<string>)` returning `{ name, description }[]` — the shadow/validity filter (drop `valid === false`, drop names already in `existingCommandNames`). DROP the `TextareaRenderable`-bound `onSelect`/insert helpers — the web app inserts text differently (see Task 4).
- `sanitizeWorkflowFilename(name)` (from `dialog-workflow-helpers.ts:173-179`) — reused by Task 7.
Types from `@opencode-ai/sdk/v2` (`WorkflowInfo`).

**Test FIRST:** `packages/app/src/components/prompt-input/workflow-command.test.ts`
```ts
import { describe, expect, test } from "bun:test"
import { parseWorkflowCommand, parseWorkflowArgs, workflowCommandOptions,
  sanitizeWorkflowFilename } from "./workflow-command"
import type { WorkflowInfo } from "@opencode-ai/sdk/v2"

const wf = (name: string, valid = true): WorkflowInfo =>
  ({ name, path: `/${name}.ts`, valid, meta: { name, description: `${name} desc` } })

describe("parseWorkflowCommand", () => {
  test("/workflows opens dashboard", () => expect(parseWorkflowCommand("/workflows")).toEqual({ type: "dashboard" }))
  test("/workflow with no name opens dashboard", () =>
    expect(parseWorkflowCommand("/workflow")).toEqual({ type: "dashboard" }))
  test("/workflow <name> starts and keeps raw args", () =>
    expect(parseWorkflowCommand('/workflow review msg="a  b"')).toEqual({ type: "start", name: "review", args: 'msg="a  b"' }))
  test("non-workflow input returns undefined", () => expect(parseWorkflowCommand("/share")).toBeUndefined())
})

describe("parseWorkflowArgs", () => {
  test("coerces declared-number, keeps undeclared strings", () => {
    expect(parseWorkflowArgs("count=3 version=1.0", { count: { type: "number" } }))
      .toEqual({ count: 3, version: "1.0" })
  })
  test("keeps quoted value with spaces intact", () =>
    expect(parseWorkflowArgs('msg="a b"', {})).toEqual({ msg: "a b" }))
})

describe("workflowCommandOptions", () => {
  test("drops invalid workflows and command-name collisions", () => {
    const out = workflowCommandOptions([wf("review"), wf("broken", false), wf("share")], new Set(["share"]))
    expect(out.map((o) => o.name)).toEqual(["review"])
  })
})

describe("sanitizeWorkflowFilename", () => {
  test("rejects traversal/separators, accepts a clean segment", () => {
    expect(sanitizeWorkflowFilename(" review ")).toBe("review")
    expect(sanitizeWorkflowFilename("a/b")).toBeUndefined()
    expect(sanitizeWorkflowFilename("..")).toBeUndefined()
  })
})
```
(Assertions taken from the documented behavior in `dialog-workflow-helpers.ts` and `workflow-autocomplete.ts`.)

### Task 3 — Register `/ultracode` toggle + `/workflow`/`/workflows` commands in the prompt input
**Edit:** `packages/app/src/components/prompt-input.tsx` (the `command.register("prompt-input", ...)` block at `:512-537`) and the local `store` (`:276-289`).
- Add `ultracodeSession: boolean` to the prompt-input `store` (default `false`).
- Add a command:
  - `{ id: "ultracode.toggle", title: t(store.ultracodeSession ? "command.ultracode.disable" : "command.ultracode.enable"), category: t("command.category.session"), slash: "ultracode", onSelect: () => setStore("ultracodeSession", v => !v) }`. Mirror the TUI toast on toggle (`index.tsx:1489-1518`) using the app's `showToast`.
  - `{ id: "workflow.start", title: t("command.workflow.start"), category: t("command.category.workflow"), slash: "workflow", onSelect: () => insert "/workflow " into the editor }` (reuse the `setEditorText`/`prompt.set`/`focusEditorEnd` pattern from `handleSlashSelect`'s custom branch, `prompt-input.tsx:706-711`).
  - `{ id: "workflow.list", title: t("command.workflow.dashboard"), category: t("command.category.workflow"), slash: "workflows", onSelect: openWorkflowDashboard }` (Task 6 provides `openWorkflowDashboard` = lazy import + `dialog.show`).
- Expose `ultracodeSession` to the submit path: pass `ultracodeSession: () => store.ultracodeSession` into `createPromptSubmit(...)` input (`prompt-input.tsx:1147-1168`) and reset it on session change (mirror TUI `index.tsx:344-352`: reset when `params.id` changes).

**Test:** harness-limited (Solid wiring). Add a small pure helper if extraction is natural; otherwise rely on Task 1/2 unit tests + typecheck + manual run. Note this explicitly in the task as "wiring verified by typecheck + run".

### Task 4 — Discovered `/<name>` workflow dispatch in the slash popover
**Edit:** `packages/app/src/components/prompt-input.tsx` `slashCommands` memo (`:677-699`) and `handleSlashSelect` (`:701-717`).
- Add a `createResource`/memo holding `workflow.list()` results (lazy: only fetch when slash popover opens, or piggyback on an existing fetch). Keep it cheap — list once and refetch on demand; the TUI uses `listWorkflowInfos`.
- Build extra slash entries from `workflowCommandOptions(workflows, existingNames)` (Task 2), where `existingNames` = the set of `builtin` slash triggers ∪ `sync.data.command` names. Mark them with a synthetic id like `workflow.run.<name>` and a new `type` discriminator (extend `SlashCommand` with an optional `workflow?: true` flag, or reuse `type: "custom"` + a `source: "workflow"` — note `slash-popover.tsx:119` already renders a "workflow" badge path is absent, so add a `prompt.slash.badge.workflow` string and a branch).
- In `handleSlashSelect`: when the entry is a workflow-name entry, insert `"/workflow <name> "` text (so submit routes through the `/workflow` path), matching the TUI's `/<name>` → `/workflow <name>` routing. (Do NOT `command.trigger`; there is no per-name command registered.)

**Test:** the filter logic is already covered by Task 2's `workflowCommandOptions` test. The popover wiring is harness-limited; verify by typecheck + run.

### Task 5 — Ultracode injection + `/workflow` routing on SUBMIT
**Edit:** `packages/app/src/components/prompt-input/submit.ts` — `createPromptSubmit` (`:205`) and its input type `PromptSubmitInput` (`:174-194`).
- Add `ultracodeSession: Accessor<boolean>` to `PromptSubmitInput`.
- In `handleSubmit` (`:292`), AFTER computing `text`/`mode` and BEFORE the `/command` branch (`:458`):
  1. Compute `keywordEnabled = sync.data.config.workflows?.ultracode_keyword ?? true` and `mode === "normal"` and `!text.trimStart().startsWith("/")` (mirror TUI guard `index.tsx:330-339`).
  2. `parseWorkflowCommand(text)` (Task 2). If it returns:
     - `{ type: "dashboard" }` → open the dashboard panel (Task 6) and clear input; return.
     - `{ type: "start", name, args }` → resolve `workflow.list()`, find the info, `parseWorkflowArgs(args, info?.meta.arguments ?? {})`, then `client.workflow.start({ name, directory: sessionDirectory, workflowStartPayload: { args, permissionSessionID: session.id } })`. On success toast + (if `result.data.session_id`) navigate to that session (mirror TUI `index.tsx:1202-1222`). Clear input; return. **Approval gate is OUT OF SCOPE for v1** (the TUI's `DialogWorkflowApproval` is a large sub-feature; note as an open item). Document that v1 starts directly, matching `approval:"never"`.
  3. Otherwise (normal prompt), build `ultracodeParts`:
     - session directive when `input.ultracodeSession()` is true → prepend `{ type:"text", content: ULTRACODE_SESSION_DIRECTIVE }`.
     - keyword directive when `keywordEnabled` and `detectUltracodeKeyword(text)` → prepend `ULTRACODE_PROMPT_DIRECTIVE` and STRIP the keyword from the user text via `stripUltracodeKeyword` before building parts.
     - These prepend into the prompt `parts` handed to `sendFollowupDraft` / `buildRequestParts`. (Mirror TUI `index.tsx:1167-1169,1296-1304` where `ultracodeParts` precede the user text part.)
- Keep the existing `/command` (`session.command`) branch for genuine custom commands UNCHANGED — `/workflow*` is intercepted before it, and discovered `/<name>` were rewritten to `/workflow <name>` in Task 4 so they no longer hit the `session.command` branch.

**Test FIRST (pure extraction):** extract the directive-assembly into a pure helper `buildUltracodeParts({ text, session, keywordEnabled })` in `ultracode.ts` (or a sibling) and unit-test it. Example new test in `ultracode.test.ts`:
```ts
import { buildUltracodeParts } from "./ultracode"
test("prepends session + keyword directives and strips keyword", () => {
  const out = buildUltracodeParts({ text: "ultracode fix bug", session: true, keywordEnabled: true })
  expect(out.directives).toContain(ULTRACODE_SESSION_DIRECTIVE)
  expect(out.directives).toContain(ULTRACODE_PROMPT_DIRECTIVE)
  expect(out.text).toBe("fix bug")
})
test("no directives when off and no keyword", () => {
  expect(buildUltracodeParts({ text: "fix bug", session: false, keywordEnabled: true }))
    .toEqual({ directives: [], text: "fix bug" })
})
```
The `submit.ts` wiring (calling the helper, prepending parts, the `workflow.start` branch) is harness-limited; verified by typecheck + run.

### Task 6 — Workflow dashboard panel (run list + detail)
**New files:**
- `packages/app/src/components/dialog-workflow-helpers.ts` — port the PURE derivations from `packages/tui/src/component/dialog-workflow-helpers.ts`: `timestamp`, `statusIcon`, `phaseStatus`, `phaseIcon`, `formatShortElapsed`, `formatPhase`, `spentThisMonth`, `reanchorSelection`, `capLogs`, `questionBadge`. (Skip `mergeRunEvent` for v1 — we refetch on event; skip `saveTargets`/`parseWorkflowCommand`/`sanitizeWorkflowFilename` which live in Task 2's `workflow-command.ts` instead, OR keep them all together — pick one home and import consistently.) Types from `@opencode-ai/sdk/v2`.
- `packages/app/src/components/dialog-workflow.tsx` — the Solid panel. Use `<Dialog>` + lists from `@opencode-ai/ui` (pattern: `dialog-select-mcp.tsx`). Structure (mirror `packages/tui/src/component/dialog-workflow.tsx`):
  - `workflowsResource = createResource(() => sdk.client.workflow.list({ directory: sdk.directory }))` — fetched once.
  - `runsResource = createResource(() => sdk.client.workflow.runs({ directory: sdk.directory }))` with `refetch`.
  - LIVE: `sdk.event.on("workflow.run.updated", () => refetch())` + `sdk.event.on("workflow.run.finished", () => refetch())` with `onCleanup` (seam: `server-sdk.tsx:293-304`, pattern `session.tsx:719-729`). PLUS a 1s `setInterval(() => refetch(), 1000)` poll fallback, cleared on cleanup (mirror `dialog-workflow.tsx:425-437`).
  - Run list rows: per-run status glyph (`statusIcon`), `formatPhase`, `formatShortElapsed`, `questionBadge` (mirror `dialog-workflow.tsx:642-720`). `reanchorSelection` keeps the selected row stable across refetches.
  - Detail view (selected run): phases via `phaseStatus`/`phaseIcon`, agents (id/agent/model/status/cost/tokens from `WorkflowAgentRun`), result, usage total = sum of `agent.cost`, capped logs via `capLogs`. (Mirror the detail component `dialog-workflow.tsx:832+`.)
  - Pause/resume controls (Task 7).
- `openWorkflowDashboard` helper (in `prompt-input.tsx` or a shared `workflow-dashboard.ts`): `dialog.show(() => <DialogWorkflow .../>)` with a lazy `import("@/components/dialog-workflow")` (pattern: `use-session-commands.tsx:261-265`).

**Test FIRST:** `packages/app/src/components/dialog-workflow-helpers.test.ts` — unit-test the ported derivations with constructed `WorkflowRun` fixtures. Assertions mirror the documented behavior, e.g.:
```ts
import { phaseStatus, formatPhase, statusIcon, capLogs, reanchorSelection, questionBadge } from "./dialog-workflow-helpers"
// running run on phase[1] of [a,b,c]: a=completed, b=running, c=pending
// terminal run with current_phase past declared phases → later phases "skipped"
// questionBadge: pending_question + running → "⏳"; terminal → ""
// capLogs([1..120], 100) → { entries.length 100, hidden 20 }
// reanchorSelection("x", rows) clamps to last row when id missing
```
The `.tsx` panel rendering/event-subscription is harness-limited (no Solid render harness) → verified by typecheck + manual run. Cross-reference the TUI's own helper tests for the exact expected values: `packages/tui/test/cli/cmd/tui/dialog-workflow-helpers.test.ts`, `dialog-workflow-phase.test.ts`, and `workflow-autocomplete.test.ts` — copy assertions from these.

### Task 7 — Pause / resume + save-run-as-command
**Edit:** `packages/app/src/components/dialog-workflow.tsx`.
- Pause: `sdk.client.workflow.pause({ id: run.id, directory })` then refetch (mirror `dialog-workflow.tsx:478`). Cancel: `sdk.client.workflow.cancel({ id, directory })`.
- Resume a paused/interrupted run: `sdk.client.workflow.start({ name: run.workflow, directory, workflowStartPayload: { resume_of: run.id } })` then refetch (mirror `dialog-workflow.tsx:501`, `:998`).
- **Save-run-as-command — SCOPE RISK / BLOCKED (see Risks).** The TUI writes the run's `definition.source` to disk via `Bun.write`/`fs.mkdir` (`dialog-workflow.tsx:702-748`). The web app runs in a browser/Electron renderer and the SDK `File` class is READ-ONLY (`list`/`read`/`status`; no write endpoint — verified `sdk.gen.ts:1814+`), and `platform` only exposes `saveFilePickerDialog` returning a path (`platform.tsx:59`), not a writer. **v1 options (pick one, note in plan):**
  1. **Defer it** — port `sanitizeWorkflowFilename` + a disabled "Save as command (desktop CLI only)" affordance, and file a follow-up for a server `workflow.save`/`file.write` endpoint. (Recommended — keeps T7 to genuine UI parity that the current SDK supports.)
  2. Use `platform.saveFilePickerDialog` to let the user pick a path and write via an Electron-only bridge IF one exists — but no general write bridge was found, so this is NOT viable without new platform/IPC plumbing. Out of scope.
- The pure `sanitizeWorkflowFilename` is still ported and unit-tested (Task 2) so the follow-up has its validation ready.

**Test:** pause/resume are direct SDK calls inside the component (harness-limited) → typecheck + run. `sanitizeWorkflowFilename` covered in Task 2.

### Task 8 — Question dialog
**New files:**
- `packages/app/src/components/dialog-workflow-question.tsx` — surfaces a run's `pending_question` (`{ question, options?, asked_at }`). Renders the question text, optional choice list (`<List>` of `options`), and a free-text answer when no options. Mirror `packages/tui/src/component/dialog-workflow-question.tsx` for the rendered fields and `packages/tui/src/component/dialog-workflow-question-helpers.ts` for any pure derivations (port + unit-test those).
- Port `answerWorkflowRun` from `packages/tui/src/component/dialog-workflow-client.ts:45-85` into a web-side helper (e.g. `packages/app/src/components/dialog-workflow-client.ts`): `answer({ id, answer, permissionSessionID? })` → `sdk.client.workflow.answer({ id, directory, workflowAnswerPayload })`, mapping 200→`{type:"ok",run}`, 404→`not_found`, 409→`no_question`, else→`error`. Also port `asWorkflowRunEvent` (`:37-43`) for the dashboard's event narrowing (Task 6 may reuse it; it's pure-ish — narrows the `Event` union).
- After a successful answer, FOLLOW the resumed run: `workflow.get({ id: result.run.id })` to seed detail, refetch the list (mirror `dialog-workflow.tsx:515-542`). The answer `id` is the run that was resumed (the TUI's `DialogWorkflowQuestion` returns the resumed run id).

**Test FIRST:** `packages/app/src/components/dialog-workflow-client.test.ts` — unit-test `answerWorkflowRun`'s status mapping and `asWorkflowRunEvent`'s narrowing with a fake `client.workflow.answer` returning `{ data, response: { status } }`:
```ts
import { answerWorkflowRun, asWorkflowRunEvent } from "./dialog-workflow-client"
const fake = (data: any, status: number) => ({
  client: { workflow: { answer: async () => ({ data, response: { status } }) } }, directory: "/x",
}) as any
test("maps 404 → not_found", async () =>
  expect(await answerWorkflowRun(fake(undefined, 404), { id: "r", answer: "y" })).toEqual({ type: "not_found" }))
test("maps 409 → no_question", async () =>
  expect((await answerWorkflowRun(fake(undefined, 409), { id: "r", answer: "y" })).type).toBe("no_question"))
test("maps 200 → ok with run", async () => {
  const run = { id: "r", workflow: "w", status: "running", logs: [], agents: [], started_at: 0 }
  expect(await answerWorkflowRun(fake(run, 200), { id: "r", answer: "y" })).toEqual({ type: "ok", run })
})
test("asWorkflowRunEvent narrows workflow.run.finished", () => {
  const ev = { type: "workflow.run.finished", id: "e", properties: { id: "r" } } as any
  expect(asWorkflowRunEvent(ev)?.kind).toBe("finished")
  expect(asWorkflowRunEvent({ type: "session.status" } as any)).toBeUndefined()
})
```
(Assertions mirror `dialog-workflow-client.ts`'s documented 200/404/409/else mapping; copy from the TUI test `packages/tui/test/cli/cmd/tui/dialog-workflow-client.test.ts` and `dialog-workflow-question-helpers.test.ts`.)

### Task 9 — i18n strings
**Edit:** `packages/app/src/i18n/en.ts` (REQUIRED — source of `keyof Dictionary`) and `packages/app/src/i18n/de.ts` (user locale).
Add at least:
- `"command.category.workflow": "Workflow"`
- `"command.ultracode.enable": "Ultracode: turn on"`, `"command.ultracode.disable": "Ultracode: turn off"`
- toast strings for ultracode on/off (mirror TUI "Ultracode ON"/"Ultracode OFF").
- `"command.workflow.start": "Start a workflow"`, `"command.workflow.dashboard": "Open workflows"`
- `"prompt.slash.badge.workflow": "workflow"` (the new badge branch in `slash-popover.tsx`)
- dashboard strings: title, description, empty ("No workflow runs yet. Start one with /workflow <name>."), column/section labels (Phases, Agents, Result, Usage, Logs, "… {{count}} earlier entries"), status labels (running/completed/failed/cancelled/interrupted/paused), action labels (Pause, Resume, Cancel, Save as command, Answer), question dialog title/placeholder, and the toasts for start/started/failed/pause/resume/answer/save-blocked.
Use `{{name}}`/`{{count}}` params (the app uses `resolveTemplate`, see `dialog-select-mcp.tsx:35`).

**Test:** the existing `parity.test.ts` stays green (only checks 2 specific keys; new keys are additive). No new i18n test required, but ensure `de.ts` entries are added so the German desktop is fully localized. Optionally add a tiny test asserting the new `en` keys exist if desired (not required).

### Task 10 — Track gate
Run and make green:
- `cd packages/app && bun run typecheck` (`tsgo -b`)
- `cd packages/app && bun test` (the colocated unit suite via happy-dom preload)
- repo root: `bun turbo typecheck`
Fix any cross-package type drift surfaced (the SDK types are already regenerated on this branch, so workflow types resolve).

---

## Risks / scope notes

- **Biggest piece: the dashboard panel (Task 6).** The TUI `dialog-workflow.tsx` is ~1500 lines; the web port is a fresh Solid component but reuses the ported pure helpers. Keep v1 lean: list + detail + pause/resume + question. Defer multi-select, log streaming niceties, and the approval gate.
- **Save-run-as-command (Task 7) is effectively BLOCKED on the web side.** No SDK file-write endpoint, no general platform write bridge (only `saveFilePickerDialog` returning a path). Recommend deferring with a disabled affordance + a follow-up for a server endpoint. This is the one piece that cannot reach true TUI parity without new server/IPC work.
- **Workflow approval gate** (`DialogWorkflowApproval`, the `/workflow <name>` consent flow, `config.workflows.approval`/`approved`) is OUT OF SCOPE for v1 — v1 starts directly (== `approval:"never"`). Note as a follow-up; the config flags are readable (`sync.data.config.workflows`) when it's added.
- **Solid component tests are harness-limited:** `packages/app` has no Solid render-test harness. The plan pushes all testable logic into pure helper modules (Tasks 1, 2, 6-helpers, 8-client) and verifies `.tsx` wiring via typecheck + manual run. This is consistent with the existing app test layout (helpers tested, components not).
- **Per-name `/<name>` dispatch nuance:** workflow names that collide with a real server command are filtered out of the discovered list (`workflowCommandOptions`), so a workflow never shadows a real command — and on submit, `/workflow <name>` is intercepted before the generic `session.command` branch. Genuine custom commands keep their existing `session.command` behavior.

## Open questions

1. Save-run-as-command: add a server `workflow.save` (or generic `file.write`) endpoint to the SDK so the web app can reach parity, or ship the desktop-only affordance disabled? (Recommend a follow-up server endpoint; out of T7's UI-port scope.)
2. Should the discovered `/<name>` workflow entries carry the existing "custom" badge or a new "workflow" badge? Plan adds a `prompt.slash.badge.workflow` string; confirm desired wording.
3. Dashboard live-update: refetch-on-event (chosen, simplest, matches TUI) vs. `mergeRunEvent` overlay (lower churn). Plan chooses refetch for v1; revisit if the run list flickers.
4. Should the dashboard be a modal `dialog.show` (matches every other app panel) or a dockable side panel? Plan uses `dialog.show` for v1 parity with the TUI's modal dashboard.

---

## Summary

10 tasks. Pure helpers ported + unit-tested (ultracode, workflow-command parsing, dashboard derivations, answer/event client); Solid `.tsx` panels (dashboard, question dialog) wired and verified by typecheck + run. Ultracode session toggle + keyword injection and `/workflow`/`/workflows`/`/<name>` routing land in the existing prompt-input command registration and submit path. i18n keys added to `en.ts` (required) + `de.ts`. Save-run-as-command is deferred (no web write path). SDK workflow surface and types are confirmed present on this branch.
