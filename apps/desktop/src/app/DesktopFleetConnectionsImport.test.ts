import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
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
  environmentId: id,
  label: `server-${id}`,
  httpBaseUrl: `https://${id}.example.ts.net`,
  wsBaseUrl: `wss://${id}.example.ts.net`,
  token,
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fleetFile = (connections: ReadonlyArray<unknown>) => encodeJson({ version: 1, connections });

const makeStore = (initial: string | null, encryption = true) =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<string | null>(initial);
    const layer = Layer.succeed(
      DesktopConnectionCatalogStore.DesktopConnectionCatalogStore,
      DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.of({
        get: Ref.get(ref).pipe(Effect.map(Option.fromNullishOr)),
        set: (catalog: string) =>
          encryption ? Ref.set(ref, catalog).pipe(Effect.as(true)) : Effect.succeed(false),
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

  it("replaces a hand-paired connection for the same environment under another connection id", () => {
    const environmentId = EnvironmentId.make("e1");
    const paired = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [
        new BearerConnectionTarget({ environmentId, label: "paired", connectionId: "paired-xyz" }),
      ],
      profiles: [
        new BearerConnectionProfile({
          connectionId: "paired-xyz",
          environmentId,
          label: "paired",
          httpBaseUrl: "https://old.example",
          wsBaseUrl: "wss://old.example",
        }),
      ],
      credentials: [
        {
          connectionId: "paired-xyz",
          credential: new BearerConnectionCredential({ token: "paired-token" }),
        },
      ],
    };
    const merged = mergeFleetConnections(paired, [entry("e1", "fleet-token")]);
    const forE1 = <T extends { environmentId: string }>(xs: readonly T[]) =>
      xs.filter((x) => x.environmentId === "e1");
    const targets = forE1(merged.targets);
    const profiles = forE1(merged.profiles);
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(profiles.length, 1);
    assert.strictEqual(merged.credentials.length, 1);
    assert.strictEqual((targets[0] as BearerConnectionTarget).connectionId, "bearer:e1");
    assert.strictEqual(profiles[0]!.connectionId, "bearer:e1");
    assert.strictEqual(merged.credentials[0]!.connectionId, "bearer:e1");
    assert.strictEqual(merged.credentials[0]!.credential.token, "fleet-token");
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
        const store = yield* makeStore(null, false);
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
