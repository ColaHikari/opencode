# Workflows Mega-PR — Master-Orchestrierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alle Findings des 59-Agenten-Reviews (Spec: `docs/superpowers/specs/2026-06-07-workflows-mega-pr-design.md`) in einem Rolling-PR an `VasyaYovbak:feat/workflows` landen.

**Architecture:** Ansatz C — ein sequenzieller `engine-core`-Track besitzt ALLE `workflow.ts`/`plugin/workflow.ts`-Änderungen; danach fünf parallele Worktree-Tracks auf disjunkten Flächen; Integration in fester Merge-Reihenfolge mit adversarialem Schlussreview.

**Tech Stack:** Bun, Effect, Drizzle/SQLite, SolidJS/OpenTUI (TUI), bestehende Test-Harnesse (`bun test`, `it.instance`-Effect-Pattern).

**Plan-Dateien dieses Vorhabens:**
| Track | Plan-Datei | Status |
|---|---|---|
| Phase 1: engine-core | `2026-06-07-mega-t1-engine-core.md` | ✅ liegt vor |
| Phase 2: T-Tool | `2026-06-07-mega-t2-tool.md` | wird in Task 3 generiert |
| Phase 2: T-TUI | `2026-06-07-mega-t3-tui.md` | wird in Task 3 generiert |
| Phase 2: T-ACP | `2026-06-07-mega-t4-acp.md` | wird in Task 3 generiert |
| Phase 2: T-Tests/Ops | `2026-06-07-mega-t5-tests-ops.md` | wird in Task 3 generiert |
| Phase 2: T-Docs | `2026-06-07-mega-t6-docs.md` | wird in Task 3 generiert |

---

### Task 1: Basis verifizieren + Phase-1-Worktree anlegen

**Files:** keine Quell-Änderung (Git-Setup)

- [ ] **Step 1: Upstream-Sync-Check**

Run:
```bash
cd /Users/manuelguttmann/Projekte/opencode-workflows-fixes
git fetch origin --prune
git rev-list --count feat/workflows-fixes..origin/dev
```
Expected: `0` (sonst zuerst origin/dev mergen — Verfahren wie Commit `bddf3fe00`: Merge, Konflikte lösen, Typecheck+Tests+PTY-Boot, committen).

- [ ] **Step 2: Worktree für engine-core**

Run:
```bash
git -C /Users/manuelguttmann/Projekte/opencode-workflows-fixes worktree add \
  /Users/manuelguttmann/Projekte/oc-mega-t1 -b mega/engine-core feat/workflows-fixes
cd /Users/manuelguttmann/Projekte/oc-mega-t1 && bun install 2>&1 | tail -2
```
Expected: Worktree erstellt, `bun install` ohne Fehler.

### Task 2: Phase 1 ausführen (Track-Plan T1)

- [ ] **Step 1:** `2026-06-07-mega-t1-engine-core.md` vollständig abarbeiten (subagent-driven, TDD, Commits pro Baustein; Zwischenreviews nach Task 4 [P1/P2+Events] und nach Task 10 [AgentInput-Block] — Reviewer: `pr-review-toolkit:code-reviewer` auf `git diff feat/workflows-fixes...mega/engine-core`).
- [ ] **Step 2:** Abschluss-Gate Phase 1:

Run (im T1-Worktree):
```bash
cd packages/opencode && bun run typecheck && bun test test/workflow/ test/tool/workflow.test.ts --timeout 30000 2>&1 | tail -4
```
Expected: Typecheck clean; alle Tests pass (Zielgröße: bestehende 131 + neue Suiten).

- [ ] **Step 3:** Merge nach `feat/workflows-fixes`:

```bash
cd /Users/manuelguttmann/Projekte/opencode-workflows-fixes
git merge --no-ff mega/engine-core -m "merge: mega track 1 — engine core (P1/P2, events, AgentInput, shell/workflow/question, otel, phases)"
cd packages/opencode && bun run typecheck && bun test test/workflow/ --timeout 30000 2>&1 | tail -3
git -C /Users/manuelguttmann/Projekte/opencode-workflows-fixes push fork feat/workflows-fixes
```
Expected: Fast-forward-artiger Merge ohne Konflikte (T1 ist der einzige Schreiber), grüne Gates.

### Task 3: Phase-2-Pläne generieren (gegen den eingefrorenen Engine-Kontrakt)

