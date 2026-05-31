import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260531160000_workflow-runs",
  up(tx) {
    return Effect.gen(function* () {
      if (!(yield* tx.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_run'`))) {
        yield* tx.run(`
          CREATE TABLE \`workflow_run\` (
            \`id\` text PRIMARY KEY,
            \`session_id\` text,
            \`workflow\` text NOT NULL,
            \`status\` text NOT NULL,
            \`started_at\` integer NOT NULL,
            \`completed_at\` integer,
            \`current_phase\` text,
            \`args\` text,
            \`definition\` text,
            \`logs\` text NOT NULL,
            \`agents\` text NOT NULL,
            \`result\` text,
            \`error\` text,
            \`time_created\` integer NOT NULL,
            \`time_updated\` integer NOT NULL
          );
        `)
      }

      const columns = new Set((yield* tx.all<{ name: string }>(`PRAGMA table_info(\`workflow_run\`)`)).map((row) => row.name))
      if (!columns.has("session_id")) yield* tx.run(`ALTER TABLE \`workflow_run\` ADD \`session_id\` text;`)
      if (!columns.has("definition")) yield* tx.run(`ALTER TABLE \`workflow_run\` ADD \`definition\` text;`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`workflow_run_started_at_idx\` ON \`workflow_run\` (\`started_at\`);`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`workflow_run_status_started_at_idx\` ON \`workflow_run\` (\`status\`,\`started_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
