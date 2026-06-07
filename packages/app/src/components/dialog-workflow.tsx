import { Component, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { WorkflowInfo, WorkflowRun } from "@opencode-ai/sdk/v2"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import {
  capLogs,
  formatPhase,
  formatShortElapsed,
  normalizePhases,
  phaseIcon,
  phaseStatus,
  questionBadge,
  reanchorSelection,
  statusIcon,
} from "./dialog-workflow-helpers"
import { saveWorkflowRun, type SaveScope } from "./dialog-workflow-client"
import { sanitizeWorkflowFilename } from "./prompt-input/workflow-command"
import { openWorkflowQuestion } from "./dialog-workflow-question"

const LOG_CAP = 100

const STATUS_LABEL_KEY = {
  running: "dialog.workflow.status.running",
  completed: "dialog.workflow.status.completed",
  failed: "dialog.workflow.status.failed",
  cancelled: "dialog.workflow.status.cancelled",
  interrupted: "dialog.workflow.status.interrupted",
  paused: "dialog.workflow.status.paused",
} as const

// Localized label for a derived phase status. The six lifecycle statuses have
// i18n keys; `pending`/`skipped` are view-only derivations with no key, so they
// fall back to the raw token.
function phaseStatusLabel(status: ReturnType<typeof phaseStatus>, language: ReturnType<typeof useLanguage>): string {
  if (status in STATUS_LABEL_KEY) return language.t(STATUS_LABEL_KEY[status as keyof typeof STATUS_LABEL_KEY])
  return status
}

// Live workflow dashboard: a master list of runs (left) + the selected run's
// phases / agents / result / usage / logs (right), with pause/resume/cancel and
// the answer entry point. Mirrors the TUI dialog-workflow.tsx but lean for v1:
// refetch the whole run list on every workflow.run.* event PLUS a 1s poll
// fallback (the lean events carry no agent detail; the refetch fills it in).
export const DialogWorkflow: Component = () => {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()

  const [workflows] = createResource(() =>
    sdk.client.workflow
      .list({ directory: sdk.directory })
      .then((response) => response.data ?? [])
      .catch(() => [] as WorkflowInfo[]),
  )

  const [runs, { refetch }] = createResource(
    () =>
      sdk.client.workflow
        .runs({ directory: sdk.directory })
        .then((response) => response.data ?? [])
        .catch(() => [] as WorkflowRun[]),
    { initialValue: [] as WorkflowRun[] },
  )

  // Instant refresh on lifecycle events + a 1s poll fallback (mirror TUI :425-437).
  const offUpdated = sdk.event.on("workflow.run.updated", () => void refetch())
  const offFinished = sdk.event.on("workflow.run.finished", () => void refetch())
  const poll = setInterval(() => void refetch(), 1000)
  onCleanup(() => {
    offUpdated()
    offFinished()
    clearInterval(poll)
  })

  const rows = createMemo<WorkflowRun[]>(() => runs() ?? [])
  const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined)

  // Keep the selection stable across the re-sorting refetch; default to the first
  // run when nothing is selected yet.
  const selected = createMemo<WorkflowRun | undefined>(() => {
    const list = rows()
    if (list.length === 0) return undefined
    const index = reanchorSelection(selectedId(), list)
    return list[index]
  })

  const workflowFor = (run: WorkflowRun | undefined) =>
    run ? workflows()?.find((workflow) => workflow.name === run.workflow) : undefined

  const phasesFor = (run: WorkflowRun | undefined) => normalizePhases(workflowFor(run))

  const totalCost = (run: WorkflowRun) => run.agents.reduce((sum, agent) => sum + (agent.cost ?? 0), 0)

  const refresh = () => void refetch()

  const pause = async (run: WorkflowRun) => {
    try {
      await sdk.client.workflow.pause({ id: run.id, directory: sdk.directory })
      refresh()
    } catch {
      showToast({ variant: "error", title: language.t("toast.workflow.pause.failed.title") })
    }
  }

  const cancel = async (run: WorkflowRun) => {
    try {
      await sdk.client.workflow.cancel({ id: run.id, directory: sdk.directory })
      refresh()
    } catch {
      showToast({ variant: "error", title: language.t("toast.workflow.cancel.failed.title") })
    }
  }

  const resume = async (run: WorkflowRun) => {
    try {
      await sdk.client.workflow.start({
        name: run.workflow,
        directory: sdk.directory,
        workflowStartPayload: { resume_of: run.id },
      })
      refresh()
    } catch {
      showToast({ variant: "error", title: language.t("toast.workflow.resume.failed.title") })
    }
  }

  const answer = (run: WorkflowRun) => {
    setSelectedId(run.id)
    openWorkflowQuestion(dialog, run, refresh)
  }

  return (
    <Dialog
      size="x-large"
      title={language.t("dialog.workflow.title")}
      description={language.t("dialog.workflow.description", { count: rows().length })}
    >
      <Show
        when={rows().length > 0}
        fallback={<div class="px-3 py-6 text-text-weak text-14-regular">{language.t("dialog.workflow.empty")}</div>}
      >
        <div class="flex gap-3 min-h-0 h-[60vh]">
          {/* Run list */}
          <div class="w-72 shrink-0 overflow-auto no-scrollbar flex flex-col gap-0.5 border-r border-border-base pr-2">
            <For each={rows()}>
              {(run) => {
                const isSelected = () => selected()?.id === run.id
                return (
                  <button
                    class="w-full flex items-center gap-2 rounded-md px-2 py-1 text-left"
                    classList={{ "bg-surface-raised-base-hover": isSelected() }}
                    onClick={() => setSelectedId(run.id)}
                  >
                    <span class="shrink-0 text-text-strong">{statusIcon(run.status)}</span>
                    <div class="flex flex-col min-w-0">
                      <span class="text-14-regular text-text-strong truncate">{run.workflow}</span>
                      <span class="text-11-regular text-text-weak truncate">{formatPhase(run, workflowFor(run))}</span>
                    </div>
                    <div class="ml-auto flex items-center gap-1 shrink-0">
                      <Show when={questionBadge(run)}>
                        <span class="text-11-regular">{questionBadge(run)}</span>
                      </Show>
                      <span class="text-11-regular text-text-subtle">
                        {formatShortElapsed(run.started_at, run.completed_at)}
                      </span>
                    </div>
                  </button>
                )
              }}
            </For>
          </div>

          {/* Detail */}
          <div class="flex-1 min-w-0 overflow-auto no-scrollbar">
            <Show
              when={selected()}
              fallback={
                <div class="text-text-weak text-14-regular px-1">{language.t("dialog.workflow.detail.empty")}</div>
              }
            >
              {(run) => <WorkflowDetail run={run()} phases={phasesFor(run())} cost={totalCost(run())} />}
            </Show>
          </div>
        </div>

        {/* Actions for the selected run */}
        <Show when={selected()}>
          {(run) => (
            <div class="flex items-center justify-end gap-2 pt-3 mt-3 border-t border-border-base px-1">
              <Show when={run().pending_question}>
                <Button variant="primary" onClick={() => answer(run())}>
                  {language.t("dialog.workflow.action.answer")}
                </Button>
              </Show>
              <Show when={run().status === "running"}>
                <Button variant="secondary" onClick={() => void pause(run())}>
                  {language.t("dialog.workflow.action.pause")}
                </Button>
                <Button variant="secondary" onClick={() => void cancel(run())}>
                  {language.t("dialog.workflow.action.cancel")}
                </Button>
              </Show>
              <Show when={run().status === "paused" || run().status === "interrupted"}>
                <Button variant="secondary" onClick={() => void resume(run())}>
                  {language.t("dialog.workflow.action.resume")}
                </Button>
              </Show>
              {/* Save-as-command: writes the run's captured source as a workflow
                  file via POST /workflow/save. Disabled when the run carries no
                  source (older/temporary runs), matching the TUI's hard guard. */}
              <Button
                variant="secondary"
                disabled={!run().definition?.source}
                title={
                  run().definition?.source
                    ? language.t("dialog.workflow.action.save")
                    : language.t("dialog.workflow.save.noSource")
                }
                onClick={() => openWorkflowSave(dialog, run())}
              >
                {language.t("dialog.workflow.action.save")}
              </Button>
            </div>
          )}
        </Show>
      </Show>
    </Dialog>
  )
}

