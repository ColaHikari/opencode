import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { WorkflowInfo, WorkflowRun } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useBindings } from "../keymap"
import { DialogConfirm } from "../ui/dialog-confirm"
import * as Clipboard from "../util/clipboard"
import { getScrollAcceleration } from "../util/scroll"
import {
  formatPhase,
  formatShortElapsed,
  phaseIcon,
  phaseStatus,
  reanchorSelection,
  spentThisMonth,
  statusIcon,
  timestamp,
} from "./dialog-workflow-helpers"

// Re-exported so existing pure derivations keep a single import surface.
export { phaseStatus } from "./dialog-workflow-helpers"

function formatShortDuration(run: WorkflowRun) {
  return formatShortElapsed(run.started_at, run.completed_at)
}

function formatStartedShort(value: unknown) {
  const time = timestamp(value)
  if (!time) return "--"
  const date = new Date(time)
  return `${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")} ${date
    .getHours()
    .toString()
    .padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`
}

function formatLogTime(value: unknown) {
  const time = timestamp(value)
  if (time === undefined) return "--:--:--"
  const date = new Date(time)
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date
    .getSeconds()
    .toString()
    .padStart(2, "0")}`
}

function agentIcon(status: WorkflowRun["agents"][number]["status"]) {
  if (status === "running") return "●"
  if (status === "completed") return "✔"
  return "✖"
}

// Fund 34 (TUI defensive): the engine now closes every agent node at a terminal
// transition (N11) and the orphan sweep normalizes zombies (Fund 15), so a
// terminal run should not carry a `running` agent. Still, render defensively: if
// a terminal run ever shows a lingering `running` agent, treat it as terminal so
// no perpetual live `●` icon appears, and clamp its elapsed time to the run's
// completion instead of `formatShortElapsed`'s `Date.now()` fallback (which made
// the duration grow on every open). Live runs are unchanged.
export function agentEffectiveStatus(run: WorkflowRun, agent: WorkflowRun["agents"][number]) {
  if (run.status !== "running" && agent.status === "running") return "failed"
  return agent.status
}

export function agentEffectiveEnd(run: WorkflowRun, agent: WorkflowRun["agents"][number]) {
  // A real node end always wins. Otherwise, on a terminal run, clamp to the run's
  // completion so the duration is frozen rather than ticking up from Date.now().
  return agent.completed_at ?? (run.status !== "running" ? run.completed_at : undefined)
}

function runPhases(run: WorkflowRun, workflow?: WorkflowInfo) {
  const phases = workflow?.meta.phases?.length
    ? workflow.meta.phases
    : Array.from(
        new Set([
          ...run.logs.flatMap((item) => (item.phase ? [item.phase] : [])),
          ...run.agents.flatMap((agent) => (agent.phase ? [agent.phase] : [])),
          ...(run.current_phase ? [run.current_phase] : []),
        ]),
      )
  return phases.length ? phases : [run.status === "completed" ? "complete" : (run.current_phase ?? "pending")]
}

function runUsage(run: WorkflowRun) {
  const cost = run.agents.reduce((total, agent) => total + (agent.cost ?? 0), 0)
  const tokens = run.agents.reduce(
    (total, agent) => ({
      input: total.input + (agent.tokens?.input ?? 0),
      output: total.output + (agent.tokens?.output ?? 0),
      reasoning: total.reasoning + (agent.tokens?.reasoning ?? 0),
      cache: total.cache + (agent.tokens?.cache.read ?? 0) + (agent.tokens?.cache.write ?? 0),
      total:
        total.total +
        (agent.tokens?.total ?? (agent.tokens ? agent.tokens.input + agent.tokens.output + agent.tokens.reasoning : 0)),
    }),
    { input: 0, output: 0, reasoning: 0, cache: 0, total: 0 },
  )
  return { cost, tokens }
}

function formatTokens(value: number) {
  if (value <= 0) return "--"
  return new Intl.NumberFormat().format(value)
}

function formatShortTokens(value: number) {
  if (value <= 0) return "--"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`
  return value.toString()
}

function formatCost(value: number) {
  if (value <= 0) return "--"
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
}

function agentTokens(agent: WorkflowRun["agents"][number]) {
  return agent.tokens?.total ?? (agent.tokens ? agent.tokens.input + agent.tokens.output + agent.tokens.reasoning : 0)
}

function phaseAgents(run: WorkflowRun, phase?: string) {
  if (!phase) return run.agents
  return run.agents.filter((agent) => agent.phase === phase)
}

type WorkflowPhaseRow = { type: "agent"; agent: WorkflowRun["agents"][number] } | { type: "result" }

