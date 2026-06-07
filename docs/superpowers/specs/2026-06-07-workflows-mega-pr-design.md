# Design: Workflows Mega-PR — alle Review-Findings in einem Rolling-PR

**Datum:** 2026-06-07 · **Branch-Basis:** `feat/workflows-fixes` (Head bei Start verifizieren, ggf. dev-Sync) · **Ziel:** PR #3 an `VasyaYovbak:feat/workflows` (Rolling-Muster, fließt in anomalyco/opencode#29789)

## 1. Kontext & Ziel

Das 59-Agenten-Review (2026-06-07, `.claude/reviews/workflows-roadmap-2026-06-07.md` + `workflows-critic-2026-06-07.md`) hat verifizierte Findings in fünf Kategorien geliefert: 2 Verhaltens-Bugs, 7 Quick Wins, 5 mittlere Claude-Paritätslücken, ~9 ungenutzte OpenCode-Integrationschancen und Critic-Funde (Doku-Drift, Headless, Observability, Test-Lücken). Dazu kommen 29 offene Findings aus dem Doku-Audit vom 2026-06-06 (wxoddpqh0).

**Dieser Plan setzt ALLE um** — inklusive der XL-Bausteine `ctx.question` (Human-in-the-loop) und ACP-Streaming — in **einem** Mega-PR nach dem etablierten Rolling-Muster.

