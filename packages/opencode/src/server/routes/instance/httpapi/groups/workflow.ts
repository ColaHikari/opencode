import { SessionID } from "@/session/schema"
import { Workflow } from "@/workflow/workflow"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiError, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/workflow"

export const StartPayload = Schema.Struct({
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  // Optional cost cap (USD) for the run; mirrors the engine StartInput.budget.
  // Non-negative finite: a negative/NaN/Infinity cap is rejected at validation.
  budget: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  // Session that should receive permission prompts raised by the run's
  // subagents (mirrors the workflow tool path). Headless default: when omitted,
  // permission requests follow the engine's default policy on an unobserved
  // session — pass the caller's session id to surface them interactively.
  // Validated/branded at the schema boundary like the session endpoints do.
  permissionSessionID: Schema.optional(SessionID),
}).annotate({ identifier: "WorkflowStartPayload" })
export type StartPayload = Schema.Schema.Type<typeof StartPayload>

// 400 for a bad request against a workflow (a workflow file that fails to load:
// bad meta / missing run / syntax error). `workflow` ALWAYS carries the workflow
// NAME so a single field has one stable meaning; the failing file's `path` is a
// separate optional field. (A non-existent workflow name is NOT this error — it
// is a 404 `ApiNotFoundError`, matching the repo-wide *NotFound → 404 convention.)
export class WorkflowApiError extends Schema.TaggedErrorClass<WorkflowApiError>()(
  "WorkflowApiError",
  {
    message: Schema.String,
    workflow: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
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
          // No error channel: list() never fails (a broken file becomes an
          // `{ valid: false }` entry), so declaring an error here would surface a
          // dead, unreachable 400 in the generated SDK.
          success: described(Schema.Array(Workflow.Info), "List of workflows"),
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
            description:
              "List persisted workflow execution runs for this instance, with live in-memory state overlaid for active runs.",
          }),
        ),
        HttpApiEndpoint.get("get", WorkflowPaths.get, {
          // Branded at the schema boundary (like the session endpoints): an id
          // that does not match the run-id format is a 400 at decode time, never
          // a defect inside the handler.
          params: { id: Workflow.RunID },
          query: WorkspaceRoutingQuery,
          // Id-addressed like the session endpoints: a missing run is a 404, not a
          // 200 + null. The success body is therefore a bare (non-nullable) Run so
          // the generated SDK type matches what callers actually receive on 200.
          success: described(Workflow.Run, "Workflow run"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
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
          // A bad/broken workflow file is a 400 (WorkflowApiError); an unknown
          // workflow name is a 404 (ApiNotFoundError), matching the repo-wide
          // *NotFound → 404 convention.
          error: [WorkflowApiError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.start",
            summary: "Start workflow",
            description: "Start a workflow execution run.",
          }),
        ),
        HttpApiEndpoint.post("cancel", WorkflowPaths.cancel, {
          // Branded at the schema boundary (like the session endpoints): an id
          // that does not match the run-id format is a 400 at decode time, never
          // a defect inside the handler.
          params: { id: Workflow.RunID },
          query: WorkspaceRoutingQuery,
          // Id-addressed like the session endpoints: a run that is not known to
          // this workspace is a 404. A known-but-already-terminal run still
          // returns 200 with its current snapshot (cancel is idempotent). The
          // success body is therefore a bare (non-nullable) Run.
          success: described(Workflow.Run, "Workflow run cancelled"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.cancel",
            summary: "Cancel workflow run",
            description: "Cancel a running workflow execution run.",
          }),
        ),
        HttpApiEndpoint.delete("remove", WorkflowPaths.remove, {
          // Branded at the schema boundary (like the session endpoints): an id
          // that does not match the run-id format is a 400 at decode time, never
          // a defect inside the handler.
          params: { id: Workflow.RunID },
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
