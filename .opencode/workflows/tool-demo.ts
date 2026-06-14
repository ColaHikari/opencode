import { workflow } from "@opencode-ai/plugin/workflow"

export default workflow({
  name: "tool-demo",
  description: "Demonstrate calling an opencode tool directly from a workflow.",
  phases: ["read", "summary"],

  async run(args, ctx) {
    ctx.setPhase("read")
    const readme = await ctx.tool("read", { filePath: "AGENTS.md", limit: 40 })
    ctx.log("read tool completed")

    ctx.setPhase("summary")
    return {
      bytes: readme.output.length,
      preview: readme.output.slice(0, 200),
      truncated: readme.metadata?.truncated,
    }
  },
})
