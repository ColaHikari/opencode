// Built-in workflows shipped with opencode. Each entry maps a workflow NAME to
// its module SOURCE TEXT (a string, never a file on disk). This is the
// binary-safe form: the source travels inside the compiled bundle as a plain
// string constant, so there is no separate `.ts`/`.js` file that a packaged
// binary would have to ship alongside itself and locate at runtime.
//
// Discovery treats these as the LOWEST-precedence root (project > global >
// builtin): a builtin name is only ever surfaced when no project or global file
// already claims that name (first-wins in `discover`). The static `MetaReader`
// reads meta straight from the source string (it already takes `source`
// directly), and `start()` loads the module from the source string via the same
// temp-file import path that on-disk workflows use — so a builtin runs through
// the identical permission gate and argument-coercion boundary as any file.
//
// The synthetic path marker for a builtin is `builtin:<name>` (see
// BUILTIN_PATH_PREFIX); it is never a real filesystem path and is only used as a
// stable identifier on the Info/Definition record.

export const BUILTIN_PATH_PREFIX = "builtin:"

export function builtinPath(name: string) {
  return `${BUILTIN_PATH_PREFIX}${name}`
}

export function isBuiltinPath(path: string) {
  return path.startsWith(BUILTIN_PATH_PREFIX)
}

// deep-research: fan out a question into distinct search angles, research each
// in parallel, adversarially verify every claim against its cited sources, then
// synthesize a cited report from only the surviving claims. The meta fields are
// LITERALS so the static meta reader can extract name/description/phases/
// arguments without executing the module.
const DEEP_RESEARCH = `import { workflow } from "@opencode-ai/plugin"

export default workflow({
  name: "deep-research",
  description: "Research a question across angles with adversarial claim verification",
  phases: ["plan", "research", "verify", "synthesize"],
  arguments: { question: { type: "string" } },
  async run(args, ctx) {
    const question = String(args.question ?? "")
    if (!question) throw new Error("deep-research needs args.question")

    ctx.setPhase("plan")
    const plan = await ctx.agent({
      prompt: \`Break this research question into 3-5 distinct search angles. Question: \${question}. Respond ONLY via the schema.\`,
      schema: {
        type: "object",
        required: ["angles"],
        properties: { angles: { type: "array", minItems: 3, maxItems: 5, items: { type: "string" } } },
      },
    })

    ctx.setPhase("research")
    const findings = await ctx.parallel(
      plan.data.angles.map((angle) => () =>
        ctx.agent({
          prompt: \`Research this angle using your available web/search tools. If NO web tools are available, reply exactly NO_WEB_TOOLS. Angle: \${angle}\\nFull question: \${question}\\nReturn findings with source URLs via the schema.\`,
          schema: {
            type: "object",
            required: ["claims"],
            properties: {
              claims: {
                type: "array",
                items: {
                  type: "object",
                  required: ["claim", "sources"],
                  properties: {
                    claim: { type: "string" },
                    sources: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        }),
      ),
    )
    if (findings.some((f) => typeof f.text === "string" && f.text.includes("NO_WEB_TOOLS")))
      throw new Error("deep-research requires web/search tools to be available to agents")

    const claims = findings.flatMap((f) => f.data.claims)

    ctx.setPhase("verify")
    const verified = await ctx.parallel(
      claims.map((c) => () =>
        ctx
          .agent({
            prompt: \`Adversarially verify this claim against its sources (fetch them). Claim: \${c.claim}\\nSources: \${c.sources.join(", ")}\\nReply via schema: supported=true only if the sources actually back the claim.\`,
            schema: {
              type: "object",
              required: ["supported", "reason"],
              properties: { supported: { type: "boolean" }, reason: { type: "string" } },
            },
          })
          .then((v) => ({ ...c, verdict: v.data })),
      ),
      { concurrencyLimit: 8 },
    )
    const surviving = verified.filter((c) => c.verdict.supported)
    const rejected = verified.filter((c) => !c.verdict.supported)

    ctx.setPhase("synthesize")
    const report = await ctx.agent({
      prompt: \`Write a cited research report answering: \${question}\\nUse ONLY these verified claims (cite their sources inline): \${JSON.stringify(surviving)}\\nList rejected claims briefly at the end: \${JSON.stringify(rejected.map((r) => ({ claim: r.claim, reason: r.verdict.reason })))}\`,
    })

    return { report: report.text, claims: { verified: surviving.length, rejected: rejected.length } }
  },
})
`

// name -> module source text. Keep insertion order stable; discovery sorts by
// name so the order here is not load-bearing.
export const BUILTIN_WORKFLOWS: Record<string, string> = {
  "deep-research": DEEP_RESEARCH,
}
