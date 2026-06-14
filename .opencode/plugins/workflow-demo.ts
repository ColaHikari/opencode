export default async function WorkflowDemoPlugin() {
  return {
    workflow: {
      "plugin-demo": `export const meta = {
  name: "plugin-demo",
  description: "Demo workflow registered directly by an opencode plugin.",
  arguments: { message: { type: "string", default: "hello from plugin-demo" } },
}

export async function run(args, ctx) {
  const message = String(args.message ?? "hello from plugin-demo")
  ctx.log("plugin-demo received: " + message)
  return { message, source: "plugin" }
}
`,
    },
  }
}
