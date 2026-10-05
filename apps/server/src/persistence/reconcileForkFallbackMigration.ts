import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import ProjectionThreadsFallback from "./Migrations/055_ProjectionThreadsFallback.ts";

// The fork shipped fallback as migration 55 before upstream assigned 55 to V2.
// Execute the missing V2 migration atomically with correcting that ledger entry.
export const reconcileForkFallbackMigration = Effect.fn("reconcileForkFallbackMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
        if (tables.length === 0) return;
        const history = yield* sql<{
          readonly name: string;
        }>`SELECT name FROM effect_sql_migrations WHERE migration_id = 55`;
        if (history[0]?.name !== "ProjectionThreadsFallback") return;
        yield* OrchestrationV2.pipe(
          Effect.mapError(
            (cause) =>
              new Migrator.MigrationError({
                kind: "Failed",
                message: "Unable to migrate fork fallback database to orchestration V2.",
                cause,
              }),
          ),
        );
        yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationV2' WHERE migration_id = 55 AND name = 'ProjectionThreadsFallback'`;
      }),
    );
  },
);

// The V1 import reader preserves this fork-only column. Fresh upstream and V2
// databases need the nullable column too; it never changes existing values.
export const ensureLegacyFallbackColumn = Effect.fn("ensureLegacyFallbackColumn")(function* () {
  yield* ProjectionThreadsFallback;
});
