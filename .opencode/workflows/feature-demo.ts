export const meta = {
  name: "feature-demo",
  description: "Exercise core opencode workflow features for manual testing, excluding budget.",
  whenToUse: "Run this when you want to see workflow phases, logs, shell commands, parallel/pipeline execution, nested workflows, optional agents, and optional questions.",
  phases: [
    { title: "setup", detail: "Read args and log startup" },
    { title: "cmd", detail: "Run deterministic shell commands" },
    { title: "fanout", detail: "Exercise ctx.parallel" },
    { title: "pipeline", detail: "Exercise ctx.pipeline" },
    { title: "nested", detail: "Exercise ctx.workflow" },
    { title: "agent", detail: "Optionally dispatch ctx.agent" },
    { title: "question", detail: "Optionally wait for ctx.question" },
    { title: "summary", detail: "Return a combined result" },
  ],
  arguments: {
    message: { type: "string", default: "hello workflow", description: "Message used by shell, pipeline, and optional agent prompts." },
    runAgent: { type: "string", default: "no", description: "Set to yes to run ctx.agent and produce a structured response." },
    askQuestion: { type: "string", default: "no", description: "Set to yes to call ctx.question near the end. The run pauses if unanswered before questionTimeout." },
    questionTimeout: { type: "string", default: "600000", description: "Question timeout in milliseconds when askQuestion=yes." },
    runNested: { type: "string", default: "yes", description: "Set to no to skip the feature-demo-child nested workflow." },
  },
}

export async function run(args, ctx) {
  const message = String(args.message ?? "hello workflow")
  const runAgent = String(args.runAgent ?? "no").toLowerCase() === "yes"
  const askQuestion = String(args.askQuestion ?? "no").toLowerCase() === "yes"
  const runNested = String(args.runNested ?? "yes").toLowerCase() !== "no"
  const questionTimeout = Number(args.questionTimeout ?? 600000)

  ctx.setPhase("setup")
  ctx.log("feature-demo started")
  ctx.log(`message=${message}`)

  ctx.setPhase("cmd")
  const pwd = await ctx.shell("pwd")
  const echo = await ctx.shell(`printf '%s' ${shellQuote(message)}`)
  const nonZero = await ctx.shell("exit 7")
  ctx.log("shell commands completed")

  ctx.setPhase("fanout")
  const parallel = await ctx.parallel(
    ["alpha", "beta", "gamma"].map((label) => async () => {
      const result = await ctx.shell(`printf '${label}:%s' ${shellQuote(message)}`)
      return { label, output: result.output.trim(), exitCode: result.exitCode }
    }),
    { concurrencyLimit: 2 },
  )
  ctx.log("parallel tasks completed")

  ctx.setPhase("pipeline")
  const pipeline = await ctx.pipeline(
    [message, message.toUpperCase()],
    async (item) => item.trim(),
    async (trimmed, original) => ({ original, trimmed, length: trimmed.length }),
    { concurrencyLimit: 2 },
  )
  ctx.log("pipeline stages completed")

  ctx.setPhase("nested")
  const child = runNested ? await ctx.workflow("feature-demo-child", { value: message }) : { skipped: true }
  ctx.log("nested workflow step completed")

  ctx.setPhase("agent")
  const agent = runAgent
    ? await ctx.agent({
        agent: "explore",
        prompt: `Summarize this workflow test message in one short sentence: ${message}`,
        tools: { bash: false, edit: false, write: false },
        schema: {
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string" } },
        },
      })
    : { skipped: true }
  ctx.log(runAgent ? "agent step completed" : "agent step skipped; pass runAgent=yes to enable it")

  ctx.setPhase("question")
  const question = askQuestion
    ? await ctx.question({
        question: "Which demo path should the workflow record?",
        options: ["happy", "edge", "skip"],
        timeout: Number.isFinite(questionTimeout) ? questionTimeout : 600000,
      })
    : { skipped: true }
  ctx.log(askQuestion ? "question answered" : "question step skipped; pass askQuestion=yes to enable it")

  ctx.setPhase("summary")
  ctx.log("feature-demo completed")
  return {
    message,
    shell: {
      pwd: pwd.output.trim(),
      echo: echo.output.trim(),
      nonZeroExitCode: nonZero.exitCode,
    },
    parallel,
    pipeline,
    child,
    agent,
    question,
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