**Files:**
- Create: `docs/superpowers/plans/2026-06-07-mega-t2-tool.md` … `mega-t6-docs.md`

- [ ] **Step 1:** Für jeden Track per writing-plans-Verfahren einen vollständigen Bite-Size-Plan schreiben. Pflicht-Inputs pro Plan: Spec §5.x des Tracks, der REALE Post-Phase-1-Code (Kontrakte aus T1 sind jetzt Quelltext, nicht Annahme), Findings-Evidenz aus `.claude/reviews/workflows-roadmap-2026-06-07.md`. Jeder Plan endet mit eigenem Verifikations-Gate (Typecheck + Track-Suiten) und Review-Schritt.
- [ ] **Step 2:** Selbstreview jedes Plans (Platzhalter-Scan, Typ-Konsistenz gegen T1-Kontrakt, Spec-Abdeckung §5.x), committen:
```bash
git add docs/superpowers/plans/2026-06-07-mega-t*.md && git commit -m "docs(plan): mega phase-2 track plans"
```

### Task 4: Phase 2 parallel ausführen

- [ ] **Step 1:** Fünf Worktrees ab Post-Phase-1-Head:
```bash
for t in t2-tool t3-tui t4-acp t5-tests t6-docs; do
  git -C /Users/manuelguttmann/Projekte/opencode-workflows-fixes worktree add \
    /Users/manuelguttmann/Projekte/oc-mega-$t -b mega/$t feat/workflows-fixes
done
```
- [ ] **Step 2:** Pro Track ein Subagenten-Team auf dessen Plan ansetzen (parallel; T-TUI codet gegen den in Spec §5.1 fixierten answer-Kontrakt, nicht gegen T-Tool-Code). Jeder Track: TDD, Commits, Track-Gate grün, Quality+Spec-Review (Muster 3a–3o) im eigenen Worktree.

### Task 5: Phase 3 — Integration

- [ ] **Step 1:** dev-Sync-Check (wie Task 1 Step 1).
- [ ] **Step 2:** Merges in fester Reihenfolge, nach JEDEM Merge Typecheck + betroffene Suiten:
```bash
cd /Users/manuelguttmann/Projekte/opencode-workflows-fixes
for b in mega/t2-tool mega/t3-tui mega/t4-acp mega/t5-tests mega/t6-docs; do
  git merge --no-ff $b -m "merge: mega ${b#mega/}" || break   # Konflikt: sofort lösen, dann weiter
  (cd packages/opencode && bun run typecheck) && (cd packages/tui && bun run typecheck)
done
```
- [ ] **Step 3:** SDK-Regen + Voll-Verifikation:
```bash
bun install && bun script/generate.ts 2>&1 | tail -3
(cd packages/opencode && bun run typecheck && bun test --timeout 30000 2>&1 | tail -4)
(cd packages/tui && bun run typecheck && bun test --timeout 30000 2>&1 | tail -4)
python3 /tmp/ptyboot.py /tmp/oc-mega-boot.log 16   # PTY-Boot-Smoke, kein Fatal-Screen
```
Expected: alles grün, Boot rendert Home-Route.
- [ ] **Step 4:** Adversariales Schlussreview als Ultracode-Workflow über `git diff origin/dev...feat/workflows-fixes` (Muster: Dimensionen → Findings → 3-Verifier, loop-until-dry); CRITICAL/IMPORTANT-Findings fixen, Gate wiederholen.

### Task 6: PR #3 + Showcase

- [ ] **Step 1:** Push + PR:
```bash
git push fork feat/workflows-fixes
gh pr create --repo VasyaYovbak/opencode --base feat/workflows --head mguttmann:feat/workflows-fixes \
  --title "feat(workflow): question/shell/events/nesting/isolation — full review-roadmap round" \
  --body-file /tmp/mega-pr-body.md
```
PR-Body: aktualisiertes Showcase-Material (Stats neu messen wie am 2026-06-07, Matrix + Mermaid um question/shell/events/nesting/isolation erweitern; Vorlage `/tmp/final-pr29789.md`-Struktur).
- [ ] **Step 2:** Showcase-Kommentar auf anomalyco/opencode#29789 aktualisieren (neuer Kommentar mit Delta-Zusammenfassung + Verweis auf PR #3).
- [ ] **Step 3:** Worktrees aufräumen (`git worktree remove /Users/manuelguttmann/Projekte/oc-mega-*` nach Merge), Handoff (`.remember/remember.md`) aktualisieren.
