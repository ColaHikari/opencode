import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: string[] = []
const syncedDirectories: string[] = []
const workflowStarts: Array<{ name: string; directory?: string; args?: Record<string, unknown>; permission?: string }> =
  []
const promptParts: Array<Array<{ type: string; text?: string }>> = []
let dashboardOpened = 0
let workflowListData: Array<{ name: string; valid?: boolean; meta: { name: string; arguments?: any } }> = []
let workflowStartSessionId: string | undefined

let params: { id?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let ultracodeSession = false
let keywordEnabled = true

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      create: async () => {
        createdSessions.push(directory)
        return {
          data: {
            id: `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
          },
        }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async (input: { parts: Array<{ type: string; text?: string }> }) => {
        promptParts.push(input.parts)
        return { data: undefined }
      },
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    workflow: {
      list: async () => ({ data: workflowListData }),
      start: async (input: { name: string; directory?: string; workflowStartPayload?: any }) => {
        workflowStarts.push({
          name: input.name,
          directory: input.directory,
          args: input.workflowStartPayload?.args,
          permission: input.workflowStartPayload?.permissionSessionID,
        })
        return { data: { id: "run-1", session_id: workflowStartSessionId } }
      },
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: () => 0,
  }))

  mock.module("@/utils/toast", () => ({
    showToast: () => 0,
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({
      current: () => promptValue,
      reset: () => undefined,
      set: () => undefined,
      context: {
        add: () => undefined,
        remove: () => undefined,
        items: () => [],
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: {
        command: [],
        config: { workflows: { ultracode_keyword: keywordEnabled } },
      },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => ({
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  params = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  workflowStarts.length = 0
  promptParts.length = 0
  dashboardOpened = 0
  workflowListData = []
  workflowStartSessionId = undefined
  selected = "/repo/worktree-a"
  variant = undefined
  ultracodeSession = false
  keywordEnabled = true
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      ultracodeSession: () => false,
      openWorkflowDashboard: () => undefined,
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      ultracodeSession: () => false,
      openWorkflowDashboard: () => undefined,
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      ultracodeSession: () => false,
      openWorkflowDashboard: () => undefined,
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      ultracodeSession: () => false,
      openWorkflowDashboard: () => undefined,
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toEqual([{ id: "session-1", title: "New session 1" }])
    expect(optimisticSeeded).toEqual([true])
  })
})

const event = { preventDefault: () => undefined } as unknown as Event

// handleSubmit fires the prompt send / workflow start as a floating promise and
// returns before it settles. Flush several microtask + macrotask ticks so the
// floating async work (list → start, or buildRequestParts → promptAsync) lands
// before assertions.
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const workflowInput = () => ({
  info: () => ({ id: "session-1" }),
  imageAttachments: () => [],
  commentCount: () => 0,
  autoAccept: () => false,
  mode: () => "normal" as const,
  ultracodeSession: () => ultracodeSession,
  openWorkflowDashboard: () => {
    dashboardOpened += 1
  },
  working: () => false,
  editor: () => undefined,
  queueScroll: () => undefined,
  promptLength: (value: Prompt) =>
    value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
  addToHistory: () => undefined,
  resetHistoryNavigation: () => undefined,
  setMode: () => undefined,
  setPopover: () => undefined,
  onSubmit: () => undefined,
})

describe("workflow command routing on submit", () => {
  test("/workflows opens the dashboard and never sends a prompt", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "/workflows", start: 0, end: 10 }]
    const submit = createPromptSubmit(workflowInput())

    await submit.handleSubmit(event)

    await flush()

    expect(dashboardOpened).toBe(1)
    expect(workflowStarts).toEqual([])
    expect(promptParts).toEqual([])
  })

  test("/workflow with no name opens the dashboard", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "/workflow", start: 0, end: 9 }]
    const submit = createPromptSubmit(workflowInput())

    await submit.handleSubmit(event)

    await flush()

    expect(dashboardOpened).toBe(1)
    expect(workflowStarts).toEqual([])
  })

  test("/workflow <name> starts the run with declared-type-coerced args", async () => {
    params = { id: "session-1" }
    workflowListData = [{ name: "review", valid: true, meta: { name: "review", arguments: { count: { type: "number" } } } }]
    promptValue = [{ type: "text", content: "/workflow review count=3 tag=v1.0", start: 0, end: 33 }]
    const submit = createPromptSubmit(workflowInput())

    await submit.handleSubmit(event)

    await flush()

    expect(workflowStarts).toHaveLength(1)
    expect(workflowStarts[0]).toMatchObject({
      name: "review",
      directory: "/repo/main",
      args: { count: 3, tag: "v1.0" },
      permission: "session-1",
    })
    expect(promptParts).toEqual([])
  })
})

describe("ultracode injection on submit", () => {
  test("prepends the session directive when session mode is on", async () => {
    params = { id: "session-1" }
    ultracodeSession = true
    promptValue = [{ type: "text", content: "fix the bug", start: 0, end: 11 }]
    const submit = createPromptSubmit(workflowInput())

    await submit.handleSubmit(event)

    await flush()

    expect(promptParts).toHaveLength(1)
    const text = promptParts[0]
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
    expect(text).toContain("Ultracode session mode is ON")
    expect(text).toContain("fix the bug")
  })

  test("strips the keyword and injects the prompt directive when keyword detected", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "ultracode fix the bug", start: 0, end: 21 }]
    const submit = createPromptSubmit(workflowInput())

    await submit.handleSubmit(event)

    await flush()

    const text = promptParts[0]
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
    expect(text).toContain("opted into workflow orchestration")
    expect(text).toContain("fix the bug")
    // The directive legitimately mentions "(ultracode)"; the USER's text (the
    // trailing segment after the directive's blank-line separator) is stripped.
    const userText = text.split("\n\n").at(-1) ?? ""
    expect(userText).toBe("fix the bug")
    expect(userText).not.toMatch(/\bultracode\b/i)
  })

  test("does not inject when the config keyword flag is off and session mode is off", async () => {
    params = { id: "session-1" }
    keywordEnabled = false
    promptValue = [{ type: "text", content: "ultracode fix the bug", start: 0, end: 21 }]
    const submit = createPromptSubmit(workflowInput())

    await submit.handleSubmit(event)

    await flush()

    const text = promptParts[0]
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
    expect(text).toContain("ultracode fix the bug")
    expect(text).not.toContain("opted into workflow orchestration")
  })
})
