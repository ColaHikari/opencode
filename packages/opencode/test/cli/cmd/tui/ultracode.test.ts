import { describe, expect, it } from "bun:test"
import {
  detectUltracodeKeyword,
  stripUltracodeKeyword,
  ULTRACODE_PROMPT_DIRECTIVE,
  ULTRACODE_SESSION_DIRECTIVE,
} from "@/cli/cmd/tui/component/prompt/ultracode"

describe("ultracode keyword", () => {
  it("erkennt das Keyword als eigenständiges Token, case-insensitive", () => {
    expect(detectUltracodeKeyword("ultracode: audit src/")?.index).toBe(0)
    expect(detectUltracodeKeyword("bitte ULTRACODE nutzen")?.index).toBe(6)
    expect(detectUltracodeKeyword("kein ultracodex hier")).toBeUndefined()
    expect(detectUltracodeKeyword("xultracode")).toBeUndefined()
  })

  it("liefert Länge fürs Highlight", () => {
    const hit = detectUltracodeKeyword("run ultracode now")
    expect(hit && { index: hit.index, length: hit.length }).toEqual({ index: 4, length: 9 })
  })

  it("stripUltracodeKeyword entfernt Token + Doppel-Spaces + führenden Doppelpunkt", () => {
    expect(stripUltracodeKeyword("ultracode: audit src/")).toBe("audit src/")
    expect(stripUltracodeKeyword("bitte ultracode  nutzen")).toBe("bitte nutzen")
  })

  it("Direktiven nennen workflow-Tool, create und substantial", () => {
    expect(ULTRACODE_PROMPT_DIRECTIVE).toContain("workflow")
    expect(ULTRACODE_PROMPT_DIRECTIVE).toContain("create")
    expect(ULTRACODE_SESSION_DIRECTIVE).toContain("substantial")
  })

  // Edge cases beyond the mandated spec. Boundaries follow identifier rules:
  // a neighbouring letter, digit, or underscore prevents a match.
  it("matcht nur ganze Wörter und respektiert Wortgrenzen mit Interpunktion", () => {
    expect(detectUltracodeKeyword("(ultracode)")?.index).toBe(1)
    expect(detectUltracodeKeyword("foo-ultracode")?.index).toBe(4)
    expect(detectUltracodeKeyword("ultracode_mode")).toBeUndefined()
    expect(detectUltracodeKeyword("ultracode2")).toBeUndefined()
    expect(detectUltracodeKeyword("ultracode")?.index).toBe(0)
  })

  // Unicode-Wortgrenzen: `\b` ist ASCII-only und würde "ultracodeö" fälschlich als
  // Treffer werten. Mit Unicode-Lookarounds zählen auch Nicht-ASCII-Buchstaben als
  // Wortzeichen, also blockieren sie den Match links wie rechts.
  it("respektiert Unicode-Buchstaben an der Wortgrenze", () => {
    expect(detectUltracodeKeyword("ultracodeö")).toBeUndefined()
    expect(detectUltracodeKeyword("öultracode")).toBeUndefined()
    expect(detectUltracodeKeyword("ödann ultracode jetzt")?.index).toBe(6)
  })

  it("liefert das erste Vorkommen", () => {
    const hit = detectUltracodeKeyword("ultracode then ultracode again")
    expect(hit?.index).toBe(0)
  })

  it("ohne Keyword kommt undefined zurück", () => {
    expect(detectUltracodeKeyword("just a normal prompt")).toBeUndefined()
    expect(detectUltracodeKeyword("")).toBeUndefined()
  })

  it("stripUltracodeKeyword entfernt das Keyword mitten im Text und säubert Spaces", () => {
    expect(stripUltracodeKeyword("run ultracode now")).toBe("run now")
    expect(stripUltracodeKeyword("ULTRACODE audit")).toBe("audit")
  })

  it("stripUltracodeKeyword lässt Text ohne Keyword unverändert (nur getrimmt)", () => {
    expect(stripUltracodeKeyword("just a normal prompt")).toBe("just a normal prompt")
  })

  it("stripUltracodeKeyword entfernt das Keyword auch wenn es alleine steht", () => {
    expect(stripUltracodeKeyword("ultracode")).toBe("")
    expect(stripUltracodeKeyword("ultracode  ")).toBe("")
  })

  it("Direktiven transportieren die volle opt-in Semantik", () => {
    expect(ULTRACODE_PROMPT_DIRECTIVE).toContain("ultracode")
    expect(ULTRACODE_PROMPT_DIRECTIVE).toContain("start")
    expect(ULTRACODE_SESSION_DIRECTIVE).toContain("workflow")
    expect(ULTRACODE_SESSION_DIRECTIVE).toContain("create")
    expect(ULTRACODE_SESSION_DIRECTIVE).toContain("ON")
  })
})
