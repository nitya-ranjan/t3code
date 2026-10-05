import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import ProjectionThreadsFallback from "./Migrations/055_ProjectionThreadsFallback.ts";

const fallbackJson = JSON.stringify({
  chainId: "work",
  status: "waiting",
  paused: true,
  resumeAt: "2026-10-06T12:00:00.000Z",
  waitingSince: "2026-10-05T12:00:00.000Z",
  candidateInstanceId: "claude_personal",
  triedInstanceIds: ["claude_work"],
  handoffTimes: ["2026-10-05T11:00:00.000Z"],
  continuedFromThreadId: "previous-thread",
  continuedToThreadId: null,
});

const seedReleasedFork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "55_ProjectionThreadsFallback": ProjectionThreadsFallback }),
  });
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      created_at, updated_at, fallback_json
    ) VALUES (
      'fork-thread', 'fork-project', 'Existing fork conversation',
      '{"instanceId":"claude_work","model":"claude-sonnet-4-6"}', 'full-access',
      '2026-10-05T12:00:00.000Z', '2026-10-05T12:00:00.000Z', ${fallbackJson}
    )
  `;
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-10-01 00:00:00' WHERE migration_id = 55
  `;
});

describe("released fork fallback migration compatibility", () => {
  it.effect(
    "installs V2 despite the fork's existing migration 55 and preserves data across restarts",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedReleasedFork;
        const threads = yield* sql`SELECT * FROM projection_threads`;
        yield* runMigrations();
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM projection_threads`, threads);
        assert.deepStrictEqual(
          yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 55`,
          [{ created_at: "2026-10-01 00:00:00" }],
        );
        // A persisted V2 import record proves the schema exists and a later
        // startup neither reruns the creation migration nor clears its state.
        yield* sql`
        INSERT INTO orchestration_v2_legacy_imports
          (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
        VALUES ('fork-thread', '2026-10-05', '2026-10-05', '2026-10-05', 7)
      `;
        const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
        assert.deepStrictEqual(yield* sql`SELECT * FROM projection_threads`, threads);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "rolls back V2 schema and ledger together on failure and can retry without data loss",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedReleasedFork;
        const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const threads = yield* sql`SELECT * FROM projection_threads`;
        yield* sql`
        CREATE TRIGGER fail_fork_upgrade BEFORE UPDATE ON effect_sql_migrations
        WHEN NEW.migration_id = 55 AND NEW.name = 'OrchestrationV2'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
        assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          history,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM projection_threads`, threads);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'`,
          [],
        );
        yield* sql`DROP TRIGGER fail_fork_upgrade`;
        yield* runMigrations();
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 55`,
          [{ name: "OrchestrationV2" }],
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM projection_threads`, threads);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
