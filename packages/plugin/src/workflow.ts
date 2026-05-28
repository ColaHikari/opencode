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
}

export type WorkflowAgentResult = {
  data: unknown
  text: string
}

export type WorkflowContext = {
  setPhase(phase: string): void
  log(message: string): void
  parallel<T>(tasks: readonly (() => Promise<T>)[], options?: { concurrencyLimit?: number }): Promise<T[]>
  pipeline<T>(items: readonly T[], steps: readonly ((item: T) => Promise<T>)[]): Promise<T[]>
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
