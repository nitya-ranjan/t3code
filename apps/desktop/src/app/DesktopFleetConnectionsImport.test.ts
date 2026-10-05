import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EMPTY_CONNECTION_CATALOG_DOCUMENT } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import { importFleetConnections, mergeFleetConnections } from "./DesktopFleetConnectionsImport.ts";

const entry = (id: string, token: string) => ({
  environmentId: EnvironmentId.make(id),
  label: `server-${id}`,
  httpBaseUrl: `https://${id}.example.ts.net`,
  wsBaseUrl: `wss://${id}.example.ts.net`,
  token,
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fleetFile = (connections: ReadonlyArray<unknown>) => encodeJson({ version: 1, connections });

const makeStore = (initial: string | null, save: "ok" | "unavailable" | "fails" = "ok") =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<string | null>(initial);
    const layer = Layer.succeed(
      DesktopConnectionCatalogStore.DesktopConnectionCatalogStore,
      DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.of({
        get: Ref.get(ref).pipe(Effect.map(Option.fromNullishOr)),
        set: (catalog: string) =>
          save === "ok"
            ? Ref.set(ref, catalog).pipe(Effect.as(true))
            : save === "unavailable"
              ? Effect.succeed(false)
              : Effect.fail(
                  new DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreWriteError({
                    operation: "write-temporary-file",
                    path: "/nowhere",
                    cause: new Error("disk full"),
                  }),
                ),
        clear: Ref.set(ref, null),
      }),
    );
    return { ref, layer };
  });

const withStateDir = <A, E>(
  f: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    return yield* f(dir);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("mergeFleetConnections", () => {
  it("adds a bearer target, profile and credential per entry", () => {
    const doc = mergeFleetConnections(undefined, [entry("e1", "t1")]);
    assert.strictEqual(doc.targets.length, 1);
    assert.strictEqual(doc.profiles.length, 1);
    assert.strictEqual(doc.credentials.length, 1);
    assert.strictEqual(doc.credentials[0]!.connectionId, "bearer:e1");
  });

  it("replaces an existing entry for the same environment (token rotation)", () => {
    const first = mergeFleetConnections(undefined, [entry("e1", "old"), entry("e2", "t2")]);
    const second = mergeFleetConnections(first, [entry("e1", "new")]);
    assert.strictEqual(second.targets.length, 2);
    const cred = second.credentials.find((c) => c.connectionId === "bearer:e1")!;
    assert.strictEqual(cred.credential.token, "new");
  });

  it("preserves a hand-paired route while making the fleet route preferred", () => {
    const handPaired = (id: string) => {
      const environmentId = EnvironmentId.make(id);
      const connectionId = `paired-${id}`;
      return {
        target: new BearerConnectionTarget({ environmentId, label: "paired", connectionId }),
        profile: new BearerConnectionProfile({
          connectionId,
          environmentId,
          label: "paired",
          httpBaseUrl: "https://old.example",
          wsBaseUrl: "wss://old.example",
        }),
        credential: {
          connectionId,
          credential: new BearerConnectionCredential({ token: `paired-token-${id}` }),
        },
      };
    };
    const e1 = handPaired("e1");
    const e2 = handPaired("e2");
    const paired = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [e1.target, e2.target],
      profiles: [e1.profile, e2.profile],
      credentials: [e1.credential, e2.credential],
    };
    const merged = mergeFleetConnections(paired, [entry("e1", "fleet-token")]);
    const forEnv = (id: string) => ({
      targets: merged.targets.filter((x) => x.environmentId === id),
      profiles: merged.profiles.filter((x) => x.environmentId === id),
    });
    const fleet = forEnv("e1");
    assert.strictEqual(fleet.targets.length, 2);
    assert.strictEqual(fleet.profiles.length, 2);
    assert.strictEqual((fleet.targets[0] as BearerConnectionTarget).connectionId, "bearer:e1");
    assert.deepStrictEqual(fleet.targets[1], e1.target);
    assert.includeMembers(
      fleet.profiles.map((p) => p.connectionId),
      ["paired-e1", "bearer:e1"],
    );
    const e1Credentials = merged.credentials.filter((c) => c.connectionId === "bearer:e1");
    assert.strictEqual(e1Credentials.length, 1);
    assert.strictEqual(e1Credentials[0]!.connectionId, "bearer:e1");
    assert.strictEqual(e1Credentials[0]!.credential.token, "fleet-token");

    // The other hand-paired environment is untouched.
    const untouched = forEnv("e2");
    assert.deepStrictEqual(untouched.targets, [e2.target]);
    assert.deepStrictEqual(untouched.profiles, [e2.profile]);
    assert.deepStrictEqual(
      merged.credentials.filter((c) => c.connectionId === "paired-e2"),
      [e2.credential],
    );
    assert.strictEqual(merged.credentials.length, 3);
  });

  it("keeps relay routes and the environment's disabled state on token rotation", () => {
    const environmentId = EnvironmentId.make("e1");
    const relay = new RelayConnectionTarget({ environmentId, label: "Relay" });
    const first = mergeFleetConnections(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        targets: [relay],
        disabledEnvironmentIds: [environmentId],
      },
      [entry("e1", "old")],
    );
    const updated = mergeFleetConnections(first, [entry("e1", "new")]);
    assert.deepStrictEqual(updated.targets, first.targets);
    assert.deepStrictEqual(updated.disabledEnvironmentIds, [environmentId]);
    assert.strictEqual(updated.credentials.length, 1);
    assert.strictEqual(updated.credentials[0]!.credential.token, "new");
  });

  it("keeps one connection per environment when the file repeats it (last wins)", () => {
    const merged = mergeFleetConnections(undefined, [entry("e1", "first"), entry("e1", "second")]);
    assert.strictEqual(merged.targets.length, 1);
    assert.strictEqual(merged.profiles.length, 1);
    assert.strictEqual(merged.credentials.length, 1);
    assert.strictEqual(merged.credentials[0]!.credential.token, "second");
  });
});