function resultPhase(run: WorkflowRun, phases: readonly string[]) {
  if (run.result === undefined) return
  if (run.current_phase && phases.includes(run.current_phase)) return run.current_phase
  return phases.at(-1)
}

function phaseRows(run: WorkflowRun, phases: readonly string[], phase?: string): WorkflowPhaseRow[] {
  const rows: WorkflowPhaseRow[] = phaseAgents(run, phase).map((agent) => ({ type: "agent", agent }))
  if (phase && phase === resultPhase(run, phases)) rows.push({ type: "result" })
  return rows
}

function phaseProgress(run: WorkflowRun, phases: readonly string[], phase: string) {
  const rows = phaseRows(run, phases, phase)
  if (rows.length === 0) return ""
  return `${rows.filter((row) => row.type === "result" || row.agent.status !== "running").length}/${rows.length}`
}

function agentProgress(run: WorkflowRun) {
  if (run.agents.length === 0) return "0 agents"
  return `${run.agents.filter((agent) => agent.status !== "running").length}/${run.agents.length} agents`
}

function agentLabel(agent: WorkflowRun["agents"][number]) {
  return agent.agent ?? `agent:${agent.id}`
}

function modelLabel(agent: WorkflowRun["agents"][number]) {
  if (!agent.model) return "default"
  const model = agent.model.split("/").at(-1) ?? agent.model
  return model.replace(/^claude-/, "Claude ").replace(/-/g, " ")
}

function agentMetrics(run: WorkflowRun, agent: WorkflowRun["agents"][number]) {
  return [
    agentTokens(agent) > 0 ? `${formatShortTokens(agentTokens(agent))} tok` : undefined,
    agent.cost && agent.cost > 0 ? formatCost(agent.cost) : undefined,
    // Fund 34: clamp the end to the run's completion on a terminal run so a
    // lingering node's duration is frozen instead of ticking up from Date.now().
    formatShortElapsed(agent.started_at, agentEffectiveEnd(run, agent)),
  ]
    .filter((item) => item !== undefined)
    .join(" · ")
}

function phaseRowLabel(row: WorkflowPhaseRow) {
  if (row.type === "result") return "workflow:result"
  return agentLabel(row.agent)
}

function phaseRowModel(row: WorkflowPhaseRow) {
  if (row.type === "result") return "local workflow"
  return modelLabel(row.agent)
}

function phaseRowMetrics(run: WorkflowRun, row: WorkflowPhaseRow) {
  if (row.type === "result") return `0 tok · ${formatShortDuration(run)}`
  return agentMetrics(run, row.agent)
}

function phaseRowIcon(run: WorkflowRun, row: WorkflowPhaseRow) {
  if (row.type === "result") return "✔"
  // Fund 34: a lingering `running` agent on a terminal run renders terminal
  // (never the live `●`), so a finished run never shows a perpetually-live agent.
  return agentIcon(agentEffectiveStatus(run, row.agent))
}

function phaseRowTitle(phase: string | undefined, rows: readonly WorkflowPhaseRow[]) {
  const agents = rows.filter((row) => row.type === "agent").length
  const result = rows.some((row) => row.type === "result")
  if (!result) return `${phase ?? "Phase"} · ${agents} agents`
  if (agents === 0) return `${phase ?? "Phase"} · result`
  return `${phase ?? "Phase"} · ${agents} agents + result`
}

function workflowResultText(result: unknown) {
  if (typeof result === "string") return result
  if (result && typeof result === "object" && "summary" in result && typeof result.summary === "string") {
    return result.summary
  }
  return JSON.stringify(result, null, 2) ?? String(result)
}

function wrapResultText(result: unknown, width: number) {
  const limit = Math.max(20, width)
  return workflowResultText(result)
    .split("\n")
    .flatMap((line) => {
      if (line.length === 0) return [""]
      const chunks = [] as string[]
      let rest = line
      while (rest.length > limit) {
        const index = rest.lastIndexOf(" ", limit) > 0 ? rest.lastIndexOf(" ", limit) : limit
        chunks.push(rest.slice(0, index))
        rest = rest.slice(index).trimStart()
      }
      chunks.push(rest)
      return chunks
    })
}

function fitColumns(left: string, right: string, width: number) {
  const size = Math.max(1, width)
  if (!right) return Locale.truncate(left, size)
  const suffix = Locale.truncate(right, size)
  const prefix = Locale.truncate(left, Math.max(1, size - suffix.length - 1))
  return `${prefix.padEnd(Math.max(0, size - suffix.length - 1))} ${suffix}`
}

