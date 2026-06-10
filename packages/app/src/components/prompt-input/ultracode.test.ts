import { describe, expect, test } from "bun:test"
import {
  buildUltracodeParts,
  detectUltracodeKeyword,
  stripUltracodeKeyword,
  systemReminder,
  ultracodeToggle,
  ULTRACODE_PROMPT_DIRECTIVE,
  ULTRACODE_SESSION_DIRECTIVE,
} from "./ultracode"

describe("ultracode keyword", () => {
  test("detects standalone keyword and reports span", () => {
    expect(detectUltracodeKeyword("please ultracode this")).toEqual({ index: 7, length: 9 })
    expect(detectUltracodeKeyword("ULTRACODE: audit")).toEqual({ index: 0, length: 9 })
  })
  test("ignores keyword glued to word chars", () => {
    expect(detectUltracodeKeyword("ultracodex")).toBeUndefined()
    expect(detectUltracodeKeyword("ultracode2")).toBeUndefined()
    expect(detectUltracodeKeyword("ultracode_mode")).toBeUndefined()
    expect(detectUltracodeKeyword("öultracode")).toBeUndefined()
  })
  test("strips keyword and collapses leftover whitespace/colon", () => {
    expect(stripUltracodeKeyword("ultracode: audit the repo")).toBe("audit the repo")
    expect(stripUltracodeKeyword("please ultracode this now")).toBe("please this now")
  })
  test("directives are distinct non-empty constants", () => {
    expect(ULTRACODE_PROMPT_DIRECTIVE).not.toBe(ULTRACODE_SESSION_DIRECTIVE)
    expect(ULTRACODE_PROMPT_DIRECTIVE.length).toBeGreaterThan(0)
  })
})

describe("systemReminder", () => {
  test("wraps text in the <system-reminder> tag", () => {
    expect(systemReminder("X")).toBe("<system-reminder>X</system-reminder>")
  })
  test("wrapped directives keep the original wording", () => {
    const wrapped = systemReminder(ULTRACODE_SESSION_DIRECTIVE)
    expect(wrapped).toContain(ULTRACODE_SESSION_DIRECTIVE)
    expect(wrapped.startsWith("<system-reminder>")).toBe(true)
    expect(wrapped.endsWith("</system-reminder>")).toBe(true)
  })
})

describe("buildUltracodeParts", () => {
  test("prepends session + keyword directives and strips keyword", () => {
    const out = buildUltracodeParts({ text: "ultracode fix bug", session: true, keywordEnabled: true })
    expect(out.directives).toContain(ULTRACODE_SESSION_DIRECTIVE)
    expect(out.directives).toContain(ULTRACODE_PROMPT_DIRECTIVE)
    expect(out.text).toBe("fix bug")
  })
  test("no directives when off and no keyword", () => {
    expect(buildUltracodeParts({ text: "fix bug", session: false, keywordEnabled: true })).toEqual({
      directives: [],
      text: "fix bug",
    })
  })
  test("keyword directive suppressed when keywordEnabled is false", () => {
    const out = buildUltracodeParts({ text: "ultracode fix bug", session: false, keywordEnabled: false })
    expect(out.directives).toEqual([])
    expect(out.text).toBe("ultracode fix bug")
  })
})

describe("ultracodeToggle", () => {
  test("flips state and reports the labels for the resulting state", () => {
    const turningOn = ultracodeToggle(false)
    expect(turningOn.next).toBe(true)
    expect(turningOn.commandTitle).toBe("command.ultracode.disable")
    expect(turningOn.toast).toEqual({
      title: "toast.ultracode.on.title",
      description: "toast.ultracode.on.description",
    })

    const turningOff = ultracodeToggle(true)
    expect(turningOff.next).toBe(false)
    expect(turningOff.commandTitle).toBe("command.ultracode.enable")
    expect(turningOff.toast).toEqual({
      title: "toast.ultracode.off.title",
      description: "toast.ultracode.off.description",
    })
  })
})
