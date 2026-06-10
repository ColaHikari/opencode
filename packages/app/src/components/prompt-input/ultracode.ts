// Ultracode + budget directive: a standalone `ultracode` keyword (or the
// /ultracode session toggle) tells the agent to orchestrate the task via the
// workflow tool instead of working turn by turn, and a standalone `+$<n>` token
// sets a USD cost cap for the workflow starts of this turn. This module is pure
// so it can be unit tested without the renderer runtime; the prompt component
// wires detection, highlighting, stripping, and directive injection on top of it.

// Word-boundary match via Unicode lookarounds: the keyword only matches when it is
// not flanked by a letter, digit, or underscore (\p{L}\p{N}_). Unlike the ASCII-only
// `\b`, this treats non-ASCII letters as word characters too, so "ultracodeö",
// "öultracode", "ultracodex", "ultracode2", and "ultracode_mode" never match while
// "ultracode:", "(ultracode)", and "foo-ultracode" do. The `i` flag makes detection
// case-insensitive, `u` enables Unicode property escapes.
const KEYWORD = "ultracode"
const BOUNDARY = `(?<![\\p{L}\\p{N}_])${KEYWORD}(?![\\p{L}\\p{N}_])`
const KEYWORD_RE = new RegExp(BOUNDARY, "iu")

export const ULTRACODE_PROMPT_DIRECTIVE =
  "The user opted into workflow orchestration for this task (ultracode). " +
  "Author a workflow for it with the workflow tool (action: create, then start) " +
  "instead of working turn by turn. Use parallel/pipeline fan-out and adversarial " +
  "verification where they fit. Only skip the workflow if the task is trivial or " +
  "purely conversational."

export const ULTRACODE_SESSION_DIRECTIVE =
  "Ultracode session mode is ON: for every substantial task, plan and run workflows " +
  "by default (workflow tool: create + start) — chain understand → change → verify " +
  "runs when the task has phases. Skip only trivial or conversational turns. Treat " +
  "explicit requests like 'use a workflow' as the same opt-in."

// Wraps a directive in the <system-reminder> tag — the same state-confirmation
// convention the TUI uses for editor file selections (formatEditorContext,
// prompt/index.tsx) and its own ultracode injection (ultracodeReminder,
// prompt/ultracode.ts) — so the model reads the directive as harness state, not
// user prose. The directive CONSTANTS above stay unwrapped because the TUI and
// headless copies are kept word-identical and existing tests pin the wording.
export const systemReminder = (text: string) => `<system-reminder>${text}</system-reminder>`

// Returns the first standalone-keyword hit (index + length) for live highlighting,
// or undefined when the keyword is absent. Length tracks the matched text so the
// caller can style exactly the keyword span.
export function detectUltracodeKeyword(input: string): { index: number; length: number } | undefined {
  const match = KEYWORD_RE.exec(input)
  if (!match) return undefined
  return { index: match.index, length: match[0].length }
}

// Shared whitespace cleanup after a token strip: doubled spaces become single,
// punctuation left dangling behind the removed token is reattached, a leading
// colon/whitespace run (e.g. "ultracode: audit") is dropped, and the result is
// trimmed. The `\s+` collapse also flattens newlines into single spaces — a
// long-standing quirk of the ultracode strip the budget strip keeps for parity.
function collapseAfterStrip(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([:;,.!?])/g, "$1")
    .replace(/^[:\s]+/, "")
    .trim()
}

// Removes every standalone occurrence of the keyword and collapses the whitespace
// it leaves behind.
export function stripUltracodeKeyword(input: string): string {
  return collapseAfterStrip(input.replace(new RegExp(BOUNDARY, "giu"), ""))
}

// Budget directive: a standalone `+$<n>` token (USD form, e.g. "+$5" / "+$0.50")
// caps the cost of the workflow runs the agent starts this turn. The regex is
// CHARACTER-IDENTICAL to the TUI's (prompt/ultracode.ts BUDGET_RE) so both UIs
// detect exactly the same prompts: no letter, digit, `_`, `$`, `+`, or `.` may
// flank the token, so "a+$5", "+$5x", "+$5.5.5" (the trailing-dot lookahead
// rejects every partial match), and "+5" never match while "+$5", "(+$5)", and
// "+$0.50" do. Only the USD form exists today; the token form ("+500k") is a
// follow-up once the engine's token budget (rank 17) lands — extend via an
// alternation on this regex then.
const BUDGET_RE = /(?<![\p{L}\p{N}_$+.])\+\$(\d+(?:\.\d+)?)(?![\p{L}\p{N}_$.])/u

