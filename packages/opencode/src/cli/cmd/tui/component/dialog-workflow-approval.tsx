import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { WorkflowInfo } from "@opencode-ai/sdk/v2"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { getScrollAcceleration } from "../util/scroll"
import { useBindings } from "../keymap"

// The user's reply to the interactive start approval dialog. `once` starts this
// run only; `always` persists consent (the caller appends the name to
// `workflows.approved`); `cancel` aborts the start.
export type WorkflowApprovalResult = "once" | "always" | "cancel"

type Option = {
  id: WorkflowApprovalResult | "source"
  label: string
}

// Order matters: it is both the visual order and the up/down navigation order.
const OPTIONS: Option[] = [
  { id: "once", label: "Yes" },
  { id: "always", label: "Yes, always" },
  { id: "source", label: "View script" },
  { id: "cancel", label: "No" },
]

function formatArgs(args: Record<string, unknown>) {
  const entries = Object.entries(args)
  if (entries.length === 0) return "(none)"
  return entries.map(([name, value]) => `${name}=${String(value)}`).join("  ")
}

export function DialogWorkflowApproval(props: {
  info: WorkflowInfo
  args: Record<string, unknown>
  onDecide: (result: WorkflowApprovalResult) => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [active, setActive] = createSignal(0)

  const phases = createMemo(() => props.info.meta.phases ?? [])
  const description = createMemo(() => props.info.meta.description)

  function move(delta: number) {
    setActive((prev) => (prev + delta + OPTIONS.length) % OPTIONS.length)
  }

  function choose(option: Option) {
    if (option.id === "source") {
      openSource()
      return
    }
    props.onDecide(option.id)
    dialog.clear()
  }

  // The read-only script pager is pushed on top of this dialog; Esc inside it
  // pops back to this dialog (the prompt's onClose is preserved because we use
  // notifyClose:false on the way out and re-open this exact dialog).
  function openSource() {
    dialog.replace(() => (
      <DialogWorkflowSource
        info={props.info}
        onBack={() =>
          dialog.replace(
            () => <DialogWorkflowApproval info={props.info} args={props.args} onDecide={props.onDecide} />,
            () => props.onDecide("cancel"),
            { notifyClose: false },
          )
        }
      />
    ))
  }

  useBindings(() => ({
    bindings: [
      { key: "up,k", desc: "Previous option", group: "Workflow approval", cmd: () => move(-1) },
      { key: "down,j", desc: "Next option", group: "Workflow approval", cmd: () => move(1) },
      {
        key: "return",
        desc: "Choose option",
        group: "Workflow approval",
        cmd: () => choose(OPTIONS[active()]),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Start workflow: {props.info.name}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => choose({ id: "cancel", label: "No" })}>
          esc
        </text>
      </box>

      <Show when={description()}>
        <text fg={theme.textMuted}>{description()}</text>
      </Show>

      <box flexDirection="column">
        <text fg={theme.text}>Phases:</text>
        <Show when={phases().length} fallback={<text fg={theme.textMuted}>  (none declared)</text>}>
          <For each={phases()}>{(phase, index) => <text fg={theme.textMuted}>{`  ${index() + 1}. ${phase}`}</text>}</For>
        </Show>
      </box>

      <box flexDirection="column">
        <text fg={theme.text}>Arguments:</text>
        <text fg={theme.textMuted}>{`  ${formatArgs(props.args)}`}</text>
      </box>

      <box flexDirection="column" paddingBottom={1}>
        <For each={OPTIONS}>
          {(option, index) => {
            const isActive = createMemo(() => index() === active())
            return (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isActive() ? theme.primary : undefined}
                onMouseDown={() => setActive(index())}
                onMouseUp={() => choose(option)}
              >
                <text fg={isActive() ? selectedForeground(theme) : theme.textMuted}>
                  {`${isActive() ? "›" : " "} ${option.label}`}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </box>
  )
}

// Read-only pager for a workflow's source. The source is fetched lazily through
// the existing SDK file-read endpoint (Info.path) — no workflow engine change and
// it works against a remote server too.
function DialogWorkflowSource(props: { info: WorkflowInfo; onBack: () => void }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined

  const [source] = createResource(async () => {
    const result = await sdk.client.file.read({ path: props.info.path })
    if (result.error || !result.data) return undefined
    return result.data.content
  })

  useBindings(() => ({
    bindings: [
      { key: "escape", desc: "Back to approval", group: "Workflow source", cmd: () => props.onBack() },
      { key: "b", desc: "Back to approval", group: "Workflow source", cmd: () => props.onBack() },
      { key: "up,k", desc: "Scroll up", group: "Workflow source", cmd: () => scroll?.scrollBy(-1) },
      { key: "down,j", desc: "Scroll down", group: "Workflow source", cmd: () => scroll?.scrollBy(1) },
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
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.info.name} — {props.info.path}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onBack()}>
          esc
        </text>
      </box>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        flexGrow={1}
        minHeight={0}
        verticalScrollbarOptions={{ visible: true }}
        horizontalScrollbarOptions={{ visible: false }}
        scrollAcceleration={getScrollAcceleration()}
      >
        <text fg={theme.textMuted} wrapMode="none">
          {source.loading ? "Loading…" : (source() ?? "No source recorded.")}
        </text>
      </scrollbox>
      <text fg={theme.textMuted}>[Esc]/[B] Back to approval</text>
    </box>
  )
}

// Opens the approval dialog and resolves with the user's decision. Esc / dialog
// dismissal resolves "cancel" so the start is always abort-safe.
DialogWorkflowApproval.show = (
  dialog: DialogContext,
  input: { info: WorkflowInfo; args: Record<string, unknown> },
) => {
  return new Promise<WorkflowApprovalResult>((resolve) => {
    let settled = false
    const decide = (result: WorkflowApprovalResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    dialog.replace(
      () => <DialogWorkflowApproval info={input.info} args={input.args} onDecide={decide} />,
      () => decide("cancel"),
    )
  })
}