describe("importFleetConnections", () => {
  it.effect("imports, writes a token-free ledger and removes the file", () =>
    withStateDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dir, "fleet-connections.json");
        yield* fs.writeFileString(file, fleetFile([entry("e1", "SECRET")]));
        const store = yield* makeStore(null);
        const result = yield* importFleetConnections(dir).pipe(Effect.provide(store.layer));
        assert.deepStrictEqual(result, { _tag: "Imported", count: 1 });
        assert.isFalse(yield* fs.exists(file));
        const ledger = yield* fs.readFileString(path.join(dir, "fleet-connections.imported.json"));
        assert.notInclude(ledger, "SECRET");
        assert.include(ledger, '"environmentId": "e1"');
        assert.include((yield* Ref.get(store.ref))!, "SECRET");
      }),
    ),
  );

  it.effect("leaves a malformed file in place and changes nothing", () =>
    withStateDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dir, "fleet-connections.json");
        yield* fs.writeFileString(file, "{ not json");
        const store = yield* makeStore(null);
        const result = yield* importFleetConnections(dir).pipe(Effect.provide(store.layer));
        assert.strictEqual(result._tag, "Invalid");
        assert.isTrue(yield* fs.exists(file));
        assert.isNull(yield* Ref.get(store.ref));
      }),
    ),
  );

  it.effect("skips individual bad entries", () =>
    withStateDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(
          path.join(dir, "fleet-connections.json"),
          fleetFile([entry("e1", "t"), { environmentId: "e2" }]),
        );
        const store = yield* makeStore(null);
        const result = yield* importFleetConnections(dir).pipe(Effect.provide(store.layer));
        assert.deepStrictEqual(result, { _tag: "Imported", count: 1 });
      }),
    ),
  );

  it.effect("keeps the file when encryption is unavailable", () =>
    withStateDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dir, "fleet-connections.json");
        yield* fs.writeFileString(file, fleetFile([entry("e1", "t")]));
        const store = yield* makeStore(null, "unavailable");
        const result = yield* importFleetConnections(dir).pipe(Effect.provide(store.layer));
        assert.deepStrictEqual(result, { _tag: "EncryptionUnavailable" });
        assert.isTrue(yield* fs.exists(file));
      }),
    ),
  );

  it.effect("keeps the file and the catalog when the existing catalog cannot be decoded", () =>
    withStateDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dir, "fleet-connections.json");
        yield* fs.writeFileString(file, fleetFile([entry("e1", "t")]));
        const store = yield* makeStore("{ corrupt catalog");
        const result = yield* importFleetConnections(dir).pipe(Effect.provide(store.layer));
        assert.strictEqual(result._tag, "CatalogUnreadable");
        assert.isTrue(yield* fs.exists(file));
        assert.strictEqual(yield* Ref.get(store.ref), "{ corrupt catalog");
      }),
    ),
  );

  it.effect("skips an entry with a blank environment id and still removes the file", () =>
    withStateDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dir, "fleet-connections.json");
        yield* fs.writeFileString(
          file,
          fleetFile([{ ...entry("e1", "t"), environmentId: "" }, entry("e2", "t2")]),
        );
        const store = yield* makeStore(null);
        const result = yield* importFleetConnections(dir).pipe(Effect.provide(store.layer));
        assert.deepStrictEqual(result, { _tag: "Imported", count: 1 });
        assert.isFalse(yield* fs.exists(file));
      }),
    ),
  );

  it.effect("writes one ledger row per environment when the file repeats it", () =>
    withStateDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(
          path.join(dir, "fleet-connections.json"),
          fleetFile([entry("e1", "first"), entry("e1", "second")]),
        );
        const store = yield* makeStore(null);
        const result = yield* importFleetConnections(dir).pipe(Effect.provide(store.layer));
        assert.deepStrictEqual(result, { _tag: "Imported", count: 1 });
        const ledger = yield* fs.readFileString(path.join(dir, "fleet-connections.imported.json"));
        assert.strictEqual(ledger.split('"environmentId": "e1"').length - 1, 1);
      }),
    ),
  );

  it.effect("keeps earlier ledger rows for other environments", () =>
    withStateDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dir, "fleet-connections.json");
        const ledgerPath = path.join(dir, "fleet-connections.imported.json");
        const store = yield* makeStore(null);
        yield* fs.writeFileString(file, fleetFile([entry("e1", "t1")]));
        yield* importFleetConnections(dir).pipe(Effect.provide(store.layer));
        yield* fs.writeFileString(file, fleetFile([entry("e2", "t2")]));
        const result = yield* importFleetConnections(dir).pipe(Effect.provide(store.layer));
        assert.deepStrictEqual(result, { _tag: "Imported", count: 1 });
        const ledger = yield* fs.readFileString(ledgerPath);
        assert.include(ledger, '"environmentId": "e1"');
        assert.include(ledger, '"environmentId": "e2"');
      }),
    ),
  );

  it.effect("reports a failed save separately from missing encryption and keeps the file", () =>
    withStateDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dir, "fleet-connections.json");
        yield* fs.writeFileString(file, fleetFile([entry("e1", "SECRET")]));
        const store = yield* makeStore(null, "fails");
        const result = yield* importFleetConnections(dir).pipe(Effect.provide(store.layer));
        assert.strictEqual(result._tag, "SaveFailed");
        assert.notInclude(encodeJson(result), "SECRET");
        assert.isTrue(yield* fs.exists(file));
      }),
    ),
  );

  it.effect("does nothing when there is no file", () =>
    withStateDir((dir) =>
      Effect.gen(function* () {
        const store = yield* makeStore(null);
        assert.deepStrictEqual(
          yield* importFleetConnections(dir).pipe(Effect.provide(store.layer)),
          { _tag: "NoFile" },
        );
      }),
    ),
  );
});
