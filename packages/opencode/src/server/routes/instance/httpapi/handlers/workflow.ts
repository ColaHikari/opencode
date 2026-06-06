import { Workflow } from "@/workflow/workflow"
import { SessionPrompt } from "@/session/prompt"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"
import { type StartPayload, WorkflowApiError } from "../groups/workflow"

// Maps the engine's typed start() failures onto the HTTP contract:
// - a broken/invalid workflow file (load failure) → 400 WorkflowApiError, with
//   `workflow` carrying the requested NAME and `path` the failing file (Fund 44).
// - an unknown workflow name → 404 ApiNotFoundError, matching the repo-wide
//   *NotFound → 404 convention (Fund 21).
// The requested name is threaded in because the engine's InvalidError only
// carries the file `path`, not the workflow name.
function apiError(name: string) {
  return (error: Workflow.InvalidError | Workflow.NotFoundError) => {
    if (error._tag === "WorkflowInvalidError")
      return new WorkflowApiError({ message: error.message, workflow: name, path: error.path })
    return notFound(`Workflow not found: ${error.name}`)
  }
}

export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const workflow = yield* Workflow.Service
    const prompt = yield* SessionPrompt.Service

    const list = Effect.fn("WorkflowHttpApi.list")(function* () {
      // list() never fails (broken files are reported as invalid entries), so no
      // error mapping is needed here; apiError still covers start()'s failures.
      return yield* workflow.list()
    })

    const runs = Effect.fn("WorkflowHttpApi.runs")(function* () {
      return yield* workflow.runs()
    })

    const get = Effect.fn("WorkflowHttpApi.get")(function* (ctx: { params: { id: Workflow.RunID } }) {
      // The route param is validated/branded by the params schema (RunID), so a
      // malformed id is a 400 at decode time and never reaches this handler. An
      // unknown id is a 404 (id-addressed, like the session endpoints) rather
      // than a 200 + null.
      const run = yield* workflow.get(ctx.params.id)
      if (!run) return yield* notFound(`Workflow run not found: ${ctx.params.id}`)
      return run
    })

    const start = Effect.fn("WorkflowHttpApi.start")(function* (ctx: {
      params: { name: string }
      payload?: StartPayload
    }) {
      return yield* workflow
        .start({
          name: ctx.params.name,
          args: ctx.payload?.args,
          budget: ctx.payload?.budget,
          // Already branded by the StartPayload schema decode (SessionID).
          permissionSessionID: ctx.payload?.permissionSessionID,
          prompt,
        })
        .pipe(Effect.mapError(apiError(ctx.params.name)))
    })

    const cancel = Effect.fn("WorkflowHttpApi.cancel")(function* (ctx: { params: { id: Workflow.RunID } }) {
      // The engine returns undefined ONLY when the run is not in this workspace's
      // registry → 404. A known run (running or already-terminal) returns its
      // snapshot → 200.
      const run = yield* workflow.cancel(ctx.params.id)
      if (!run) return yield* notFound(`Workflow run not found: ${ctx.params.id}`)
      return run
    })

    const remove = Effect.fn("WorkflowHttpApi.remove")(function* (ctx: { params: { id: Workflow.RunID } }) {
      return yield* workflow.remove(ctx.params.id)
    })

    return handlers
      .handle("list", list)
      .handle("runs", runs)
      .handle("get", get)
      .handle("start", start)
      .handle("cancel", cancel)
      .handle("remove", remove)
  }),
)
