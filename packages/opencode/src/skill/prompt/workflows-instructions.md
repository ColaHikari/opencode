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

Prefer the typed helper:

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

## Temporary Workflows

Use the `workflow` tool with `action: "run_temporary"` for one-shot automation
that should not leave a workflow file behind. The temporary source file is
removed after launch, but the source is preserved in workflow history for audit
and debugging.

Do not use temporary workflows as a substitute for normal tool calls. They are
appropriate when the user wants a short-lived orchestration that uses workflow
features such as phases, logs, parallel agents, or structured final review.
