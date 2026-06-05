import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

type Definition = {
  name: string
  path: string
  meta: {
    name: string
    description?: string
    phases?: string[]
    arguments?: Record<string, { type?: string; default?: unknown; description?: string }>
  }
  source?: string
  temporary?: boolean
}

type LogEntry = {
  time: number
  phase?: string
  message: string
}

type AgentRun = {
  id: string
  status: "running" | "completed" | "failed"
  started_at: number
  completed_at?: number
  phase?: string
  agent?: string
  model?: string
  session_id?: string
  message_id?: string
  prompt: string
  output?: string
  cost?: number
  tokens?: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  error?: string
}

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().primaryKey(),
    session_id: text(),
    workflow: text().notNull(),
    status: text().$type<"running" | "completed" | "failed" | "cancelled" | "interrupted">().notNull(),
    started_at: integer().notNull(),
    completed_at: integer(),
    current_phase: text(),
    args: text({ mode: "json" }).$type<Record<string, unknown>>(),
    definition: text({ mode: "json" }).$type<Definition>(),
    logs: text({ mode: "json" }).notNull().$type<LogEntry[]>(),
    agents: text({ mode: "json" }).notNull().$type<AgentRun[]>(),
    result: text({ mode: "json" }).$type<unknown>(),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_run_started_at_idx").on(table.started_at),
    index("workflow_run_status_started_at_idx").on(table.status, table.started_at),
  ],
)