function fitCell(value: string, width: number, align: "left" | "right" = "left") {
  const text = Locale.truncate(value, Math.max(1, width))
  return align === "right" ? text.padStart(width) : text.padEnd(width)
}

function shortRunID(run: WorkflowRun) {
  return `#${run.id.replace(/^job_/, "").slice(-8)}`
}

function statusLabel(status: WorkflowRun["status"]) {
  if (status === "completed") return "done"
  if (status === "cancelled") return "cancel"
  if (status === "interrupted") return "interrupt"
  return status
}

function dashboardPhase(run: WorkflowRun, workflow?: WorkflowInfo) {
  if (run.status !== "running") return run.status === "completed" ? "complete" : (run.current_phase ?? run.status)
  return formatPhase(run, workflow)
}

// Funds 57, 58: the STATUS cell must fit "⊘ interrupt" (icon + space + the 9-char
// "interrupt" label) without truncation, so the cell is 11 wide and the layout
// budget reserves 12 for it (cell + its separator space). Previously the cell was
// 8 wide and "interrupt" was clipped to "interr…".
const STATUS_WIDTH = 11

function dashboardWidths(width: number) {
  const total = Math.min(width, 150)
  const phase = total < 104 ? 8 : 12
  const fixed = 2 + 10 + (STATUS_WIDTH + 1) + 11 + 7 + phase + 8 + 8
  const available = Math.max(28, total - fixed)
  const workflow = Math.min(26, Math.max(14, Math.floor(available * 0.38)))
  return { workflow, phase, input: Math.max(14, available - workflow), total }
}

function workflowInput(run: WorkflowRun) {
  if (!run.args || Object.keys(run.args).length === 0) return "--"
  return Object.entries(run.args)
    .map(([key, value]) => `${key}=${formatInputValue(value)}`)
    .join(" ")
}

function formatInputValue(value: unknown) {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  return JSON.stringify(value) ?? String(value)
}

function dashboardRowText(
  input: {
    marker: string
    id: string
    workflow: string
    input: string
    status: string
    started: string
    duration: string
    phase: string
    tokens: string
  },
  width: number,
) {
  const columns = dashboardWidths(width)
  return Locale.truncate(
    [
      fitCell(input.marker, 2),
      fitCell(input.id, 10),
      fitCell(input.workflow, columns.workflow),
      fitCell(input.status, STATUS_WIDTH),
      fitCell(input.started, 12),
      fitCell(input.duration, 7),
      fitCell(input.phase, columns.phase),
      fitCell(input.tokens, 8),
      fitCell(input.input, columns.input),
    ].join(" "),
    columns.total,
  )
}

function sectionTitle(title: string, width: number) {
  return ` ${title} ${"─".repeat(Math.max(0, width - title.length - 2))}`
}

function scrollIndexIntoView(scroll: ScrollBoxRenderable | undefined, index: number) {
  if (!scroll) return
  if (index < scroll.scrollTop) scroll.scrollBy(index - scroll.scrollTop)
  if (index >= scroll.scrollTop + scroll.height) scroll.scrollBy(index - scroll.scrollTop - scroll.height + 1)
}

