<!--
  Built-in skill. Name and description are registered in code at
  packages/opencode/src/skill/index.ts.
-->

# Workflow Instructions

Use this skill when the user asks to create, modify, run, debug, or review an
opencode workflow.

Do not route ordinary tasks through workflows by default. Workflows are for
repeatable multi-step automation, explicit user requests, or cases where the
user confirms that a workflow should own the execution.

## Authoring

Create reusable workflows as TypeScript files in `.opencode/workflows/`. The
file name becomes the workflow name used by the `workflow` tool with
`action: "start"`.

Prefer the typed helper. It exposes metadata for discovery and gives `args` the
types declared in `arguments`:

```ts
import { workflow } from "@opencode-ai/plugin"

export default workflow({
  name: "Example Workflow",
  description: "Describe when this workflow should be used.",
  phases: ["plan", "execute", "review"],
  arguments: {
    topic: {
      type: "string",
      description: "What to process.",
    },
  },

  async run(args, ctx) {
    ctx.setPhase("plan")
    ctx.log(`Planning work for ${args.topic}`)

    ctx.setPhase("execute")
    const result = await ctx.agent({
      agent: "general",
      prompt: `Do the work for: ${args.topic}`,
    })

    ctx.setPhase("review")
    return result
  },
})
```

Keep workflow descriptions concrete. The description is shown to agents in
`available_workflows`, so it should explain when to use the workflow and what
the workflow produces.

Workflow arguments support `string`, `number`, and `boolean` values. Provide
defaults when the workflow should be easy to run from autocomplete or by another
agent.

The `ctx` object available inside `run(args, ctx)` has these operations:

- `ctx.setPhase(name)` records the current phase and should be called before each major step.
- `ctx.log(message)` records progress in the workflow run logs.
- `ctx.agent({ agent, model, prompt, schema, permissionSessionID })` starts one subagent session and returns `{ text, data }`.
- `ctx.parallel(tasks, { concurrencyLimit })` runs async task functions concurrently and preserves result order.
- `ctx.pipeline(items, steps)` runs each item through sequential async steps while processing items concurrently.

`ctx.agent(...)` details:

- `agent` is optional; omit it to use the default agent. Built-ins include `general`, `build`, `plan`, and `explore`.
- `model` is optional and uses `provider/model` format when a step needs a specific model.
- `schema` is an optional JSON Schema. When provided, opencode requests structured output from the model.
- `data` is the parsed structured object when schema output is available; otherwise it is the assistant text.
- `text` is the human-readable assistant output. For structured output it is the formatted JSON.

## Authoring Patterns

### Structured Output

Use JSON Schema when a later step needs reliable fields instead of prose. Keep
schemas small, set `additionalProperties: false`, and tell the agent to return
data matching the schema exactly.

```ts
const briefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "risks"],
  properties: {
    summary: { type: "string" },
    risks: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
  },
}

const brief = await ctx.agent({
  agent: "plan",
  schema: briefSchema,
  prompt: [`Feature: ${args.feature}`, "Return only data that matches the provided JSON schema."].join("\n"),
})

return { brief: brief.data }
```

### Sequential Agents

Pass earlier outputs explicitly into later prompts. Prefer `data` for structured
steps and `text` for prose summaries.

```ts
ctx.setPhase("plan")
const plan = await ctx.agent({ agent: "plan", prompt: `Plan work for ${args.topic}` })

ctx.setPhase("review")
const review = await ctx.agent({
  agent: "general",
  prompt: ["Review this plan for risks and missing checks.", "", plan.text].join("\n"),
})
```

### Parallel Fan-Out

Use `ctx.parallel` when independent agents can work from the same input. Add a
`concurrencyLimit` for dynamic or large fan-outs.

```ts
ctx.setPhase("parallel-review")
const [risk, implementation] = await ctx.parallel([
  () => ctx.agent({ agent: "plan", prompt: `Find risks in: ${brief.text}` }),
  () => ctx.agent({ agent: "build", prompt: `Suggest implementation steps for: ${brief.text}` }),
])

return { risk: risk.text, implementation: implementation.text }
```

### Dynamic Agent Counts

An agent can first produce a structured list, then the workflow can fan out over
that list. Build the task array from `data` and cap concurrency.

```ts
const topics = await ctx.agent({
  agent: "plan",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 } },
  },
  prompt: `Break this request into review topics: ${args.topic}`,
})

const items = (topics.data as { items?: string[] }).items ?? []
const reviews = await ctx.parallel(
  items.map((item) => () => ctx.agent({ agent: "general", prompt: `Review this topic: ${item}` })),
  { concurrencyLimit: 3 },
)
```

### Pipelines

Use `ctx.pipeline` when every item should pass through the same ordered steps.
Each item runs step 1, then step 2, and so on; different items can progress
concurrently.

```ts
const outputs = await ctx.pipeline(
  ["api", "ui", "tests"],
  [
    async (area) => (await ctx.agent({ agent: "explore", prompt: `Inspect ${area}` })).text,
    async (notes) => (await ctx.agent({ agent: "plan", prompt: `Turn notes into checks:\n${notes}` })).text,
  ],
)
```

### Intermediate Results

Workflows can return any JSON-serializable object. Include intermediate outputs
that the user or later inspection will need, not only the final summary.

```ts
return {
  topic,
  brief: brief.data,
  reviews: reviews.map((item) => item.text),
  summary: summary.text,
}
```

## Authoring Guidelines

- Keep workflows deterministic in structure: agents may produce content, but the workflow should own phase transitions, branching, fan-out limits, and final result shape.
- Prefer a small structured planning step before dynamic branching instead of asking many agents to infer their own scope.
- Log before expensive or long-running steps so `inspect` shows where the run is.
- Keep prompts specific to the step and include only the prior outputs needed for that step.
- Use schemas for machine-readable handoffs; use prose for final user-facing summaries.
- Avoid writing files from a workflow unless the workflow's purpose is explicitly to produce files.
- Return useful data from `run`; do not rely only on logs or agent session history.

## Running

Use the `workflow` tool with `action: "read"` before starting a workflow if the
arguments, phases, or purpose are unclear.

Use the `workflow` tool with `action: "start"` for existing workflows. It asks
for workflow permission, so the user can approve once or allow the workflow
always.

Use foreground mode when the result is needed before continuing. Use
`background: true` when the workflow can run asynchronously; the session will
receive a synthetic completion message when it finishes.

Use the `workflow` tool with `action: "wait"` only when you already have a run
id and need to wait for a running workflow to finish.

## Reviewing Executions

Use the `workflow` tool with `action: "inspect"` to review history and
execution details.

Recommended flow:

1. Use `action: "inspect"` with `view: "summary"` to check status and result.
2. Use `view: "logs"` to read phase logs.
3. Use `view: "agents"` to list subagent runs and ids.
4. Use `view: "agent"` with `agent_id` to read a specific subagent prompt,
   final response, usage, and errors.
5. Use `view: "all"` only when the user needs a complete audit trail.
