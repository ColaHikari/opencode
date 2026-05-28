import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { AgentRun, LogEntry, Status } from "./workflow"

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().primaryKey(),
    session_id: text(),
    workflow: text().notNull(),
    status: text().$type<Status>().notNull(),
    started_at: integer().notNull(),
    completed_at: integer(),
    current_phase: text(),
    args: text({ mode: "json" }).$type<Record<string, unknown>>(),
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
