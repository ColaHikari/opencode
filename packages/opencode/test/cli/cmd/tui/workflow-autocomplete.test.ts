import { describe, expect, test } from "bun:test"
import { parseWorkflowArgs } from "../../../../src/cli/cmd/tui/component/prompt/workflow-autocomplete"

describe("parseWorkflowArgs", () => {
  test("coerces only args declared as number", () => {
    const decl = { zip: { type: "string" }, count: { type: "number" } }
    expect(parseWorkflowArgs("zip=01234 count=42", decl)).toEqual({ zip: "01234", count: 42 })
  })

  test("string-declared numeric-looking values keep their exact text", () => {
    expect(parseWorkflowArgs("version=1.0", { version: { type: "string" } })).toEqual({ version: "1.0" })
  })

  test("string-declared values preserve leading zeros", () => {
    expect(parseWorkflowArgs("zip=01234", { zip: { type: "string" } })).toEqual({ zip: "01234" })
  })

  test("undeclared args stay strings", () => {
    expect(parseWorkflowArgs("foo=123", {})).toEqual({ foo: "123" })
  })

  test("undeclared args stay strings even without a declaration argument", () => {
    expect(parseWorkflowArgs("foo=123")).toEqual({ foo: "123" })
  })

  test("number-declared args that are not numeric pass through as raw strings", () => {
    expect(parseWorkflowArgs("count=abc", { count: { type: "number" } })).toEqual({ count: "abc" })
  })

  test("number-declared args coerce normal integers and floats", () => {
    expect(parseWorkflowArgs("count=42 ratio=1.5", { count: { type: "number" }, ratio: { type: "number" } })).toEqual({
      count: 42,
      ratio: 1.5,
    })
  })

  test("quoted values are unquoted and never coerced when declared string", () => {
    expect(parseWorkflowArgs('name="123"', { name: { type: "string" } })).toEqual({ name: "123" })
  })

  test("bare flags stay the string 'true' regardless of declaration (existing behavior)", () => {
    expect(parseWorkflowArgs("--verbose", { verbose: { type: "boolean" } })).toEqual({ verbose: "true" })
  })
})
