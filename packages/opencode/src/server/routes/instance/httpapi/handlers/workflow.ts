import { Workflow } from "@/workflow/workflow"
import { SessionPrompt } from "@/session/prompt"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { type StartPayload, WorkflowApiError } from "../groups/workflow"

function apiError(error: Workflow.InvalidError | Workflow.NotFoundError) {
  if (error._tag === "WorkflowInvalidError")
    return new WorkflowApiError({ message: error.message, workflow: error.path })
  return new WorkflowApiError({ message: `Workflow not found: ${error.name}`, workflow: error.name })
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
      // malformed id is a 400 at decode time and never reaches this handler.
      return (yield* workflow.get(ctx.params.id)) ?? null
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
        .pipe(Effect.mapError(apiError))
    })

    const cancel = Effect.fn("WorkflowHttpApi.cancel")(function* (ctx: { params: { id: Workflow.RunID } }) {
      return (yield* workflow.cancel(ctx.params.id)) ?? null
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
