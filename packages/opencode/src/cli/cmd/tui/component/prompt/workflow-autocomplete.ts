import type { TextareaRenderable } from "@opentui/core"
import type { WorkflowInfo } from "@opencode-ai/sdk/v2"
import type { AutocompleteOption } from "./autocomplete"

type WorkflowClient = {
  list: () => Promise<{ data?: WorkflowInfo[]; error?: unknown }>
}

export type WorkflowArgContext = {
  workflow: string
  query: string
  used: Set<string>
}

export const WORKFLOW_COMMAND_PREFIX = "/workflow "
const WORKFLOW_COMMAND_PATTERN = /^\/(?:workflow|worfklow)\s+(\S*)$/
const WORKFLOW_ARG_PATTERN = /^\/(?:workflow|worfklow)\s+(\S+)(?:\s+(.*))?$/
const WORKFLOW_COMMAND_ALIASES = ["/workflow ", "/worfklow "]

export function workflowNameQuery(input: string, cursorOffset: number) {
  return input.slice(0, cursorOffset).match(WORKFLOW_COMMAND_PATTERN)?.[1]
}

export function isWorkflowNameInput(input: string, cursorOffset: number) {
  return workflowNameQuery(input, cursorOffset) !== undefined
}

export function isWorkflowCommandInput(input: string) {
  return WORKFLOW_COMMAND_ALIASES.some((prefix) => input.startsWith(prefix))
}

function workflowAutocompleteIndex(ctx: { query: string }, cursorOffset: number) {
  return cursorOffset - ctx.query.length - 1
}

export function workflowAutocompleteTriggerIndex(input: string, cursorOffset: number) {
  if (isWorkflowNameInput(input, cursorOffset)) return WORKFLOW_COMMAND_PREFIX.length - 1
  const arg = workflowArgContext(input, cursorOffset)
  if (arg) return workflowAutocompleteIndex(arg, cursorOffset)
}

export function workflowArgContext(input: string, cursorOffset: number): WorkflowArgContext | undefined {
  const beforeCursor = input.slice(0, cursorOffset)
  const match = beforeCursor.match(WORKFLOW_ARG_PATTERN)
  if (!match || match[2] === undefined) return

  const tokens = match[2].split(/\s+/).filter(Boolean)
  const current = beforeCursor.endsWith(" ") ? "" : (tokens.at(-1) ?? "")
  if (!current || current.includes("=")) return

  return {
    workflow: match[1],
    query: current,
    used: new Set(
      tokens
        .slice(0, beforeCursor.endsWith(" ") ? tokens.length : -1)
        .map((token) => token.match(/^--?([^=]+)=/)?.[1] ?? token.match(/^([^=]+)=/)?.[1])
        .filter((name): name is string => Boolean(name)),
    ),
  }
}

export function workflowNameOptions(input: TextareaRenderable, workflows: WorkflowInfo[]): AutocompleteOption[] {
  return workflows.map((workflow): AutocompleteOption => ({
    display: workflow.name,
    value: workflow.name,
    description: workflow.meta.description ?? workflow.meta.name,
    onSelect: () => {
      const cursorOffset = input.cursorOffset
      input.cursorOffset = WORKFLOW_COMMAND_PREFIX.length
      const start = input.logicalCursor
      input.cursorOffset = cursorOffset
      const end = input.logicalCursor
      input.deleteRange(start.row, start.col, end.row, end.col)
      input.insertText(`${workflow.name} `)
      input.cursorOffset = Bun.stringWidth(`${WORKFLOW_COMMAND_PREFIX}${workflow.name} `)
    },
  }))
}

export function workflowCommandOption(input: TextareaRenderable): AutocompleteOption {
  return {
    display: "/workflow",
    description: "Start a workflow by name",
    aliases: ["/worfklow"],
    onSelect: () => {
      const cursor = input.logicalCursor
      input.deleteRange(0, 0, cursor.row, cursor.col)
      input.insertText(WORKFLOW_COMMAND_PREFIX)
      input.cursorOffset = Bun.stringWidth(WORKFLOW_COMMAND_PREFIX)
    },
  }
}

export function workflowArgOptions(
  input: TextareaRenderable,
  ctx: WorkflowArgContext,
  workflow: WorkflowInfo | undefined,
): AutocompleteOption[] {
  return Object.entries(workflow?.meta.arguments ?? {})
    .filter(([name]) => !ctx.used.has(name))
    .map(
      ([name, argument]): AutocompleteOption => ({
        display: `${name}=`,
        value: name,
        description: [
          argument.type,
          argument.default === undefined ? undefined : `default: ${String(argument.default)}`,
          argument.description,
        ]
          .filter(Boolean)
          .join(" · "),
        onSelect: () => {
          const text = argument.type === "string" ? `${name}=""` : `${name}=`
          const startOffset = input.cursorOffset - ctx.query.length
          const cursorOffset = input.cursorOffset
          input.cursorOffset = startOffset
          const start = input.logicalCursor
          input.cursorOffset = cursorOffset
          const end = input.logicalCursor
          input.deleteRange(start.row, start.col, end.row, end.col)
          input.insertText(text)
          input.cursorOffset = startOffset + Bun.stringWidth(text) - (argument.type === "string" ? 1 : 0)
        },
      }),
    )
}

export function workflowOptions(input: TextareaRenderable, workflows: WorkflowInfo[], inputState: {
  arg: WorkflowArgContext | undefined
  name: string | undefined
}) {
  if (inputState.arg) {
    return workflowArgOptions(
      input,
      inputState.arg,
      workflows.find((item) => item.name === inputState.arg?.workflow),
    )
  }
  if (inputState.name !== undefined) return workflowNameOptions(input, workflows)
}

export async function listWorkflowInfos(workflow: WorkflowClient, enabled: boolean) {
  if (!enabled) return []
  const result = await workflow.list()
  if (result.error || !result.data) return []
  return result.data
}

export function parseWorkflowArgs(input: string) {
  return Object.fromEntries(
    // Matches: [--]key[="quoted value" | 'quoted value' | unquoted_value]
    Array.from(input.matchAll(/(?:^|\s)(?:--)?([^=\s]+)(?:=("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S*))?/g)).map(
      (match) => {
        const raw = match[2] ?? "true"
        const value =
          (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
            ? raw.slice(1, -1).replace(/\\(["'\\])/g, "$1")
            : raw
        const numeric = Number(value)
        return [match[1], Number.isFinite(numeric) && value.trim() !== "" ? numeric : value]
      },
    ),
  )
}
