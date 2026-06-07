import { describe, expect, test } from "bun:test"
import {
  questionOptions,
  selectedAnswer,
  isResumeAnswer,
} from "../../../../src/component/dialog-workflow-question-helpers"

describe("questionOptions", () => {
  test("declared options plus a free-text sentinel", () => {
    const opts = questionOptions({ question: "Pick", options: ["a", "b"], asked_at: 1 })
    expect(opts.map((o) => o.kind)).toEqual(["option", "option", "freetext"])
    expect(opts[0].label).toBe("a")
  })
  test("no declared options yields only the free-text entry", () => {
    expect(questionOptions({ question: "Q", asked_at: 1 }).map((o) => o.kind)).toEqual(["freetext"])
  })
})

describe("selectedAnswer", () => {
  test("an option selection returns the option text, ignoring the free-text field", () => {
    const opts = questionOptions({ question: "Q", options: ["yes", "no"], asked_at: 1 })
    expect(selectedAnswer(opts, 1, "typed but unused")).toBe("no")
  })
  test("the free-text entry returns the typed text trimmed", () => {
    const opts = questionOptions({ question: "Q", options: ["yes"], asked_at: 1 })
    expect(selectedAnswer(opts, 1, "  custom  ")).toBe("custom")
  })
  test("empty free-text returns undefined (nothing to submit)", () => {
    const opts = questionOptions({ question: "Q", asked_at: 1 })
    expect(selectedAnswer(opts, 0, "   ")).toBeUndefined()
  })
})

describe("isResumeAnswer", () => {
  test("answering a parked (paused) run yields a NEW run id => resume to follow", () => {
    expect(isResumeAnswer("job_src", { id: "job_new", status: "running" } as never)).toBe(true)
  })
  test("answering a live run resolves in place (same id) => not a resume", () => {
    expect(isResumeAnswer("job_src", { id: "job_src", status: "running" } as never)).toBe(false)
  })
})