const WorkflowDetail: Component<{ run: WorkflowRun; phases: string[]; cost: number }> = (props) => {
  const language = useLanguage()
  const logs = createMemo(() => capLogs(props.run.logs ?? [], LOG_CAP))
  const resultText = createMemo(() => {
    const result = props.run.result
    if (result === undefined || result === null) return undefined
    return typeof result === "string" ? result : JSON.stringify(result, null, 2)
  })

  return (
    <div class="flex flex-col gap-4 px-1">
      {/* Phases */}
      <Show when={props.phases.length > 0}>
        <section class="flex flex-col gap-1">
          <h3 class="text-12-medium text-text-weak uppercase tracking-wide">
            {language.t("dialog.workflow.section.phases")}
          </h3>
          <For each={props.phases}>
            {(phase) => {
              const status = () => phaseStatus(props.run, props.phases, phase)
              return (
                <div class="flex items-center gap-2 text-14-regular">
                  <span class="shrink-0 text-text-strong">{phaseIcon(status())}</span>
                  <span class="text-text-strong truncate">{phase}</span>
                  <span class="ml-auto text-11-regular text-text-subtle">{phaseStatusLabel(status(), language)}</span>
                </div>
              )
            }}
          </For>
        </section>
      </Show>

      {/* Agents */}
      <section class="flex flex-col gap-1">
        <h3 class="text-12-medium text-text-weak uppercase tracking-wide">
          {language.t("dialog.workflow.section.agents")}
        </h3>
        <Show
          when={props.run.agents.length > 0}
          fallback={<span class="text-12-regular text-text-weak">{language.t("dialog.workflow.detail.noAgents")}</span>}
        >
          <For each={props.run.agents}>
            {(agent) => (
              <div class="flex items-center gap-2 text-14-regular">
                <span class="shrink-0 text-text-strong">{statusIcon(agent.status)}</span>
                <span class="text-text-strong truncate">{agent.agent ?? agent.id}</span>
                <Show when={agent.model}>
                  <span class="text-11-regular text-text-subtle truncate">{agent.model}</span>
                </Show>
                <div class="ml-auto flex items-center gap-3 shrink-0 text-11-regular text-text-subtle">
                  <Show when={agent.tokens?.total}>
                    <span>{agent.tokens?.total} tok</span>
                  </Show>
                  <Show when={agent.cost !== undefined}>
                    <span>${(agent.cost ?? 0).toFixed(4)}</span>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </Show>
      </section>

      {/* Result */}
      <section class="flex flex-col gap-1">
        <h3 class="text-12-medium text-text-weak uppercase tracking-wide">
          {language.t("dialog.workflow.section.result")}
        </h3>
        <Show
          when={resultText()}
          fallback={<span class="text-12-regular text-text-weak">{language.t("dialog.workflow.detail.noResult")}</span>}
        >
          <pre class="text-12-regular text-text-strong whitespace-pre-wrap break-words bg-surface-base rounded p-2">
            {resultText()}
          </pre>
        </Show>
        <Show when={props.run.error}>
          <span class="text-12-regular text-text-danger break-words">{props.run.error}</span>
        </Show>
      </section>

      {/* Usage */}
      <section class="flex flex-col gap-1">
        <h3 class="text-12-medium text-text-weak uppercase tracking-wide">
          {language.t("dialog.workflow.section.usage")}
        </h3>
        <span class="text-14-regular text-text-strong">
          {language.t("dialog.workflow.usage.total", { cost: props.cost.toFixed(4) })}
        </span>
      </section>

      {/* Logs */}
      <Show when={logs().entries.length > 0}>
        <section class="flex flex-col gap-1">
          <h3 class="text-12-medium text-text-weak uppercase tracking-wide">
            {language.t("dialog.workflow.section.logs")}
          </h3>
          <Show when={logs().hidden > 0}>
            <span class="text-11-regular text-text-subtle">
              {language.t("dialog.workflow.logs.earlier", { count: logs().hidden })}
            </span>
          </Show>
          <div class="flex flex-col gap-0.5 bg-surface-base rounded p-2">
            <For each={logs().entries}>
              {(entry) => <span class="text-11-regular text-text-weak break-words">{entry.message}</span>}
            </For>
          </div>
        </section>
      </Show>
    </div>
  )
}

// Save-a-run-as-command dialog (web parity with the TUI DialogWorkflowSave): a
// name field prefilled with the run's workflow name + a project/global
// destination toggle. The name is sanitized to a single safe path segment before
// the POST; the server is the source of truth for collisions (409) and meta
// validity (400), so this never pre-checks the filesystem. A run with no captured
// source can never reach here (the dashboard button is disabled), but the source
// is re-guarded defensively.
const DialogWorkflowSave: Component<{ run: WorkflowRun }> = (props) => {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()

  const [name, setName] = createSignal(props.run.workflow)
  const [scope, setScope] = createSignal<SaveScope>("project")
  const [pending, setPending] = createSignal(false)

  const submit = async () => {
    if (pending()) return
    const source = props.run.definition?.source
    if (!source) {
      showToast({ variant: "error", title: language.t("dialog.workflow.save.noSource") })
      return
    }
    const safe = sanitizeWorkflowFilename(name())
    if (!safe) {
      showToast({ variant: "error", title: language.t("toast.workflow.save.invalidName.title") })
      return
    }
    setPending(true)
    const result = await saveWorkflowRun(sdk, { name: safe, source, scope: scope() })
    setPending(false)
    if (result.type === "ok") {
      showToast({
        variant: "success",
        title: language.t("toast.workflow.save.ok.title"),
        description: language.t("toast.workflow.save.ok.description", { name: safe }),
      })
      dialog.close()
      return
    }
    if (result.type === "conflict") {
      showToast({
        variant: "error",
        title: language.t("toast.workflow.save.conflict.title"),
        description: language.t("toast.workflow.save.conflict.description", { name: safe }),
      })
      return
    }
    if (result.type === "invalid") {
      showToast({
        variant: "error",
        title: language.t("toast.workflow.save.invalidName.title"),
        description: result.message,
      })
      return
    }
    showToast({ variant: "error", title: language.t("toast.workflow.save.failed.title"), description: result.message })
  }

  return (
    <Dialog
      title={language.t("dialog.workflow.save.title")}
      description={language.t("dialog.workflow.save.description")}
    >
      <div class="flex flex-col gap-3 px-1">
        <TextField
          autofocus
          placeholder={language.t("dialog.workflow.save.placeholder")}
          value={name()}
          onChange={setName}
        />
        <div class="flex items-center gap-2">
          <Button variant={scope() === "project" ? "primary" : "secondary"} onClick={() => setScope("project")}>
            {language.t("dialog.workflow.save.scope.project")}
          </Button>
          <Button variant={scope() === "global" ? "primary" : "secondary"} onClick={() => setScope("global")}>
            {language.t("dialog.workflow.save.scope.global")}
          </Button>
        </div>
        <div class="flex items-center justify-end">
          <Button variant="primary" disabled={pending()} onClick={() => void submit()}>
            {language.t("dialog.workflow.action.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

// Opens the save dialog for a run. Replaces the dashboard on the stack; on a
// successful save the dialog closes itself (dialog.close), landing back on the app.
export function openWorkflowSave(dialog: ReturnType<typeof useDialog>, run: WorkflowRun) {
  dialog.show(() => DialogWorkflowSave({ run }))
}
