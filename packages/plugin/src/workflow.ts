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
  schema?: unknown
  permissionSessionID?: string
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
 * item order. Overloaded for 1..4 stages so heterogeneous types flow through. */
export interface WorkflowPipelineFn {
  <I, A>(items: readonly I[], s1: WorkflowPipelineStage<I, I, A>, options?: WorkflowPipelineOptions): Promise<A[]>
  <I, A, B>(
    items: readonly I[],
    s1: WorkflowPipelineStage<I, I, A>,
    s2: WorkflowPipelineStage<A, I, B>,
    options?: WorkflowPipelineOptions,
  ): Promise<B[]>
  <I, A, B, C>(
    items: readonly I[],
    s1: WorkflowPipelineStage<I, I, A>,
    s2: WorkflowPipelineStage<A, I, B>,
    s3: WorkflowPipelineStage<B, I, C>,
    options?: WorkflowPipelineOptions,
  ): Promise<C[]>
  <I, A, B, C, D>(
    items: readonly I[],
    s1: WorkflowPipelineStage<I, I, A>,
    s2: WorkflowPipelineStage<A, I, B>,
    s3: WorkflowPipelineStage<B, I, C>,
    s4: WorkflowPipelineStage<C, I, D>,
    options?: WorkflowPipelineOptions,
  ): Promise<D[]>
}

export type WorkflowContext = {
  setPhase(phase: string): void
  log(message: string): void
  parallel<T>(tasks: readonly (() => Promise<T>)[], options?: WorkflowParallelOptions): Promise<T[]>
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
