export default { meta: { name: "ping", description: "smoke", phases: ["run"] },
  async run(_a, ctx){ ctx.setPhase("run"); const s = await ctx.shell("echo hi"); return { out: s.output.trim() } } }