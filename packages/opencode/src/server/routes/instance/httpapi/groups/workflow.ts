import { Workflow } from "@/workflow/workflow"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/workflow"

export const StartPayload = Schema.Struct({
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  // Optional cost cap (USD) for the run; mirrors the engine StartInput.budget.
  budget: Schema.optional(Schema.Finite),
}).annotate({ identifier: "WorkflowStartPayload" })
export type StartPayload = Schema.Schema.Type<typeof StartPayload>

export class WorkflowApiError extends Schema.TaggedErrorClass<WorkflowApiError>()(
  "WorkflowApiError",
  {
    message: Schema.String,
    workflow: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export const WorkflowPaths = {
  list: root,
  runs: `${root}/run`,
  get: `${root}/run/:id`,
  start: `${root}/:name/start`,
  cancel: `${root}/run/:id/cancel`,
  remove: `${root}/run/:id`,
} as const

export const WorkflowApi = HttpApi.make("workflow")
  .add(
    HttpApiGroup.make("workflow")
      .add(
        HttpApiEndpoint.get("list", WorkflowPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workflow.Info), "List of workflows"),
          error: WorkflowApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.list",
            summary: "List workflows",
            description: "List discovered workflow definitions.",
          }),
        ),
        HttpApiEndpoint.get("runs", WorkflowPaths.runs, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workflow.Run), "List of workflow runs"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.runs",
            summary: "List workflow runs",
            description: "List in-memory workflow execution runs for this instance.",
          }),
        ),
        HttpApiEndpoint.get("get", WorkflowPaths.get, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.NullOr(Workflow.Run), "Workflow run"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.get",
            summary: "Get workflow run",
            description: "Get details for a workflow execution run.",
          }),
        ),
        HttpApiEndpoint.post("start", WorkflowPaths.start, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.optional(StartPayload),
          success: described(Workflow.Run, "Workflow run started"),
          error: WorkflowApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.start",
            summary: "Start workflow",
            description: "Start a workflow execution run.",
          }),
        ),
        HttpApiEndpoint.post("cancel", WorkflowPaths.cancel, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.NullOr(Workflow.Run), "Workflow run cancelled"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.cancel",
            summary: "Cancel workflow run",
            description: "Cancel a running workflow execution run.",
          }),
        ),
        HttpApiEndpoint.delete("remove", WorkflowPaths.remove, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Workflow run deleted"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.delete",
            summary: "Delete workflow run",
            description: "Delete a workflow run from persisted history.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "workflow",
          description: "Workflow routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
