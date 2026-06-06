import { Schema } from "effect"

// Workflow meta schemas live in their own leaf module (depending only on
// `Schema`) so both the engine (`workflow.ts`) and the static meta reader
// (`meta-reader.ts`) can import them without forming an import cycle: the engine
// re-exports them so its public `Workflow.Meta` / `Workflow.Argument` API is
// unchanged, while the reader can build its decoder at module scope.

export const Argument = Schema.Struct({
  type: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
}).annotate({ identifier: "WorkflowArgument" })
export type Argument = Schema.Schema.Type<typeof Argument>

export const Meta = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  phases: Schema.optional(Schema.Array(Schema.String)),
  arguments: Schema.optional(Schema.Record(Schema.String, Argument)),
}).annotate({ identifier: "WorkflowMeta" })
export type Meta = Schema.Schema.Type<typeof Meta>
