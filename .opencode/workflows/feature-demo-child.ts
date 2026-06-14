export const meta = {
  name: "feature-demo-child",
  description: "Child workflow used by feature-demo to exercise ctx.workflow nesting.",
  phases: ["child"],
  arguments: {
    value: { type: "string", default: "from-parent", description: "Value echoed by the child workflow." },
  },
}

export async function run(args, ctx) {
  ctx.setPhase("child")
  ctx.log("feature-demo-child started")
  const shell = await ctx.shell("printf 'child-shell-ok'")
  ctx.log("feature-demo-child completed")
  return {
    childValue: String(args.value ?? ""),
    shellOutput: shell.output.trim(),
    shellExitCode: shell.exitCode,
  }
}
