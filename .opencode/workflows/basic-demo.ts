import { workflow } from "@opencode-ai/plugin/workflow"

export default workflow({
  name: "basic-demo",
  description: "Small workflow that exercises phases, logs, agents, parallel fan-out, and pipeline stages.",
  phases: ["setup", "agent", "parallel", "pipeline", "summary"],
  arguments: {
    message: {
      type: "string",
      default: "hello from basic-demo",
      description: "Input string used by every step.",
    },
  },

  async run(args, ctx) {
    const message = String(args.message ?? "hello from basic-demo")

    ctx.setPhase("setup")
    ctx.log(`basic-demo started: ${message}`)

    ctx.setPhase("agent")
    const agent = await ctx.agent({
      agent: "general",
      prompt: `Summarize this workflow input in one short sentence: ${message}`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: {
          summary: { type: "string" },
        },
      },
    })
    ctx.log("agent step completed")

    ctx.setPhase("parallel")
    const parallel = await ctx.parallel([
      async () => ({ name: "left", value: `${message} / left` }),
      async () => ({ name: "right", value: `${message} / right` }),
    ])
    ctx.log("parallel step completed")

    ctx.setPhase("pipeline")
    const pipeline = await ctx.pipeline(
      [message, message.toUpperCase()],
      async (item) => item.trim(),
      async (trimmed, original) => ({ original, trimmed, length: trimmed.length }),
    )
    ctx.log("pipeline step completed")

    ctx.setPhase("summary")
    ctx.log("basic-demo completed")
    return {
      message,
      agent: agent.data ?? agent.text,
      parallel,
      pipeline,
    }
  },
})