export function DialogWorkflow(props?: { openRunID?: string; openPhase?: string; openAgentID?: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  dialog.setSize("fullscreen")

  // Selection is anchored on a run.id, not an index: the runs list re-sorts on
  // every poll, so a positional selection would silently jump to a different run.
  const [store, setStore] = createStore({ selected: 0, selectedID: "" })
  let scroll: ScrollBoxRenderable | undefined

  // N17: workflow.list() is the static definition discovery and only changes when
  // files change, so it is fetched once on open (and on explicit refresh) rather
  // than re-run every second. Only the runs are polled.
  const [workflowsResource, { refetch: refetchWorkflows }] = createResource(async () => {
    const result = await sdk.client.workflow.list()
    return result.data ?? []
  })
  const [runsResource, { refetch }] = createResource(async () => {
    const result = await sdk.client.workflow.runs()
    return (result.data ?? []).toSorted((a, b) => (timestamp(b.started_at) ?? 0) - (timestamp(a.started_at) ?? 0))
  })
  const runs = createMemo(() => runsResource() ?? [])
  const workflows = createMemo(() => workflowsResource() ?? [])
  const selected = createMemo(() => runs()[store.selected])
  const activeWorkers = createMemo(() => runs().filter((run) => run.status === "running").length)
  const tableWidth = createMemo(() => Math.max(40, dimensions().width - 5))
  const monthlySpend = createMemo(() => spentThisMonth(runs()))

  // Fund 10: re-anchor the selection to the row that still carries the previously
  // selected id after each re-sort, clamping when that run is gone (e.g. deleted).
  createEffect(() => {
    const next = reanchorSelection(store.selectedID || selected()?.id, runs())
    if (next !== store.selected) setStore("selected", next)
    const id = runs()[next]?.id ?? ""
    if (id !== store.selectedID) setStore("selectedID", id)
  })

  let openedInitial = false
  createEffect(() => {
    if (openedInitial) return
    if (!props?.openRunID) return
    // N18: a deep-link must open the run even when no workflow definitions are
    // discovered (the run itself is enough); previously the missing-definitions
    // guard made the deep-link silently fail.
    const run = runs().find((item) => item.id === props.openRunID)
    if (!run) return
    openedInitial = true
    dialog.replace(
      () => (
        <DialogWorkflowRun
          id={run.id}
          initial={run}
          workflows={workflows()}
          initialPhase={props.openPhase}
          initialAgentID={props.openAgentID}
        />
      ),
      undefined,
      {
        notifyClose: false,
      },
    )
  })

  onMount(() => {
    const interval = setInterval(() => void refetch(), 1000)
    onCleanup(() => clearInterval(interval))
  })

  function workflow(run: WorkflowRun) {
    return workflows().find((item) => item.name === run.workflow)
  }

  function move(direction: number) {
    if (runs().length === 0) return
    const next = Math.max(0, Math.min(runs().length - 1, store.selected + direction))
    setStore("selected", next)
    setStore("selectedID", runs()[next]?.id ?? "")
    if (!scroll) return
    if (next < scroll.scrollTop) scroll.scrollBy(next - scroll.scrollTop)
    if (next >= scroll.scrollTop + scroll.height) scroll.scrollBy(next - scroll.scrollTop - scroll.height + 1)
  }

  function selectIndex(index: number) {
    setStore("selected", index)
    setStore("selectedID", runs()[index]?.id ?? "")
  }

  function openSelected() {
    const run = selected()
    if (!run) return
    dialog.replace(
      () => <DialogWorkflowRun id={run.id} initial={run} workflows={workflows()} />,
      () => {
        dialog.replace(() => <DialogWorkflow />, undefined, { notifyClose: false })
        return false
      },
    )
  }

  function cancelSelected() {
    const run = selected()
    if (!run || run.status !== "running") return
    void sdk.client.workflow
      .cancel({ id: run.id })
      .then(() => {
        toast.show({ message: `Killed workflow ${run.id}`, variant: "info" })
        void refetch()
      })
      .catch(toast.error)
  }

  // Fund 10 (behavior change): deleting a run from history is irreversible, so it
  // now asks for confirmation first. DialogConfirm.show replaces the dashboard, so
  // the dashboard is re-opened afterwards whichever way the prompt resolves.
  async function deleteSelected() {
    const run = selected()
    if (!run) return
    const reopen = () => dialog.replace(() => <DialogWorkflow />, undefined, { notifyClose: false })
    const confirmed = await DialogConfirm.show(
      dialog,
      "Delete workflow run",
      `Delete run ${shortRunID(run)} (${run.workflow}) from history? This cannot be undone.`,
      "keep",
    )
    if (!confirmed) {
      reopen()
      return
    }
    sdk.client.workflow
      .delete({ id: run.id })
      .then(() => toast.show({ message: `Deleted workflow ${run.id}`, variant: "info" }))
      .catch(toast.error)
      .finally(() => {
        reopen()
        void refetch()
      })
  }

  useBindings(() => ({
    bindings: [
      { key: "up,k", desc: "Previous workflow run", group: "Workflow", cmd: () => move(-1) },
      { key: "down,j", desc: "Next workflow run", group: "Workflow", cmd: () => move(1) },
      { key: "return", desc: "View workflow details", group: "Workflow", cmd: openSelected },
      { key: "r", desc: "Refresh workflows", group: "Workflow", cmd: () => void refetchWorkflows() },
      { key: "x", desc: "Kill workflow run", group: "Workflow", cmd: cancelSelected },
      { key: "d", desc: "Delete workflow run from history", group: "Workflow", cmd: () => void deleteSelected() },
      { key: "b", desc: "Exit workflows dashboard", group: "Workflow", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height - 1}
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      gap={1}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          OpenCode Workflows
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>Select a run and press [Enter] to inspect phases, agents, and results.</text>
      <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
        {dashboardRowText(
          {
            marker: "",
            id: "RUN",
            workflow: "WORKFLOW",
            input: "INPUT",
            status: "STATUS",
            started: "STARTED",
            duration: "DUR",
            phase: "PHASE",
            tokens: "TOKENS",
          },
          tableWidth(),
        )}
      </text>
      <text fg={theme.textMuted}>{"─".repeat(tableWidth())}</text>

      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        flexGrow={1}
        minHeight={0}
        verticalScrollbarOptions={{ visible: true }}
        horizontalScrollbarOptions={{ visible: false }}
        scrollAcceleration={getScrollAcceleration()}
      >
        <For
          each={runs()}
          fallback={
            <box paddingTop={1}>
              <text fg={theme.textMuted}>
                No workflow runs yet. Start one with /workflow workflow_name --arg=value.
              </text>
            </box>
          }
        >
          {(run, index) => {
            const active = createMemo(() => index() === store.selected)
            return (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? theme.primary : undefined}
                onMouseDown={() => selectIndex(index())}
                onMouseUp={openSelected}
              >
                <text fg={active() ? selectedForeground(theme) : theme.text} wrapMode="none" overflow="hidden">
                  {dashboardRowText(
                    {
                      marker: active() ? "›" : "",
                      id: shortRunID(run),
                      workflow: run.workflow,
                      input: workflowInput(run),
                      status: `${statusIcon(run.status)} ${statusLabel(run.status)}`,
                      started: formatStartedShort(run.started_at),
                      duration: formatShortDuration(run),
                      phase: dashboardPhase(run, workflow(run)),
                      tokens: formatShortTokens(runUsage(run).tokens.total),
                    },
                    tableWidth(),
                  )}
                </text>
              </box>
            )
          }}
        </For>
      </scrollbox>

      <text fg={theme.textMuted}>{"─".repeat(tableWidth())}</text>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>
          Spent this month: {formatCost(monthlySpend())} | Active Background Workers: {activeWorkers()}
        </text>
        <text fg={theme.textMuted}>
          [Enter] View Details | [R] Refresh | [X] Kill | [D] Delete history | [Esc]/[B] Exit
        </text>
      </box>
    </box>
  )
}

function DialogWorkflowRun(props: {
  id: string
  initial: WorkflowRun
  workflows: WorkflowInfo[]
  initialPhase?: string
  initialAgentID?: string
}) {
  const dialog = useDialog()
  const route = useRoute()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [copyNotice, setCopyNotice] = createSignal(false)
  dialog.setSize("fullscreen")
  let phaseScroll: ScrollBoxRenderable | undefined
  let agentScroll: ScrollBoxRenderable | undefined
  let copyNoticeTimeout: ReturnType<typeof setTimeout> | undefined

  const [run, { refetch }] = createResource(async () => {
    const result = await sdk.client.workflow.get({ id: props.id })
    return result.data ?? props.initial
  })
  const current = createMemo(() => run() ?? props.initial)
  const workflow = createMemo(() => props.workflows.find((item) => item.name === current().workflow))
  const phases = createMemo(() => runPhases(current(), workflow()))
  const [store, setStore] = createStore({
    runID: "",
    selectedPhase: 0,
    selectedAgent: 0,
    resultOffset: 0,
  })
  const selectedPhase = createMemo(() => phases()[store.selectedPhase] ?? phases()[0])
  const selectedPhaseRows = createMemo(() => phaseRows(current(), phases(), selectedPhase()))
  // N7: ctx.log entries are persisted on the run but were never surfaced anywhere
  // in the TUI (the docs promise they are visible). Show the logs scoped to the
  // selected phase, plus any phase-less entries (the engine writes some logs
  // before a phase is set).
  const phaseLogs = createMemo(() =>
    current().logs.filter((entry) => !entry.phase || entry.phase === selectedPhase()),
  )
  const selectedRow = createMemo(() => selectedPhaseRows()[store.selectedAgent])
  const selectedResult = createMemo(() => selectedRow()?.type === "result" && current().result !== undefined)
  const phasePanelWidth = createMemo(() => Math.min(44, Math.max(28, Math.floor((dimensions().width - 6) * 0.28))))
  const agentPanelWidth = createMemo(() => Math.max(24, dimensions().width - phasePanelWidth() - 8))
  const resultLines = createMemo(() => wrapResultText(current().result, agentPanelWidth() - 4))
  const resultBodyLines = createMemo(() => Math.max(1, dimensions().height - 14))
  const visibleResultLines = createMemo(() =>
    resultLines().slice(store.resultOffset, store.resultOffset + resultBodyLines()),
  )
  const headerWidth = createMemo(() => Math.max(20, dimensions().width - 4))
  const description = createMemo(() => {
    const summary = workflow()?.meta.description ?? `Run ${current().id.replace(/^job_/, "#")}`
    if (phases().length === 0) return summary
    return `${summary}, across ${phases().length} phases`
  })

  createEffect(() => {
    if (store.runID === current().id) return
    const initialIndex = props.initialPhase ? phases().indexOf(props.initialPhase) : -1
    const initialRows = initialIndex >= 0 ? phaseRows(current(), phases(), props.initialPhase) : []
    const initialAgentIndex = props.initialAgentID
      ? initialRows.findIndex((row) => row.type === "agent" && row.agent.id === props.initialAgentID)
      : -1
    const currentPhase = current().current_phase
    const currentIndex = currentPhase ? phases().indexOf(currentPhase) : -1
    const currentRows = currentPhase ? phaseRows(current(), phases(), currentPhase).length : 0
    const resultIndex = phases().findIndex((phase) => phase === resultPhase(current(), phases()))
    const agentIndex = phases().findIndex((phase) => current().agents.some((agent) => agent.phase === phase))
    const next =
      initialIndex >= 0
        ? initialIndex
        : currentIndex >= 0 && currentRows > 0
          ? currentIndex
          : resultIndex >= 0
            ? resultIndex
            : agentIndex
    setStore("runID", current().id)
    if (next >= 0) {
      setStore("selectedPhase", next)
      setStore("selectedAgent", initialAgentIndex >= 0 ? initialAgentIndex : 0)
      setStore("resultOffset", 0)
      return
    }
    if (store.selectedPhase >= phases().length) {
      setStore("selectedPhase", 0)
      setStore("selectedAgent", 0)
      setStore("resultOffset", 0)
    }
  })

  createEffect(() => {
    if (store.selectedPhase < phases().length) return
    setStore("selectedPhase", Math.max(0, phases().length - 1))
    setStore("selectedAgent", 0)
    setStore("resultOffset", 0)
  })

  createEffect(() => {
    if (store.selectedAgent < selectedPhaseRows().length) return
    setStore("selectedAgent", Math.max(0, selectedPhaseRows().length - 1))
    setStore("resultOffset", 0)
  })

  createEffect(() => {
    if (!selectedResult()) return
    if (store.resultOffset <= Math.max(0, resultLines().length - resultBodyLines())) return
    setStore("resultOffset", Math.max(0, resultLines().length - resultBodyLines()))
  })

  createEffect(() => {
    const index = store.selectedPhase
    requestAnimationFrame(() => scrollIndexIntoView(phaseScroll, index))
  })

  createEffect(() => {
    const index = store.selectedAgent
    if (selectedResult()) return
    requestAnimationFrame(() => scrollIndexIntoView(agentScroll, index))
  })

  onMount(() => {
    const interval = setInterval(() => {
      if (current().status === "running") void refetch()
    }, 1000)
    onCleanup(() => clearInterval(interval))
  })

  onCleanup(() => {
    if (copyNoticeTimeout) clearTimeout(copyNoticeTimeout)
  })

  const back = () => dialog.replace(() => <DialogWorkflow />, undefined, { notifyClose: false })
  const cancel = () => {
    if (current().status !== "running") return
    void sdk.client.workflow
      .cancel({ id: current().id })
      .then(() => {
        toast.show({ message: `Killed workflow ${current().id}`, variant: "info" })
        void refetch()
      })
      .catch(toast.error)
  }

  function openAgentSession() {
    const row = selectedRow()
    if (row?.type === "result") return
    const sessionID = row?.agent.session_id
    if (!sessionID) return
    route.navigate({
      type: "session",
      sessionID,
      workflowRunID: current().id,
      workflowPhase: selectedPhase(),
      workflowAgentID: row.agent.id,
      workflowReturnSessionID: route.data.type === "session" ? route.data.sessionID : undefined,
    })
    dialog.clear()
  }

  function movePhase(direction: number) {
    if (phases().length === 0) return
    const next = Math.max(0, Math.min(phases().length - 1, store.selectedPhase + direction))
    setStore("selectedPhase", next)
    setStore("selectedAgent", 0)
    setStore("resultOffset", 0)
  }

  function moveAgent(direction: number) {
    if (selectedPhaseRows().length === 0) return
    setStore(
      "selectedAgent",
      (store.selectedAgent + direction + selectedPhaseRows().length) % selectedPhaseRows().length,
    )
    setStore("resultOffset", 0)
  }

  function pageResult(direction: number) {
    setStore(
      "resultOffset",
      Math.max(0, Math.min(Math.max(0, resultLines().length - resultBodyLines()), store.resultOffset + direction)),
    )
  }

  function copySelectedResponse() {
    const row = selectedRow()
    const text = row?.type === "result" ? workflowResultText(current().result) : row?.agent.output
    if (!text?.trim()) {
      toast.show({ message: "No response to copy", variant: "info" })
      return
    }
    void Clipboard.copy(text)
      .then(() => {
        setCopyNotice(true)
        if (copyNoticeTimeout) clearTimeout(copyNoticeTimeout)
        copyNoticeTimeout = setTimeout(() => setCopyNotice(false), 1800)
        toast.show({ message: "Workflow response copied to clipboard", variant: "success" })
      })
      .catch(() => toast.show({ message: "Failed to copy workflow response", variant: "error" }))
  }

  useBindings(() => ({
    bindings: [
      { key: "b", desc: "Back to workflow dashboard", group: "Workflow", cmd: back },
      { key: "escape", desc: "Back to workflow dashboard", group: "Workflow", cmd: back },
      { key: "return,o", desc: "Open selected subagent", group: "Workflow", cmd: openAgentSession },
      { key: "y", desc: "Copy selected response", group: "Workflow", cmd: copySelectedResponse },
      { key: "x", desc: "Kill workflow run", group: "Workflow", cmd: cancel },
      { key: "up,k", desc: "Previous phase", group: "Workflow", cmd: () => movePhase(-1) },
      { key: "down,j", desc: "Next phase", group: "Workflow", cmd: () => movePhase(1) },
      { key: "left,h", desc: "Previous phase agent", group: "Workflow", cmd: () => moveAgent(-1) },
      { key: "right,l", desc: "Next phase agent", group: "Workflow", cmd: () => moveAgent(1) },
      {
        key: "pageup,ctrl+b",
        desc: "Page workflow details up",
        group: "Workflow",
        cmd: () =>
          selectedResult() ? pageResult(-resultBodyLines()) : agentScroll?.scrollBy(-(agentScroll?.height ?? 10)),
      },
      {
        key: "pagedown,ctrl+f",
        desc: "Page workflow details down",
        group: "Workflow",
        cmd: () =>
          selectedResult() ? pageResult(resultBodyLines()) : agentScroll?.scrollBy(agentScroll?.height ?? 10),
      },
    ],
  }))

  function PhaseRowItem(props: { row: WorkflowPhaseRow; index: () => number }) {
    const active = createMemo(() => props.index() === store.selectedAgent)
    const color = createMemo(() => {
      if (active()) return theme.primary
      if (props.row.type === "result") return theme.text
      if (props.row.agent.status === "failed") return theme.error
      if (props.row.agent.status === "completed") return theme.text
      return theme.textMuted
    })
    const labelWidth = createMemo(() => Math.min(30, Math.max(14, Math.floor(agentPanelWidth() * 0.32))))
    const rowText = createMemo(() =>
      fitColumns(
        `${active() ? "›" : phaseRowIcon(current(), props.row)} ${Locale.truncate(phaseRowLabel(props.row), labelWidth()).padEnd(labelWidth())} ${phaseRowModel(props.row)}`,
        phaseRowMetrics(current(), props.row),
        agentPanelWidth() - 2,
      ),
    )

    return (
      <text
        fg={active() ? theme.primary : color()}
        wrapMode="none"
        overflow="hidden"
        onMouseDown={() => setStore("selectedAgent", props.index())}
      >
        {rowText()}
      </text>
    )
  }

  return (
    <box
      width={dimensions().width}
      height={dimensions().height - 1}
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      gap={1}
    >
      <box height={2} flexShrink={0}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none" overflow="hidden">
          {fitColumns(
            workflow()?.meta.name ?? current().workflow,
            `${agentProgress(current())} · ${formatShortDuration(current())}`,
            headerWidth(),
          )}
        </text>
        <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
          {fitColumns(description(), `${statusIcon(current().status)} ${statusLabel(current().status)}`, headerWidth())}
        </text>
      </box>

      <box
        flexGrow={1}
        minHeight={0}
        flexDirection="row"
        border={["top", "bottom", "left", "right"]}
        borderColor={theme.border}
      >
        <box width={phasePanelWidth()} paddingLeft={1} paddingRight={1} minHeight={0}>
          <text fg={theme.text} wrapMode="none">
            {sectionTitle("Phases", phasePanelWidth() - 2)}
          </text>
          <scrollbox
            ref={(element: ScrollBoxRenderable) => (phaseScroll = element)}
            flexGrow={1}
            minHeight={0}
            verticalScrollbarOptions={{ visible: false }}
            horizontalScrollbarOptions={{ visible: false }}
            scrollAcceleration={getScrollAcceleration()}
          >
            <For each={phases()}>
              {(phase, index) => {
                const status = createMemo(() => phaseStatus(current(), phases(), phase))
                const active = createMemo(() => index() === store.selectedPhase)
                const marker = createMemo(() =>
                  active() ? "›" : status() === "pending" ? `${index() + 1}` : phaseIcon(status()),
                )
                const color = createMemo(() => {
                  if (active()) return theme.primary
                  if (status() === "completed") return theme.text
                  if (status() === "failed" || status() === "interrupted") return theme.error
                  return theme.textMuted
                })
                return (
                  <box
                    flexDirection="row"
                    width="100%"
                    onMouseDown={() => {
                      setStore("selectedPhase", index())
                      setStore("selectedAgent", 0)
                    }}
                  >
                    <text
                      width={3}
                      fg={
                        active()
                          ? theme.primary
                          : status() === "completed"
                            ? theme.success
                            : status() === "failed" || status() === "interrupted"
                              ? theme.error
                              : theme.textMuted
                      }
                      wrapMode="none"
                    >
                      {marker()}
                    </text>
                    <box flexGrow={1} minWidth={0}>
                      <text fg={color()} wrapMode="none" overflow="hidden">
                        {active() ? `${index() + 1} ${phase}` : phase}
                      </text>
                    </box>
                    <text fg={active() ? theme.primary : theme.textMuted} flexShrink={0} wrapMode="none">
                      {phaseProgress(current(), phases(), phase)}
                    </text>
                  </box>
                )
              }}
            </For>
          </scrollbox>
        </box>
        <box width={1} border={["left"]} borderColor={theme.border} />
        <box flexGrow={1} minWidth={0} paddingLeft={1} paddingRight={1} minHeight={0}>
          <text fg={theme.text} wrapMode="none" overflow="hidden">
            {sectionTitle(phaseRowTitle(selectedPhase(), selectedPhaseRows()), agentPanelWidth() - 2)}
          </text>
          <Show
            when={!selectedResult()}
            fallback={
              <box flexShrink={0}>
                <Show
                  when={selectedPhaseRows().length}
                  fallback={
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>No agent runs or workflow result recorded for this phase.</text>
                    </box>
                  }
                >
                  <For each={selectedPhaseRows()}>{(row, index) => <PhaseRowItem row={row} index={index} />}</For>
                </Show>
              </box>
            }
          >
            <scrollbox
              ref={(element: ScrollBoxRenderable) => (agentScroll = element)}
              flexGrow={1}
              minHeight={0}
              verticalScrollbarOptions={{ visible: false }}
              horizontalScrollbarOptions={{ visible: false }}
              scrollAcceleration={getScrollAcceleration()}
            >
              <Show
                when={selectedPhaseRows().length}
                fallback={
                  <box paddingLeft={1}>
                    <text fg={theme.textMuted}>No agent runs or workflow result recorded for this phase.</text>
                  </box>
                }
              >
                <For each={selectedPhaseRows()}>{(row, index) => <PhaseRowItem row={row} index={index} />}</For>
              </Show>
              <Show when={current().error}>
                <box paddingTop={1} paddingLeft={1}>
                  <text fg={theme.error} wrapMode="word">
                    Error: {current().error}
                  </text>
                </box>
              </Show>
            </scrollbox>
          </Show>
          <Show when={selectedResult()}>
            <box height={1} flexShrink={0} border={["top"]} borderColor={theme.border} />
            <box flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
              <For each={visibleResultLines()}>
                {(line) => (
                  <text fg={theme.text} wrapMode="none" overflow="hidden">
                    {line}
                  </text>
                )}
              </For>
              <Show when={current().error}>
                <box paddingTop={1} paddingLeft={1}>
                  <text fg={theme.error} wrapMode="word">
                    Error: {current().error}
                  </text>
                </box>
              </Show>
            </box>
          </Show>
          <Show when={phaseLogs().length}>
            <box height={1} flexShrink={0} border={["top"]} borderColor={theme.border} />
            <box flexShrink={0} paddingLeft={1}>
              <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
                {sectionTitle("Logs", agentPanelWidth() - 4)}
              </text>
              <For each={phaseLogs()}>
                {(entry) => (
                  <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
                    {formatLogTime(entry.time)} {entry.message}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
      </box>

      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>
          [↑/↓] Phase | [←/→] Agent/result | [Y] Copy response | [Enter/O] Open agent | [X] Kill run | [Esc/B] Back
        </text>
        <Show when={current().status === "running"}>
          <text fg={theme.primary}>live</text>
        </Show>
      </box>
      <Show when={copyNotice()}>
        <box
          position="absolute"
          right={4}
          bottom={3}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme.backgroundPanel}
          border={["left", "right"]}
          borderColor={theme.success}
        >
          <text fg={theme.text}>Response copied to clipboard</text>
        </box>
      </Show>
      <box height={0.5} />
    </box>
  )
}
