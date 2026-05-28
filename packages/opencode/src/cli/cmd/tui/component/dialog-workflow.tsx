import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { WorkflowInfo, WorkflowRun } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { createEffect, createMemo, createResource, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useBindings } from "../keymap"
import { getScrollAcceleration } from "../util/scroll"

type WorkflowData = {
  workflows: WorkflowInfo[]
  runs: WorkflowRun[]
}

function timestamp(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function formatDuration(run: WorkflowRun) {
  return formatElapsed(run.started_at, run.completed_at)
}

function formatElapsed(started_at: unknown, completed_at?: unknown) {
  const start = timestamp(started_at)
  if (!start) return "--:--"
  const seconds = Math.max(0, Math.floor(((timestamp(completed_at) ?? Date.now()) - start) / 1000))
  return `${Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0")}:${Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`
}

function formatTime(value: unknown) {
  const time = timestamp(value)
  if (!time) return "unknown"
  return new Date(time).toLocaleTimeString()
}

function formatStarted(value: unknown) {
  const time = timestamp(value)
  if (!time) return "unknown"
  const date = new Date(time)
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date
    .getDate()
    .toString()
    .padStart(2, "0")} ${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}`
}

function statusIcon(status: WorkflowRun["status"]) {
  if (status === "running") return "●"
  if (status === "completed") return "✔"
  if (status === "failed") return "✖"
  return "◌"
}

function agentIcon(status: WorkflowRun["agents"][number]["status"]) {
  if (status === "running") return "●"
  if (status === "completed") return "✔"
  return "✖"
}

function formatPhase(run: WorkflowRun, workflow?: WorkflowInfo) {
  if (run.status !== "running") return "[---] complete"
  const phases = workflow?.meta.phases ?? []
  if (!run.current_phase || phases.length === 0) return run.current_phase ?? "pending"
  const index = phases.indexOf(run.current_phase)
  return `[${index >= 0 ? index + 1 : "?"}/${phases.length}] ${run.current_phase}`
}

function runPhases(run: WorkflowRun, workflow?: WorkflowInfo) {
  const phases = workflow?.meta.phases?.length
    ? workflow.meta.phases
    : Array.from(
        new Set([
          ...run.logs.flatMap((item) => (item.phase ? [item.phase] : [])),
          ...(run.current_phase ? [run.current_phase] : []),
        ]),
      )
  return phases.length ? phases : [run.status === "completed" ? "complete" : (run.current_phase ?? "pending")]
}

function phaseStatus(run: WorkflowRun, phases: readonly string[], phase: string) {
  const current = run.current_phase ? phases.indexOf(run.current_phase) : -1
  const index = phases.indexOf(phase)
  if (run.status === "running") {
    if (index < current) return "completed"
    if (index === current) return "running"
    return "pending"
  }
  if (index < current || (run.status === "completed" && (current === -1 || index <= current))) return "completed"
  if (index === current) return run.status
  return "pending"
}

function phaseIcon(status: ReturnType<typeof phaseStatus>) {
  if (status === "completed") return "✔"
  if (status === "running") return "●"
  if (status === "failed") return "✖"
  return "◌"
}

function formatValue(value: unknown) {
  if (value === undefined) return ""
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

function formatResult(value: unknown) {
  if (!value || typeof value !== "object") return formatValue(value)
  if ("final" in value && typeof value.final === "string") return value.final
  if ("summary" in value && typeof value.summary === "string") return value.summary
  return formatValue(value)
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
        (agent.tokens?.total ??
          (agent.tokens ? agent.tokens.input + agent.tokens.output + agent.tokens.reasoning : 0)),
    }),
    { input: 0, output: 0, reasoning: 0, cache: 0, total: 0 },
  )
  return { cost, tokens }
}

function formatTokens(value: number) {
  if (value <= 0) return "--"
  return new Intl.NumberFormat().format(value)
}

function formatCost(value: number) {
  if (value <= 0) return "--"
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
}

function rowText(columns: string[]) {
  return [
    columns[0].padEnd(2),
    columns[1].padEnd(8),
    Locale.truncate(columns[2], 20).padEnd(22),
    columns[3].padEnd(12),
    columns[4].padEnd(17),
    columns[5].padEnd(10),
    Locale.truncate(columns[6], 24).padEnd(26),
    columns[7],
  ].join(" ")
}

export function DialogWorkflow(props?: { openRunID?: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  dialog.setSize("fullscreen")

  const [store, setStore] = createStore({ selected: 0 })
  let scroll: ScrollBoxRenderable | undefined

  const [data, { refetch }] = createResource(async (): Promise<WorkflowData> => {
    const [workflows, runs] = await Promise.all([sdk.client.workflow.list(), sdk.client.workflow.runs()])
    return {
      workflows: workflows.data ?? [],
      runs: (runs.data ?? []).toSorted((a, b) => (timestamp(b.started_at) ?? 0) - (timestamp(a.started_at) ?? 0)),
    }
  })
  const runs = createMemo(() => data()?.runs ?? [])
  const workflows = createMemo(() => data()?.workflows ?? [])
  const selected = createMemo(() => runs()[store.selected])
  const activeWorkers = createMemo(() => runs().filter((run) => run.status === "running").length)
  const spentThisMonth = createMemo(() => {
    const start = new Date()
    start.setDate(1)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setMonth(end.getMonth() + 1)
    return runs()
      .filter((run) => {
        const started = Number(run.started_at)
        return Number.isFinite(started) && started >= start.getTime() && started < end.getTime()
      })
      .reduce((total, run) => total + run.agents.reduce((sum, agent) => sum + (agent.cost ?? 0), 0), 0)
  })

  createEffect(() => {
    if (store.selected >= runs().length) setStore("selected", Math.max(0, runs().length - 1))
  })

  let openedInitial = false
  createEffect(() => {
    if (openedInitial) return
    if (!props?.openRunID) return
    const run = runs().find((item) => item.id === props.openRunID)
    if (!run || workflows().length === 0) return
    openedInitial = true
    dialog.replace(() => <DialogWorkflowRun id={run.id} initial={run} workflows={workflows()} />, undefined, {
      notifyClose: false,
    })
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
    if (!scroll) return
    if (next < scroll.scrollTop) scroll.scrollBy(next - scroll.scrollTop)
    if (next >= scroll.scrollTop + scroll.height) scroll.scrollBy(next - scroll.scrollTop - scroll.height + 1)
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

  function deleteSelected() {
    const run = selected()
    if (!run) return
    void sdk.client.workflow
      .delete({ id: run.id })
      .then(() => {
        toast.show({ message: `Deleted workflow ${run.id}`, variant: "info" })
        void refetch()
      })
      .catch(toast.error)
  }

  useBindings(() => ({
    bindings: [
      { key: "up,k", desc: "Previous workflow run", group: "Workflow", cmd: () => move(-1) },
      { key: "down,j", desc: "Next workflow run", group: "Workflow", cmd: () => move(1) },
      { key: "return", desc: "View workflow details", group: "Workflow", cmd: openSelected },
      { key: "x", desc: "Kill workflow run", group: "Workflow", cmd: cancelSelected },
      { key: "d", desc: "Delete workflow run from history", group: "Workflow", cmd: deleteSelected },
      { key: "b", desc: "Exit workflows dashboard", group: "Workflow", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height - 1} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          OpenCode Workflows Master Dashboard
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>Select a run and press [Enter] to inspect isolated step metadata.</text>
      <text fg={theme.textMuted}>
        {rowText(["", "ID", "WORKFLOW NAME", "STATUS", "STARTED", "DURATION", "ACTIVE PHASE", "TOKENS"])}
      </text>
      <text fg={theme.textMuted}>{"─".repeat(Math.max(40, dimensions().width - 5))}</text>

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
                onMouseDown={() => setStore("selected", index())}
                onMouseUp={openSelected}
              >
                <text fg={active() ? selectedForeground(theme) : theme.text}>
                  {rowText([
                    active() ? "❯" : "",
                    run.id.replace(/^job_/, "#"),
                    run.workflow,
                    `${statusIcon(run.status)} ${run.status.toUpperCase()}`,
                    formatStarted(run.started_at),
                    formatDuration(run),
                    formatPhase(run, workflow(run)),
                    formatTokens(runUsage(run).tokens.total),
                  ])}
                </text>
              </box>
            )
          }}
        </For>
      </scrollbox>

      <text fg={theme.textMuted}>{"─".repeat(Math.max(40, dimensions().width - 5))}</text>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>
          Spent this month: {formatCost(spentThisMonth())} | Active Background Workers: {activeWorkers()}
        </text>
        <text fg={theme.textMuted}>[Enter] View Details | [X] Kill workflow run | [D] Delete history | [Esc]/[B] Exit</text>
      </box>
    </box>
  )
}

function DialogWorkflowRun(props: { id: string; initial: WorkflowRun; workflows: WorkflowInfo[] }) {
  const dialog = useDialog()
  const route = useRoute()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  dialog.setSize("fullscreen")
  let scroll: ScrollBoxRenderable | undefined

  const [run, { refetch }] = createResource(async () => {
    const result = await sdk.client.workflow.get({ id: props.id })
    return result.data ?? props.initial
  })
  const current = createMemo(() => run() ?? props.initial)
  const usage = createMemo(() => runUsage(current()))
  const workflow = createMemo(() => props.workflows.find((item) => item.name === current().workflow))
  const phases = createMemo(() => runPhases(current(), workflow()))
  const [store, setStore] = createStore({ runID: "", selectedPhase: 0, view: "overview" as "overview" | "telemetry" })

  createEffect(() => {
    if (store.runID === current().id) return
    const currentPhase = current().current_phase
    const next = currentPhase ? phases().indexOf(currentPhase) : 0
    setStore("runID", current().id)
    if (next >= 0) {
      setStore("selectedPhase", next)
      return
    }
    if (store.selectedPhase >= phases().length) setStore("selectedPhase", 0)
  })

  onMount(() => {
    const interval = setInterval(() => {
      if (current().status === "running") void refetch()
    }, 1000)
    onCleanup(() => clearInterval(interval))
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

  function selectedPhase() {
    return phases()[store.selectedPhase] ?? phases()[0]
  }

  function selectedPhaseStatus() {
    const phase = selectedPhase()
    if (!phase) return "pending" as const
    return phaseStatus(current(), phases(), phase)
  }

  function selectedPhaseLogs() {
    const phase = selectedPhase()
    if (!phase) return current().logs
    return current().logs.filter((item) => item.phase === phase)
  }

  function selectedPhaseAgents() {
    const phase = selectedPhase()
    if (!phase) return current().agents
    return current().agents.filter((agent) => agent.phase === phase)
  }

  function openTelemetry() {
    setStore("view", "telemetry")
  }

  function closeTelemetry() {
    setStore("view", "overview")
  }

  function openAgentSession() {
    const sessionID = selectedPhaseAgents().find((agent) => agent.session_id)?.session_id ?? current().agents.find((agent) => agent.session_id)?.session_id
    if (!sessionID) return
    route.navigate({
      type: "session",
      sessionID,
      workflowRunID: current().id,
      workflowReturnSessionID: route.data.type === "session" ? route.data.sessionID : undefined,
    })
    dialog.clear()
  }

  function movePhase(direction: number) {
    if (phases().length === 0) return
    const next = Math.max(0, Math.min(phases().length - 1, store.selectedPhase + direction))
    setStore("selectedPhase", next)
  }

  useBindings(() => ({
    bindings:
      store.view === "overview"
        ? [
            { key: "b", desc: "Back to workflow dashboard", group: "Workflow", cmd: back },
            { key: "escape", desc: "Back to workflow dashboard", group: "Workflow", cmd: back },
            { key: "return", desc: "Open phase telemetry", group: "Workflow", cmd: openTelemetry },
            { key: "x", desc: "Kill workflow run", group: "Workflow", cmd: cancel },
            { key: "up,k", desc: "Previous phase", group: "Workflow", cmd: () => movePhase(-1) },
            { key: "down,j", desc: "Next phase", group: "Workflow", cmd: () => movePhase(1) },
            {
              key: "pageup,ctrl+b",
              desc: "Page workflow details up",
              group: "Workflow",
              cmd: () => scroll?.scrollBy(-(scroll?.height ?? 10)),
            },
            {
              key: "pagedown,ctrl+f",
              desc: "Page workflow details down",
              group: "Workflow",
              cmd: () => scroll?.scrollBy(scroll?.height ?? 10),
            },
          ]
        : [
            { key: "b", desc: "Back to phase overview", group: "Workflow", cmd: closeTelemetry },
            { key: "escape", desc: "Back to phase overview", group: "Workflow", cmd: closeTelemetry },
            { key: "o", desc: "Open selected subagent", group: "Workflow", cmd: openAgentSession },
            { key: "x", desc: "Kill workflow run", group: "Workflow", cmd: cancel },
            { key: "up,k", desc: "Scroll telemetry up", group: "Workflow", cmd: () => scroll?.scrollBy(-1) },
            { key: "down,j", desc: "Scroll telemetry down", group: "Workflow", cmd: () => scroll?.scrollBy(1) },
            {
              key: "pageup,ctrl+b",
              desc: "Page telemetry up",
              group: "Workflow",
              cmd: () => scroll?.scrollBy(-(scroll?.height ?? 10)),
            },
            {
              key: "pagedown,ctrl+f",
              desc: "Page telemetry down",
              group: "Workflow",
              cmd: () => scroll?.scrollBy(scroll?.height ?? 10),
            },
          ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height - 1} paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Workflow {current().id.replace(/^job_/, "#")}: {workflow()?.meta.name ?? current().workflow}
        </text>
        <text fg={theme.textMuted} onMouseUp={back}>
          esc/b
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={theme.text}>
          Status: {statusIcon(current().status)} {current().status.toUpperCase()}
        </text>
        <text fg={theme.textMuted}>Elapsed: {formatDuration(current())}</text>
        <text fg={theme.textMuted}>Tokens: {formatTokens(usage().tokens.total)}</text>
        <text fg={theme.textMuted}>Cost: {formatCost(usage().cost)}</text>
      </box>

      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        flexGrow={1}
        minHeight={0}
        verticalScrollbarOptions={{ visible: true }}
        horizontalScrollbarOptions={{ visible: false }}
        scrollAcceleration={getScrollAcceleration()}
      >
        <Show
          when={store.view === "overview"}
          fallback={
            <box>
              <box paddingTop={1}>
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                  LIVE CONTEXT STREAM LOGS{selectedPhase() ? ` (${selectedPhase()} · ${selectedPhaseStatus()})` : ""}:
                </text>
              </box>
              <WorkflowLogs logs={selectedPhaseLogs()} />

              <box paddingTop={1}>
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                  SUB-AGENT INSTANCE TELEMETRY:
                </text>
              </box>
              <box paddingLeft={1}>
                <text fg={theme.textMuted}>Selected phase: {selectedPhase()}</text>
              </box>
              <Show
                when={selectedPhaseAgents().length}
                fallback={
                  <box paddingLeft={1}>
                    <text fg={theme.textMuted}>No agent nodes recorded for this phase.</text>
                  </box>
                }
              >
                <For each={selectedPhaseAgents()}>
                  {(agent) => (
                    <box paddingLeft={1} paddingTop={1}>
                      <text fg={theme.text}>
                        ┌─ Agent Node #{agent.id} (Model: {agent.model ?? "default"})
                      </text>
                      <text fg={theme.textMuted}>│ Phase : {agent.phase ?? selectedPhase()}</text>
                      <Show when={agent.session_id}>
                        <text fg={theme.textMuted}>│ Session: {agent.session_id}</text>
                      </Show>
                      <text fg={agent.status === "failed" ? theme.error : theme.textMuted}>
                        │ Status: {agentIcon(agent.status)} {agent.status}
                      </text>
                      <text fg={theme.textMuted} overflow="hidden" wrapMode="none">
                        │ Input : {agent.prompt.split("\n")[0]}
                      </text>
                      <text fg={theme.textMuted}>
                        │ Metric: {formatElapsed(agent.started_at, agent.completed_at)} elapsed ·{" "}
                        {formatTokens(agent.tokens?.total ?? 0)} tokens · {formatCost(agent.cost ?? 0)}
                      </text>
                      <Show when={agent.error}>
                        <text fg={theme.error}>│ Error : {agent.error}</text>
                      </Show>
                      <Show when={agent.output}>
                        <text fg={theme.textMuted} wrapMode="word">
                          │ Output: {agent.output}
                        </text>
                      </Show>
                      <text fg={theme.text}>
                        └────────────────────────────────────────────────────────────────────────────
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          }
        >
          <box>
            <box paddingTop={1}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                PHASES PROGRESSION MATRIX:
              </text>
            </box>
            <For each={phases()}>
              {(phase, index) => {
                const status = createMemo(() => phaseStatus(current(), phases(), phase))
                const logs = createMemo(() => current().logs.filter((item) => item.phase === phase))
                const active = createMemo(() => index() === store.selectedPhase)
                return (
                  <box paddingLeft={1}>
                    <text fg={active() ? theme.primary : status() === "failed" ? theme.error : theme.textMuted}>
                      {active() ? "❯ " : "  "}
                      {phaseIcon(status())} {index() + 1}. {phase} [{status()}. Logs: {logs().length}]
                    </text>
                  </box>
                )
              }}
            </For>

            <box paddingTop={1}>
              <text fg={theme.textMuted}>Press [Enter] to open phase telemetry.</text>
            </box>

            <Show when={current().result !== undefined}>
              <box paddingTop={1}>
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                  RESULT:
                </text>
              </box>
              <box paddingLeft={1}>
                <text fg={theme.text} wrapMode="word">
                  {formatResult(current().result)}
                </text>
              </box>
            </Show>
          </box>
        </Show>

        <Show when={current().error}>
          <box paddingTop={1}>
            <text fg={theme.error} attributes={TextAttributes.BOLD}>
              ERROR:
            </text>
          </box>
          <box paddingLeft={1}>
            <text fg={theme.error}>{current().error}</text>
          </box>
        </Show>
      </scrollbox>

      <text fg={theme.textMuted}>{"─".repeat(Math.max(40, dimensions().width - 5))}</text>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>
          {store.view === "overview"
            ? "[↑/↓] Select phase | [Enter] Open telemetry | [X] Kill workflow run | [Esc/B] Back"
            : "[↑/↓] Scroll telemetry | [O] Open selected subagent | [X] Kill workflow run | [Esc/B] Back to overview"}
        </text>
        <Show when={current().status === "running"}>
          <text fg={theme.primary}>live</text>
        </Show>
      </box>
      <box height={0.5} />
    </box>
  )
}

function WorkflowLogs(props: { logs: WorkflowRun["logs"] }) {
  const { theme } = useTheme()
  return (
    <Show
      when={props.logs.length}
      fallback={
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>No workflow logs emitted yet.</text>
        </box>
      }
    >
      <For each={props.logs}>
        {(log) => (
          <box paddingLeft={1}>
            <text fg={theme.textMuted} overflow="hidden" wrapMode="none">
              [{formatTime(log.time)}] {log.phase ? `[${log.phase}]` : "SYS"}: {log.message}
            </text>
          </box>
        )}
      </For>
    </Show>
  )
}
