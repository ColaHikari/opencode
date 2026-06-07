import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import fs from "fs/promises"
import path from "path"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Session } from "@/session/session"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Full HTTP lifecycle through the REAL instance httpapi (the answer-route test
// only checks registration; this drives the actual request sequence). The
// fixtures use ONLY ctx.question (no ctx.agent), so no LLM/prompt-ops are needed:
// the question waits live and the answer route resolves it.
//
// Execution-time reconciliation (Task 3): the harness shape was copied from
// test/server/httpapi-session.test.ts — a LOCAL httpApiLayer built from
// HttpApiApp.routes + NodeHttpServer.layerTest, merged with the instance/session/
// db layers via testEffect (NOT testEffectShared). The response is an Effect
// HttpClientResponse: `response.status` is a property and `response.json` is an
// Effect (yield it). Directory is carried via the x-opencode-directory header
// (request() drops the query string by setting the URL to the pathname).
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    Database.defaultLayer,
    httpApiLayer,
  ),
)

function requestInDirectory(reqPath: string, directory: string, init: RequestInit = {}) {
  const url = new URL(reqPath, "http://localhost")
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return HttpClientRequest.fromWeb(new Request(url, { ...init, headers })).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function bodyJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json as Effect.Effect<Record<string, any>, unknown, never>
}

async function writeWorkflow(dir: string, name: string, source: string) {
  const workflows = path.join(dir, ".opencode", "workflows")
  await fs.mkdir(workflows, { recursive: true })
  await Bun.write(path.join(workflows, `${name}.ts`), source)
}

const LIVE_Q = `export const meta = { name: "http-live-q", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const a = await ctx.question({ question: "deploy?", options: ["yes", "no"] })
  return { answer: a.answer }
}
`
const PARK_Q = `export const meta = { name: "http-park-q", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const a = await ctx.question({ question: "deploy?", options: ["yes", "no"], timeout: 50 })
  return { answer: a.answer }
}
`

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("workflow HTTP lifecycle e2e", () => {
  it.live("start -> question -> answer (live) completes through the httpapi", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => writeWorkflow(directory, "http-live-q", LIVE_Q))

      const startRes = yield* requestInDirectory("/workflow/http-live-q/start", directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(startRes.status).toBe(200)
      const started = yield* bodyJson(startRes)
      const id = started["id"] as string
      expect(id).toMatch(/^job/)

      // Poll GET until the pending question is live.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const res = yield* requestInDirectory(`/workflow/run/${id}`, directory)
          const run = yield* bodyJson(res)
          return run?.["pending_question"]?.question === "deploy?" ? run : undefined
        }),
        "pending question via GET",
      )

      // Answer it live.
      const answerRes = yield* requestInDirectory(`/workflow/run/${id}/answer`, directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes" }),
      })
      expect(answerRes.status).toBe(200)
      const answered = yield* bodyJson(answerRes)
      // Live answer returns the SAME run id (resolved in place).
      expect(answered["id"]).toBe(id)

      // Poll GET until completed.
      const done = yield* pollWithTimeout(
        Effect.gen(function* () {
          const res = yield* requestInDirectory(`/workflow/run/${id}`, directory)
          const run = yield* bodyJson(res)
          return run?.["status"] === "completed" ? run : undefined
        }),
        "run completed via GET",
      )
      expect(done["result"]).toEqual({ answer: "yes" })
    }).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.live("start -> park (timeout) -> answer-as-resume -> completed through the httpapi", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => writeWorkflow(directory, "http-park-q", PARK_Q))

      const startRes = yield* requestInDirectory("/workflow/http-park-q/start", directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      const started = yield* bodyJson(startRes)
      const id = started["id"] as string

      // Poll GET until the 50ms-timeout parks it as paused with the question kept.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const res = yield* requestInDirectory(`/workflow/run/${id}`, directory)
          const run = yield* bodyJson(res)
          return run?.["status"] === "paused" && run?.["pending_question"]?.question === "deploy?" ? run : undefined
        }),
        "run parked paused via GET",
      )

      // answer() on a PARKED run returns a NEW resumed run (resume_of = parked id).
      const answerRes = yield* requestInDirectory(`/workflow/run/${id}/answer`, directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "no" }),
      })
      expect(answerRes.status).toBe(200)
      const resumed = yield* bodyJson(answerRes)
      expect(resumed["id"]).not.toBe(id)
      expect(resumed["resume_of"]).toBe(id)
      const resumedId = resumed["id"] as string

      const done = yield* pollWithTimeout(
        Effect.gen(function* () {
          const res = yield* requestInDirectory(`/workflow/run/${resumedId}`, directory)
          const run = yield* bodyJson(res)
          return run?.["status"] === "completed" ? run : undefined
        }),
        "resumed run completed via GET",
      )
      expect(done["result"]).toEqual({ answer: "no" })
    }).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.live("start -> cancel (live-waiting question) transitions to cancelled through the httpapi", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => writeWorkflow(directory, "http-live-q", LIVE_Q))

      const startRes = yield* requestInDirectory("/workflow/http-live-q/start", directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      const started = yield* bodyJson(startRes)
      const id = started["id"] as string

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const res = yield* requestInDirectory(`/workflow/run/${id}`, directory)
          const run = yield* bodyJson(res)
          return run?.["pending_question"]?.question === "deploy?" ? run : undefined
        }),
        "pending question via GET",
      )

      const cancelRes = yield* requestInDirectory(`/workflow/run/${id}/cancel`, directory, { method: "POST" })
      expect(cancelRes.status).toBe(200)
      const cancelled = yield* bodyJson(cancelRes)
      expect(cancelled["status"]).toBe("cancelled")

      // 409 on answering a run with no open question (now terminal).
      const lateAnswer = yield* requestInDirectory(`/workflow/run/${id}/answer`, directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes" }),
      })
      expect(lateAnswer.status).toBe(409)
    }).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )
})
