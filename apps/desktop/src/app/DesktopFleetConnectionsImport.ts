// Fleet-only (nitya fork): lets t3-fleet add saved servers without pairing links.
// The catalog is encrypted with safeStorage and has no external API, so the deploy
// tool drops a 0600 file that we fold into the catalog on startup and then delete,
// keeping a token-free ledger of what was imported.
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";

const FleetConnection = Schema.Struct({
  // A blank or untrimmed id fails here, so that one entry is skipped instead of the import.
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  token: Schema.String,
});
type FleetConnection = typeof FleetConnection.Type;
const decodeFleetConnection = Schema.decodeUnknownOption(FleetConnection);

/** One entry per environment; the last one in the file wins. */
const dedupeByEnvironment = (entries: readonly FleetConnection[]): FleetConnection[] => [
  ...new Map(entries.map((e) => [e.environmentId, e])).values(),
];
// Entries are decoded one by one so a single bad entry does not reject the whole file.
const decodeFleetFile = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), connections: Schema.Array(Schema.Unknown) }),
  ),
);

const LedgerJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    connections: Schema.Array(
      Schema.Struct({
        environmentId: Schema.String,
        label: Schema.String,
        httpBaseUrl: Schema.String,
        importedAt: Schema.String,
      }),
    ),
  }),
  { space: 2 },
);
const decodeLedger = Schema.decodeEffect(LedgerJson);
const encodeLedger = Schema.encodeEffect(LedgerJson);

const CatalogJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeCatalog = Schema.decodeEffect(CatalogJson);
const encodeCatalog = Schema.encodeEffect(CatalogJson);

export type ImportResult =
  | { readonly _tag: "NoFile" }
  | { readonly _tag: "Imported"; readonly count: number }
  | { readonly _tag: "Invalid"; readonly reason: string }
  | { readonly _tag: "CatalogUnreadable"; readonly reason: string }
  | { readonly _tag: "EncryptionUnavailable" }
  | { readonly _tag: "SaveFailed"; readonly reason: string };

const fleetConnectionId = (environmentId: string) => `bearer:${environmentId}`;

/**
 * Replaces every saved connection for each imported environment (fleet-imported or
 * hand-paired under any connection id) with one bearer target, profile and credential.
 */
export function mergeFleetConnections(
  doc: ConnectionCatalogDocument | undefined,
  fleetEntries: readonly FleetConnection[],
): ConnectionCatalogDocument {
  const entries = dedupeByEnvironment(fleetEntries);
  const base = doc ?? EMPTY_CONNECTION_CATALOG_DOCUMENT;
  const environments = new Set<string>(entries.map((e) => e.environmentId));
  const replaced = (x: { readonly environmentId: string }) => environments.has(x.environmentId);
  // Credentials carry no environment id, so drop those whose connection we replace.
  const droppedConnectionIds = new Set([
    ...entries.map((e) => fleetConnectionId(e.environmentId)),
    ...base.targets.flatMap((t) => (replaced(t) && "connectionId" in t ? [t.connectionId] : [])),
    ...base.profiles.flatMap((p) => (replaced(p) ? [p.connectionId] : [])),
  ]);
  return {
    ...base,
    targets: [
      ...base.targets.filter((t) => !replaced(t)),
      ...entries.map(
        (e) =>
          new BearerConnectionTarget({
            environmentId: e.environmentId,
            label: e.label,
            connectionId: fleetConnectionId(e.environmentId),
          }),
      ),
    ],
    profiles: [
      ...base.profiles.filter((p) => !replaced(p)),
      ...entries.map(
        (e) =>
          new BearerConnectionProfile({
            connectionId: fleetConnectionId(e.environmentId),
            environmentId: e.environmentId,
            label: e.label,
            httpBaseUrl: e.httpBaseUrl,
            wsBaseUrl: e.wsBaseUrl,
          }),
      ),
    ],
    credentials: [
      ...base.credentials.filter((c) => !droppedConnectionIds.has(c.connectionId)),
      ...entries.map((e) => ({
        connectionId: fleetConnectionId(e.environmentId),
        credential: new BearerConnectionCredential({ token: e.token }),
      })),
    ],
  };
}

export const importFleetConnections = Effect.fn("desktop.fleetConnections.import")(function* (
  stateDir: string,
): Effect.fn.Return<
  ImportResult,
  never,
  FileSystem.FileSystem | Path.Path | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const file = path.join(stateDir, "fleet-connections.json");
  const ledgerPath = path.join(stateDir, "fleet-connections.imported.json");

  const raw = yield* fs.readFileString(file).pipe(Effect.option);
  if (Option.isNone(raw)) return { _tag: "NoFile" };

  const fleetFile = yield* decodeFleetFile(raw.value).pipe(Effect.result);
  // Fixed reasons only: parse errors can quote the file, and the file holds tokens.
  if (fleetFile._tag === "Failure") {
    return { _tag: "Invalid", reason: "expected a {version: 1, connections: [...]} JSON document" };
  }
  const entries = dedupeByEnvironment(
    fleetFile.success.connections.flatMap((item) => Option.toArray(decodeFleetConnection(item))),
  );
  if (entries.length === 0) return { _tag: "Invalid", reason: "no valid connections" };

  // An unreadable catalog must not be overwritten with only the fleet entries, which
  // would silently drop hand-paired servers; keep the file and retry next start.
  const current = yield* store.get.pipe(Effect.result);
  if (current._tag === "Failure") {
    return { _tag: "CatalogUnreadable", reason: current.failure.message };
  }
  let doc: ConnectionCatalogDocument | undefined;
  if (Option.isSome(current.success)) {
    const decoded = yield* decodeCatalog(current.success.value).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      return { _tag: "CatalogUnreadable", reason: "existing catalog does not match the schema" };
    }
    doc = decoded.success;
  }
  // A SchemaError could quote catalog values (credentials) into logs; keep only a fixed message.
  const encoded = yield* encodeCatalog(mergeFleetConnections(doc, entries)).pipe(
    Effect.mapError(() => new Error("could not encode the merged connection catalog")),
    Effect.orDie,
  );
  const saved = yield* store.set(encoded).pipe(Effect.result);
  if (saved._tag === "Failure") {
    return { _tag: "SaveFailed", reason: "could not write the connection catalog" };
  }
  if (!saved.success) return { _tag: "EncryptionUnavailable" };

  const previous = yield* fs.readFileString(ledgerPath).pipe(
    Effect.flatMap(decodeLedger),
    Effect.map((ledger) => ledger.connections),
    Effect.orElseSucceed(() => []),
  );
  const importedAt = DateTime.formatIso(yield* DateTime.now);
  const fresh = new Set<string>(entries.map((e) => e.environmentId));
  const ledger = yield* encodeLedger({
    version: 1,
    connections: [
      ...previous.filter((c) => !fresh.has(c.environmentId)),
      ...entries.map((e) => ({
        environmentId: e.environmentId,
        label: e.label,
        httpBaseUrl: e.httpBaseUrl,
        importedAt,
      })),
    ],
  }).pipe(Effect.orDie);
  yield* fs.writeFileString(ledgerPath, `${ledger}\n`).pipe(Effect.orDie);
  yield* fs.remove(file).pipe(Effect.orDie);
  return { _tag: "Imported", count: entries.length };
});
