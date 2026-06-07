import { SessionID } from "@/session/schema"
import { Workflow } from "@/workflow/workflow"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiError, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError, ConflictError } from "../errors"
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
  // Resume a previous (paused/interrupted) run: its id. When set, the engine
  // replays the source run's persisted agent journal — every completed agent it
  // can match is re-used verbatim instead of re-prompted. Branded at the schema
  // boundary like the run-id route params.
  resume_of: Schema.optional(Workflow.RunID),
  // Source-journal agent indices (0-based) to force live re-execution of during a
  // resume, even if they completed. Only meaningful together with `resume_of`.
  // Lets the dashboard re-run a single agent while replaying the rest (the `r`
  // key on a selected agent).
  invalidate_agents: Schema.optional(Schema.Array(Schema.Int)),
}).annotate({ identifier: "WorkflowStartPayload" })
export type StartPayload = Schema.Schema.Type<typeof StartPayload>

// Save a run's captured source as a discoverable workflow file (the dashboard's
// "save as command"). `scope` selects the destination dir (project .opencode vs
// global config), defaulting to project — mirroring the TUI save dialog's Tab
// toggle. The file is written verbatim after the engine statically validates its
// meta and rejects a name that is not a single safe path segment.
export const SavePayload = Schema.Struct({
  name: Schema.String.annotate({
    description: "Workflow file base name (becomes /<name>); letters, numbers, underscores, and dashes only.",
  }),
  source: Schema.String.annotate({ description: "The complete TypeScript/JavaScript workflow module source." }),
  scope: Schema.optional(Schema.Literals(["project", "global"])).annotate({
    description: "Destination: 'project' (.opencode/workflows, default) or 'global' (the global config workflows dir).",
  }),
}).annotate({ identifier: "WorkflowSavePayload" })
export type SavePayload = Schema.Schema.Type<typeof SavePayload>

// The saved file's absolute path, returned on success so a caller can surface it.
export const SaveResult = Schema.Struct({
  path: Schema.String,
}).annotate({ identifier: "WorkflowSaveResult" })
export type SaveResult = Schema.Schema.Type<typeof SaveResult>

export const AnswerPayload = Schema.Struct({
  answer: Schema.String.annotate({ description: "The human answer to the run's open question." }),
  // Session that should receive permission prompts raised by the resumed run's
  // subagents (a parked run answered here re-runs its post-question ctx.agent
  // steps). Mirrors StartPayload.permissionSessionID: headless default when
  // omitted, branded at the schema boundary like the session endpoints.
  permissionSessionID: Schema.optional(SessionID),
}).annotate({ identifier: "WorkflowAnswerPayload" })
export type AnswerPayload = Schema.Schema.Type<typeof AnswerPayload>

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
  // Save a source string as a discoverable workflow file. A static `/save` segment
  // (not a `:param`) so it can never collide with the `:name/start` shape.
  save: `${root}/save`,
  get: `${root}/run/:id`,
  start: `${root}/:name/start`,
  cancel: `${root}/run/:id/cancel`,
  pause: `${root}/run/:id/pause`,
  answer: `${root}/run/:id/answer`,
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
        HttpApiEndpoint.post("save", WorkflowPaths.save, {
          query: WorkspaceRoutingQuery,
          payload: SavePayload,
          // 200 + the written file path on success. A bad name or statically-invalid
          // meta is a 400 (WorkflowApiError) — the engine validates with the SAME
          // MetaReader the create tool uses; an existing file at the destination is a
          // 409 (ConflictError), never an overwrite, matching the create tool.
          success: described(SaveResult, "Workflow saved to disk"),
          error: [WorkflowApiError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.save",
            summary: "Save workflow",
            description:
              "Save a workflow source string as a discoverable workflow file under the project or global workflows directory.",
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
        HttpApiEndpoint.post("pause", WorkflowPaths.pause, {
          // Branded at the schema boundary (like cancel): a malformed id is a 400
          // at decode time, never a defect inside the handler.
          params: { id: Workflow.RunID },
          query: WorkspaceRoutingQuery,
          // Id-addressed like cancel: a run not known to this workspace is a 404.
          // A known run returns 200 with its current snapshot (paused on success,
          // or its terminal status if it had already finished). The success body
          // is a bare (non-nullable) Run.
          success: described(Workflow.Run, "Workflow run paused"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.pause",
            summary: "Pause workflow run",
            description: "Pause a running workflow execution run, keeping its journal so it can be resumed.",
          }),
        ),
        HttpApiEndpoint.post("answer", WorkflowPaths.answer, {
          // Branded at the schema boundary like cancel/pause: a malformed id is a 400
          // at decode time, never a defect in the handler.
          params: { id: Workflow.RunID },
          query: WorkspaceRoutingQuery,
          payload: AnswerPayload,
          // 200 + the run: a LIVE answer returns the SAME run (question resolved); a
          // PARKED (paused) run returns the NEW resumed run. A run not known to this
          // workspace is a 404; a known run with no open question is a 409.
          success: described(Workflow.Run, "Workflow run after answering its open question"),
          // WorkflowApiError (400): answering a PARKED run starts a resume, which can
          // fail to load the (now resumed) workflow file the same way start does — the
          // handler maps that engine InvalidError to WorkflowApiError, so it must be a
          // declared channel here too.
          error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError, WorkflowApiError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.answer",
            summary: "Answer workflow question",
            description:
              "Answer a run's open human-in-the-loop question. A live run resolves in place; a parked run is resumed.",
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
