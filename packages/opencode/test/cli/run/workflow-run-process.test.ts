// Subprocess integration test for `opencode run --workflow`. A real workflow run
// would need a discovered workflow file + the test LLM; the robust smoke here is
// that an UNKNOWN workflow name fails fast with a non-zero exit (validates the
// wiring — option, branch, start error, exit code — without a workflow fixture).
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("opencode run --workflow (subprocess)", () => {
  cliIt.concurrent(
    "run --workflow exits nonzero for an unknown workflow name",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(
          ["run", "--workflow", "does-not-exist", "--model", "test/test-model"],
          { timeoutMs: 20_000 },
        )
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(20_000) // no hang
      }),
    40_000,
  )
})
