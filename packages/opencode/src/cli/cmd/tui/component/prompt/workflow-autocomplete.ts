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
const WORKFLOW_COMMAND_PATTERN = /^\/workflow\s+(\S*)$/
const WORKFLOW_ARG_PATTERN = /^\/workflow\s+(\S+)(?:\s+(.*))?$/
const WORKFLOW_COMMAND_ALIASES = ["/workflow "]

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

// Quote-aware, single-pass tokenizer. Splits on unquoted whitespace but keeps a
// quoted segment (`"a b"` / `'a b'`) attached to its token, so `msg="a b"` is one
// token rather than two. Linear in the input length — no backtracking — so it is
// immune to the catastrophic backtracking that the previous monolithic regex was
// prone to on pathological input (N14). `incomplete` flags a token whose closing
// quote the user has not typed yet (relevant only mid-edit); note this is a
// deliberate behavior change from the old regex — an unbalanced-quote token like
// `b="x y` is now kept whole (the open quote suppresses the whitespace split)
// instead of being split at the space into `b="x` and `y`.
function tokenizeWorkflowArgs(input: string) {
  const tokens: { text: string; incomplete: boolean }[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let escaped = false
  let incomplete = false
  const flush = () => {
    if (current === "" && !incomplete) return
    tokens.push({ text: current, incomplete })
    current = ""
    incomplete = false
  }
  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\" && quote) {
      current += char
      escaped = true
      continue
    }
    if (quote) {
      current += char
      if (char === quote) quote = undefined
      else incomplete = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      incomplete = true
      current += char
      continue
    }
    if (/\s/.test(char)) {
      flush()
      continue
    }
    current += char
  }
  flush()
  return tokens
}

// Extracts the declared arg name from a token, supporting `name=`, `--name=`, and
// bare `--flag` / `flag` forms. Returns undefined for a token that has no name yet.
function workflowArgName(token: string) {
  return token.match(/^-{0,2}([^=\s]+)=/)?.[1] ?? token.match(/^-{0,2}([^=\s]+)$/)?.[1]
}

export function workflowArgContext(input: string, cursorOffset: number): WorkflowArgContext | undefined {
  const beforeCursor = input.slice(0, cursorOffset)
  const match = beforeCursor.match(WORKFLOW_ARG_PATTERN)
  if (!match || match[2] === undefined) return

  const trailingSpace = /\s$/.test(beforeCursor)
  const tokens = tokenizeWorkflowArgs(match[2])
  // On a trailing space the user is about to start a fresh arg, so the query is
  // empty and every typed token counts as used. Otherwise the last token is the
  // one being edited (the query) and the rest are used.
  const current = trailingSpace ? "" : (tokens.at(-1)?.text ?? "")
  // A token that already contains `=` is a value being typed, not an arg name, so
  // there is nothing to complete.
  if (current.includes("=")) return

  return {
    workflow: match[1],
    query: current,
    used: new Set(
      tokens
        .slice(0, trailingSpace ? tokens.length : -1)
        .map((token) => workflowArgName(token.text))
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

// Direct `/<name>` slash commands for every DISCOVERED workflow (Claude-Code
// parity): a workflow named `review` surfaces in the `/` menu as `/review`,
// routed exactly like `/workflow review` via the existing dispatch. Pure +
// filtering-only so it is unit-testable; the caller attaches the `onSelect` that
// inserts the routed text (it owns the live textarea). Filters:
//   - invalid workflows (broken files) — they cannot be started;
//   - a name that collides with an existing command (built-in slash, server, or
//     MCP command) so a workflow never silently shadows / duplicates a real
//     command. `value` carries the bare workflow name for the caller's onSelect.
export function workflowCommandOptions(
  workflows: WorkflowInfo[],
  existingCommandNames: Set<string>,
): AutocompleteOption[] {
  return workflows
    .filter((workflow) => workflow.valid !== false && !existingCommandNames.has(workflow.name))
    .map((workflow) => ({
      display: `/${workflow.name}`,
      value: workflow.name,
      description: workflow.meta.description ?? workflow.meta.name,
    }))
}

export function workflowCommandOption(input: TextareaRenderable): AutocompleteOption {
  return {
    display: "/workflow",
    description: "Start a workflow by name",
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
  // Skip invalid entries (broken files): they are still returned by list() but
  // cannot be started, so the picker should not offer them. The picker never
  // crashes on a broken file because list() never throws on one.
  return result.data.filter((workflow) => workflow.valid !== false)
}

// The argument declaration as it appears on a workflow's meta (WorkflowInfo /
// WorkflowMeta["arguments"]): a map of arg name -> { type?, default?, description? }.
// Only the declared `type` drives coercion here.
export type WorkflowArgDeclaration = Record<string, { type?: string }>

// Parses `name=value` tokens into a payload, coercing values by DECLARED type
// rather than by appearance. Coercion rules:
//   - An arg declared `type: "number"` whose value parses as a finite number is
//     coerced to that number. A declared-number arg whose value does NOT parse
//     (e.g. `count=abc`) is passed through as the raw string — the engine stores
//     args untyped (Record<string, unknown>) and runs no coercion/validation of
//     its own, so silently turning a non-number into NaN would corrupt data; the
//     workflow's own run() can validate. Surfacing the raw string is least surprising.
//   - Every other arg — declared string, declared anything-else, or UNDECLARED —
//     keeps its exact text (so `version=1.0` and `zip=01234` survive intact).
//   - Bare flags (`--verbose`) keep the existing behavior of becoming the string
//     "true"; the parser has never produced real booleans, and this change does
//     not introduce them.
export function parseWorkflowArgs(input: string, declaration: WorkflowArgDeclaration = {}) {
  // N14: tokenizing in a single linear pass and splitting each token on its first
  // `=` replaces the previous monolithic regex, whose nested quote/`\S*`
  // alternations could backtrack catastrophically on pathological input
  // (e.g. many repeated `="`). Token boundaries are quote-aware so a quoted value
  // with spaces survives intact (Fund 60).
  return Object.fromEntries(
    tokenizeWorkflowArgs(input).flatMap((token) => {
      const eq = token.text.indexOf("=")
      const name = (eq === -1 ? token.text : token.text.slice(0, eq)).replace(/^--?/, "")
      if (!name) return []
      const raw = eq === -1 ? "true" : token.text.slice(eq + 1)
      const value =
        (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
        (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
          ? raw.slice(1, -1).replace(/\\(["'\\])/g, "$1")
          : raw
      if (declaration[name]?.type !== "number") return [[name, value]]
      const numeric = Number(value)
      return [[name, Number.isFinite(numeric) && value.trim() !== "" ? numeric : value]]
    }),
  )
}