### Annahmen
1. **Breaking Changes am `ctx`-Kontrakt sind zulässig** — der Feature-Branch ist nirgends released; `parallel()`/`pipeline()` ändern ihren Rückgabetyp auf `(T|null)[]`.
2. **Die 29 Doku-Audit-Findings sind freigegeben** (User-Scope „ALLE Findings").
3. `experimental.policies`-Enforcement ist **out of scope** (gehört in die geteilte Provider-Resolution, nicht in Workflow-Code; wird separat upstream eskaliert).

## 2. Architektur: Ansatz C — „Hotspot sequenziell, Rest parallel"

Erkenntnis: `workflow/workflow.ts` + `plugin/src/workflow.ts` sind der Konflikt-Hotspot (~10 Findings); TUI/Tool/Docs/ACP sind disjunkt partitionierbar.

```
Phase 1 (sequenziell)          Phase 2 (parallel, 5 Worktrees)        Phase 3 (sequenziell)
mega/engine-core      ───────▶  T-Tool · T-TUI · T-ACP          ───▶  Integration: Merges in
ALLE workflow.ts-     API-      T-Tests/Ops · T-Docs                  fester Reihenfolge,
Änderungen, TDD       Kontrakt                                        SDK-Regen, Verifikation,
                      stabil                                          Adversarial-Review, PR #3
```

- **Phase 1** (kritischer Pfad, ein Track): alle Engine-Änderungen als kohärente Serie kleiner TDD-Commits in Branch `mega/engine-core` (eigener Worktree).
- **Phase 2** (5 parallele Worktree-Tracks ab Post-Phase-1-Commit): disjunkte Dateiflächen; die einzige Cross-Abhängigkeit (T-TUI braucht die question-HTTP-Route aus T-Tool) ist durch den in §4.6/§5.1 **fixierten HTTP-Kontrakt** entkoppelt — T-TUI codet gegen den Kontrakt, Integration wird in Phase 3 verifiziert.
- **Phase 3**: Merge-Reihenfolge engine-core → T-Tool → T-TUI → T-ACP → T-Tests → T-Docs (Docs zuletzt, dokumentiert den finalen Stand); SDK-Regen einmal zentral; Voll-Verifikation; adversariales Schluss-Review per Workflow; PR #3 + Showcase-Update auf #29789.

**Orchestrierung:** Hauptsession führt; pro Track ein Agenten-Team im isolierten Worktree; TDD-Pflicht; je Track Spec-Review + Quality-Review (Muster 3a–3o); Ultracode-Workflows für die adversarialen Pässe.

## 3. Track-Zuschnitt (Findings → Flächen)

| Track | Findings | Haupt-Dateien |
|---|---|---|
| **engine-core** (P1) | P1, P2, QW1-Events, AgentInput: tools/variant/skills/isolation/files, model:"small", ctx.shell, ctx.workflow-Nesting, ctx.question (Engine), OTel-Spans, Phasen-Schema, ctx.budget-Wrapper | `workflow/workflow.ts`, `plugin/src/workflow.ts`, `core/workflow/sql.ts` (+1 Migration), Engine-Tests |
| **T-Tool** | QW3 resume_of/invalidate_agents, P3 Inline-Source, QW4 whenToUse, QW7 Live-Agent-Roster, question-HTTP | `tool/workflow.ts`, `httpapi/groups+handlers/workflow.ts`, `meta-reader.ts`, `meta.ts` |
| **T-TUI** | QW2 Attention/Toast, Event-Subscription statt Polling, Commands-Unifikation, question-Dialog, headless `opencode run` | `packages/tui/**`, `cli/cmd/run/**`, `command/index.ts` |
| **T-ACP** | Workflows in availableCommands, Subagent-Streaming, question→ACP-Permission-Spiegelung | `acp/**` |
| **T-Tests/Ops** | Test-Lücken: resume-replay, orphan-sweep, HTTP-Lifecycle-e2e, Budget-Race-Audit(+Fix falls bestätigt); gitlab-Prüfung; /init-Workflows-Sektion | `test/**`, `cli/cmd/init*` |
| **T-Docs** | workflows.mdx-Drift + 29 Audit-Findings, QW5 scout, QW6 Quality-Patterns, neue Features dokumentieren, troubleshooting.mdx, bewusste Nicht-Paritäten | `workflows.mdx`, `workflows-instructions.md`, `troubleshooting.mdx`, Tool-Description |

## 4. Phase 1 „engine-core" — API-Kontrakte

### 4.1 Fehlersemantik (P1/P2)
- `ctx.parallel<T>(tasks) → Promise<(T|null)[]>`: jeder Task einzeln getrapt; Reject → `null` an dessen Position; Drop via `ctx.log` protokolliert.
- `ctx.pipeline(...)`: werfende Stage setzt nur DIESES Item auf `null` und überspringt dessen Reststufen; Rückgabe `(Last|null)[]`; Drop geloggt.
- Typen in `plugin/src/workflow.ts` angepasst; `deep-research`-Builtin filtert Nulls statt zu crashen.
- Falsifikations-Beweis: neue Tests müssen auf altem Code rot sein.

### 4.2 Bus-Events (QW1)
- Emission zentral in `persistRun` (ein Choke-Point) über die vorhandene EventV2Bridge.
- `workflow.run.updated`: schlanke Run-Summary `{id, workflow, status, current_phase, agents: {total, running, failed}, directory, pending_question?: boolean}`.
- `workflow.run.finished`: terminale Zustände, gleiche Summary + `error?`.
- Konsumenten holen Details per `workflow.get` (Payload bewusst schlank).

### 4.3 AgentInput-Erweiterungen (alle optional, additiv)
- `tools?: Record<string, boolean>` — glob-fähig (Form identisch zur Agent-Config), scoped Tools/MCP/Skills pro Step; an Session-Create/Prompt durchgereicht.
- `variant?: string` — an `prompt.prompt({variant})`; **inklusive Fix** des `Provider.parseModel`-Mis-Parse für `provider/model/variant`-Strings.
- `model: "small"` — Schlüsselwort löst `small_model`-Config auf.
- `skills?: string[]` — benannte Skills für den Subagenten verfügbar; exaktes Wiring (Tools-Whitelist vs. Prompt-Injection) entscheidet der Implementierungsplan nach Lektüre des Skill-Plumbings; Kontrakt: deklarierte Skills sind für den Step nutzbar.
- `isolation?: "worktree"` — `git worktree add` unter Temp-Pfad, cwd der Child-Session; Cleanup-Finalizer am `runScope` (`git worktree remove --force`); außerhalb von Git-Repos → `WorkflowInvalidError`.
- `files?: string[]` — deklarative Datei-Anhänge als File-Parts (explizites Feld statt `@`-Magie; deterministisch).

### 4.4 Neue ctx-Primitive
- `ctx.shell(command, opts?: {timeout?, cwd?}) → Promise<{output: string, exitCode: number}>` — via `SessionPrompt.shell` in der Run-Container-Session; erbt Session-Shell-Permissions; non-zero Exit ist KEIN Throw; abbrechbar über Run-Scope; zählt nicht aufs Budget.
- `ctx.workflow(name, args?) → Promise<unknown>` — Nesting Tiefe 1, **inline** unter demselben Run (kein zweiter Run-Row); teilt Semaphore, Budget, Abort-Scope, Agent-Lifetime-Cap; Logs/Phasen präfixiert (`<child>:`); nutzt `loadModule` + `coerceArgs`; Tiefe>1 → `WorkflowInvalidError`.
- `ctx.budget = {total: number|null, spent(): number, remaining(): number}` (USD) zusätzlich zu `budgetRemaining` (bleibt).

### 4.5 Strukturierte Phasen
- `meta.phases: (string | {title, detail?, model?})[]` (back-compat; MetaReader erweitert).
- Phase-Default-`model` greift, wenn `ctx.agent` keins setzt.
- `setPhase()` auf nicht deklarierte Phase → Warn-Log (kein Fehler).

### 4.6 ctx.question — Human-in-the-loop auf der Pause/Resume-Maschinerie
- `ctx.question({question, options?: string[], timeout?: ms}) → Promise<{answer: string}>`.
- Ablauf: Frage wird am Run persistiert (`pending_question`-Spalte, **eine** neue Migration) + Event emittiert → Engine wartet **live** auf `POST /workflow/run/:id/answer`.
- Timeout (Default 10 Min) ohne Antwort → Run parkt als `paused` (Journal inkl. Frage-Step erhalten). Kein neuer Status.
- **Frage = journalbarer Step** (Journal-Node-Kinds: `agent | question`; Kind steckt im JSON, keine zweite Migration): Antwort auf einen geparkten Run triggert automatisch `resume_of`; Replay liefert vorherige Agenten cached UND die Antwort an den `question`-Aufruf; Body läuft exakt weiter.
- Live-wartende Runs haben eine Fiber → Sweep-Invariante unberührt.

### 4.7 OTel-Spans
`Effect.withSpan("workflow.run" | "workflow.phase" | "workflow.agent")` mit Attributen (run-id, workflow, phase, agent, model, cost, tokens) um Run-Körper, Phasenwechsel und jeden Agent-Dispatch.

## 5. Phase 2 — Track-Details

### 5.1 T-Tool
- `resume_of` (RunID, `decodeRunId`-Guard existiert) + `invalidate_agents` (number[]) als Tool-Parameter, durchgereicht an `workflow.start`.
- Inline-Source-Start: `action:"start"` + `source` (alternativ zu `name`) → `temporary` Run; **vor** dem Permission-Ask via `MetaReader.read` statisch validiert (gleiche Garantien wie Datei-Workflows).
- `whenToUse?: string` in Meta-Schema/Reader/Plugin-Helper; gerendert in `available_workflows` und Approval-Dialog.
- Live-Agent-Roster aus `Agent.Service` in `read`/`create`-Ausgabe (ersetzt hartkodierte Liste).
- **question-HTTP-Kontrakt (fixiert):** `POST /workflow/run/:id/answer` Body `{answer: string}` → 200 `{run}` | 404 unbekannte id | 409 wenn keine Frage offen; Run-Payload erhält `pending_question?: {question, options?, asked_at}`.

### 5.2 T-TUI
- Event-Subscription (`workflow.run.updated/finished`) über den vorhandenen sync-Konsumenten; **Polling bleibt als Fallback** (alte Server).
- Attention/Toast bei Background-Abschluss/Fehler (Handler auf finished-Event; Sound/Desktop-Notify analog Session-done).
- Commands-Unifikation: Workflows als `Command.Info` (source `"workflow"`) → `/help`, SDK-Command-List, einheitlicher Dispatch, keybind-fähig; Spezial-Autocomplete für `name=value`-Args bleibt.
- question-Dialog: Event → Dialog (Frage + Optionen + Freitext) → answer-Route; Dashboard-Badge ⏳ für wartende/geparkte Runs; Antwort auf geparkten Run löst Resume aus.
- Headless: `opencode run --workflow <name> [args]` + Ultracode-Keyword-Erkennung im run-Prompt-Pfad (gleiche Direktiven wie TUI).

### 5.3 T-ACP
- Discovery: Workflows in `availableCommands` (merge analog Commands+Skills).
- Streaming: Workflow-Subagent-Sessions im ACP-Store registrieren (Tool-Calls/Thoughts streamen ins Editor); question-Events als ACP-Permission-Request gespiegelt.
- **Rückfall-Klausel:** blockiert Streaming an ACP-Store-Interna, liefert der Track Discovery-only und dokumentiert den Rest (kein PR-Blocker).

### 5.4 T-Tests/Ops
- Neue Suiten: resume-replay-Korrektheit (inkl. question-Steps), orphan-sweep, HTTP-Lifecycle-e2e (start→question→answer→pause→resume→cancel), Budget-Race (Audit; Fix = atomare Reservierung via `SynchronizedRef.modify` vor Dispatch, bleibt Soft-Cap).
- gitlab-Handler-Prüfung (Engine-Bypass-Frage analog github); Befund dokumentieren, Fix nur wenn klein.
- `/init`: „Available workflows"-Sektion in AGENTS.md aus `Workflow.list()`.

### 5.5 T-Docs
- workflows.mdx-Drift-Audit + Fix (parallel/pipeline-Null-Semantik nach P1/P2, Budget-USD, Ultracode-Opt-in) + **alle 29 Audit-Findings** über alle 3 Doku-Flächen (mdx, Skill-MD, Tool-Description).
- QW5 scout-Agent + QW6 Quality-Patterns (judge panel, loop-until-dry, completeness critic, budget-loop) in `workflows-instructions.md`.
- Alle neuen Features aus Phase 1+2 dokumentieren.
- `troubleshooting.mdx`: Workflow-Sektion (6 Fehlerklassen: Bedeutung + Abhilfe).
- Bewusste Nicht-Paritäten: Determinismus-Modell (Shape-Matching), Budget USD vs. Token, `args`-Form.

## 6. Fehlerbehandlung

- Keine neuen Statusarten; question nutzt `paused`; Sweep-Invariante unangetastet.
- Degradation statt Bruch: Event→Polling-Fallback; worktree-Isolation ohne Git → `WorkflowInvalidError`; `ctx.shell` non-zero Exit → Rückgabewert, kein Throw.
- Error-UX: Tool-Ausgabe nennt Fehlerklasse + Abhilfe; Mid-Run-Fehler landen im Run-`error` (HTTP unverändert); TUI rendert `error` prominent; troubleshooting.mdx dokumentiert alle 6 Klassen.

## 7. Test-Strategie

- TDD pro Baustein; Falsifikations-Beweis bei Semantik-Änderungen.
- Bestands-Gates: alle existierenden Suiten grün; jede Phase endet mit Typecheck (opencode+tui), Voll-Tests, PTY-Boot-Smoke.
- Ziel: Test-LOC ≥ Feature-LOC im Delta.

## 8. Integration & PR (Phase 3)

1. dev-Sync-Check vor Merge-Beginn.
2. Merges in fester Reihenfolge (§2); Konflikte je Merge sofort auflösen + verifizieren.
3. SDK-Regen einmal zentral; `bun install`; Voll-Verifikation; PTY-Boot.
4. Adversariales Schluss-Review per Ultracode-Workflow (loop-until-dry über Gesamt-Diff, 3-Verifier).
5. PR #3 an `VasyaYovbak:feat/workflows`; PR-Body aus aktualisiertem Showcase (Stats, Matrix, Mermaid um question/shell/events erweitert); Showcase-Kommentar auf #29789 aktualisieren.

## 9. Risiken

| Risiko | Mitigation |
|---|---|
| `ctx.question` (Journal-Replay + 3 Oberflächen) | Engine-Seite früh in Phase 1; UI in Phase 2; e2e in Phase 3; baut vollständig auf erprobter Pause/Resume-Maschinerie auf |
| ACP-Streaming hängt an Store-Interna | Rückfall auf Discovery-only (§5.3) |
| Upstream bewegt sich | dev-Sync-Check vor Phase 3 |
| Hotspot-Track wird zu groß | Phase 1 als Serie kleiner, einzeln reviewbarer TDD-Commits; Zwischenreviews nach P1/P2+Events und nach AgentInput-Block |