export type BudgetDirective = { index: number; length: number; usd: number }

// Returns the first standalone budget-directive hit, or undefined.
export function detectBudgetDirective(input: string): BudgetDirective | undefined {
  const match = BUDGET_RE.exec(input)
  if (!match) return undefined
  return { index: match.index, length: match[0].length, usd: Number(match[1]) }
}

// Removes every standalone budget directive (the first one counts, but all are
// stripped from the visible text) using the same cleanup as the keyword strip.
export function stripBudgetDirective(input: string): string {
  return collapseAfterStrip(input.replace(new RegExp(BUDGET_RE.source, "gu"), ""))
}

// Synthetic confirmation injected (via draft.directives → <system-reminder>
// parts, see buildRequestParts) when a budget directive was stripped.
export function budgetDirectiveText(usd: number): string {
  return (
    `The user set a cost budget of $${usd} (USD) for workflow runs in this turn. ` +
    `Pass budget: ${usd} in every workflow tool start action this turn; ` +
    "do not exceed it by starting additional runs."
  )
}

// Pure derivation of the /ultracode session-toggle outcome: given the CURRENT
// session-mode state, returns the next state plus the i18n keys for the command
// title and the on/off toast (mirrors the TUI toggle toast, index.tsx:1489-1518).
// Kept pure (returns keys, not resolved strings) so the toggle logic is unit-
// testable; the prompt component resolves the keys via language.t and shows the
// toast. The command title is for the state AFTER the toggle so the menu reads as
// the action it will perform next.
export type UltracodeToggleResult = {
  next: boolean
  commandTitle: "command.ultracode.enable" | "command.ultracode.disable"
  toast: { title: string; description: string }
}

export function ultracodeToggle(current: boolean): UltracodeToggleResult {
  const next = !current
  return next
    ? {
        next,
        commandTitle: "command.ultracode.disable",
        toast: { title: "toast.ultracode.on.title", description: "toast.ultracode.on.description" },
      }
    : {
        next,
        commandTitle: "command.ultracode.enable",
        toast: { title: "toast.ultracode.off.title", description: "toast.ultracode.off.description" },
      }
}

// Assembles the ultracode directives to prepend to a normal prompt. `session` is
// the /ultracode session-toggle state (every turn gets the session directive);
// `keywordEnabled` gates the standalone-keyword detection (config flag). When the
// keyword is present, it is stripped from the visible user text and the prompt
// directive is added. Pure so it is unit-testable; the submit path prepends the
// returned directives as leading text parts before the user text.
export function buildUltracodeParts(input: { text: string; session: boolean; keywordEnabled: boolean }): {
  directives: string[]
  text: string
} {
  const directives: string[] = []
  if (input.session) directives.push(ULTRACODE_SESSION_DIRECTIVE)
  let text = input.text
  if (input.keywordEnabled && detectUltracodeKeyword(input.text)) {
    directives.push(ULTRACODE_PROMPT_DIRECTIVE)
    text = stripUltracodeKeyword(input.text)
  }
  return { directives, text }
}

// Budget-directive counterpart to buildUltracodeParts, kept separate so the
// ultracode assembly stays focused. The submit path applies it AFTER the
// ultracode strip (on ultracode.text), so the strip order is deterministic:
// ultracode first, budget second. `enabled` is the config gate
// (workflows.budget_directive ?? true). Returns the (possibly stripped) text,
// plus the directive wording and USD value when a directive was found.
export function buildBudgetPart(input: { text: string; enabled: boolean }): {
  directive?: string
  text: string
  usd?: number
} {
  if (!input.enabled) return { text: input.text }
  const hit = detectBudgetDirective(input.text)
  if (!hit) return { text: input.text }
  return { directive: budgetDirectiveText(hit.usd), text: stripBudgetDirective(input.text), usd: hit.usd }
}
