type WorkflowArgumentType = "string" | "number" | "boolean"

type WorkflowArgument = {
  type?: WorkflowArgumentType
  default?: unknown
  description?: string
}

type WorkflowArguments = Record<string, WorkflowArgument>

type WorkflowArgumentValue<T extends WorkflowArgument> = T["type"] extends "number"
  ? number
  : T["type"] extends "boolean"
    ? boolean
    : string

type WorkflowArgs<Args extends WorkflowArguments | undefined> = Args extends WorkflowArguments
  ? { readonly [Key in keyof Args]?: WorkflowArgumentValue<Args[Key]> }
  : Record<string, unknown>

export type WorkflowAgentInput = {
  prompt: string
  agent?: string
  model?: string
  /** Per-step model reasoning variant (e.g. "max"), threaded into the underlying prompt run. */
  variant?: string
  /**
   * Per-step tool scoping for this agent step. A map of tool/permission name to
   * whether it is enabled, with glob-able keys (e.g. `{ webfetch: false }` or
   * `{ "skill_*": true }`). Each entry becomes an allow/deny permission rule on
   * the child session, so the subagent only sees the tools you scope it to.
   */
  tools?: Record<string, boolean>
  /**
   * Skills to make available to this agent step. opencode loads skills at
   * runtime via the `skill` tool, so naming them here prepends a "Load these
   * skills before starting: …" directive to the prompt and enables the `skill`
   * tool for the step (merged with any `tools` scoping). The agent loads each
   * named skill before doing its work.
   */
  skills?: string[]
  /**
   * Files to attach to this agent step. Each path is resolved relative to the
   * run's workspace directory (absolute paths are used as-is) and must exist —
   * a missing file fails the step. Each attachment is appended after the prompt
   * as a file part, so the agent can read it directly.
   */
  files?: string[]
  schema?: unknown
  permissionSessionID?: string
  /**
   * Run this step's subagent in a FRESH `git worktree` instead of the run's
   * workspace, so parallel agents that mutate files do not conflict. The
   * worktree is created when the step dispatches and auto-removed when the run
   * finishes or is cancelled. Requires the workspace to be a git repository;
   * otherwise the step fails with a clear error.
   */
  isolation?: "worktree"
}

export type WorkflowAgentResult = {
  data: unknown
  text: string
}

export type WorkflowParallelOptions = { concurrencyLimit?: number }
export type WorkflowPipelineOptions = { concurrencyLimit?: number }

/** A pipeline stage: receives the previous stage's output for this item plus the
 * original item, and returns the next value. The first stage's `prev` is the
 * item itself. Stages may change the type (`I → S1 → S2 …`). */
export type WorkflowPipelineStage<Prev, Item, Next> = (prev: Prev, item: Item) => Promise<Next>

/** Per-item pipeline. Each item flows through every stage SEQUENTIALLY (stage N+1
 * receives stage N's result for that item), while items run concurrently against
 * each other (no barrier between stages). Result is the last stage's output in
 * item order. A stage that throws does NOT fail the whole pipeline — it drops ONLY
 * that item to `null` at its position (skipping that item's remaining stages, and
 * logging the drop); other items keep running. Only a run abort stays fatal.
 * Filter the result before use, e.g. `.filter((x) => x !== null)`. Overloaded for
 * 1..4 stages so heterogeneous types flow through. */
export interface WorkflowPipelineFn {
  <I, A>(
    items: readonly I[],
    s1: WorkflowPipelineStage<I, I, A>,
    options?: WorkflowPipelineOptions,
  ): Promise<(A | null)[]>
  <I, A, B>(
    items: readonly I[],
    s1: WorkflowPipelineStage<I, I, A>,
    s2: WorkflowPipelineStage<A, I, B>,
    options?: WorkflowPipelineOptions,
  ): Promise<(B | null)[]>
  <I, A, B, C>(
    items: readonly I[],
    s1: WorkflowPipelineStage<I, I, A>,
    s2: WorkflowPipelineStage<A, I, B>,
    s3: WorkflowPipelineStage<B, I, C>,
    options?: WorkflowPipelineOptions,
  ): Promise<(C | null)[]>
  <I, A, B, C, D>(
    items: readonly I[],
    s1: WorkflowPipelineStage<I, I, A>,
    s2: WorkflowPipelineStage<A, I, B>,
    s3: WorkflowPipelineStage<B, I, C>,
    s4: WorkflowPipelineStage<C, I, D>,
    options?: WorkflowPipelineOptions,
  ): Promise<(D | null)[]>
}

export type WorkflowContext = {
  /**
   * Remaining run budget in USD. Reflects the live cost cap the run was started
   * with, decremented by each agent step's actual cost. `Infinity` when the run
   * was started without a budget (unlimited — the default). Read it to make a
   * workflow budget-aware; the engine additionally fails the next `agent()` call
   * with a budget error once this reaches zero.
   */
  readonly budgetRemaining: number
  /** Cost budget (USD) in Claude-Code API shape: `total` (null when unlimited), `spent()` so far, `remaining()` (Infinity when unlimited). */
  readonly budget: { readonly total: number | null; spent(): number; remaining(): number }
  setPhase(phase: string): void
  log(message: string): void
  /**
   * Run `tasks` concurrently and resolve to their results in task order. A thunk
   * that throws (or whose `agent()` errors) does NOT fail the whole batch — it
   * resolves to `null` at its position (the drop is logged); only a run abort
   * stays fatal. Filter the result before use, e.g. `.filter((x) => x !== null)`.
   */
  parallel<T>(tasks: readonly (() => Promise<T>)[], options?: WorkflowParallelOptions): Promise<(T | null)[]>
  pipeline: WorkflowPipelineFn
  agent(input: WorkflowAgentInput): Promise<WorkflowAgentResult>
}

export function workflow<const Args extends WorkflowArguments | undefined = undefined>(input: {
  name: string
  description?: string
  phases?: readonly string[]
  arguments?: Args
  run(args: WorkflowArgs<Args>, ctx: WorkflowContext): Promise<unknown>
}) {
  return {
    meta: {
      name: input.name,
      description: input.description,
      phases: input.phases,
      arguments: input.arguments,
    },
    run: input.run,
  }
}
