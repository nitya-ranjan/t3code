/**
 * Test helpers for constructing a `ProviderAdapterRegistryShape` mock from a
 * kind-keyed adapter map.
 *
 * @module provider/testUtils/providerAdapterRegistryMock
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";

export type KindAdapterMap = Partial<
  Record<ProviderDriverKind, ProviderAdapterShape<ProviderAdapterError>>
>;

export type InstanceAdapterMap = Partial<
  Record<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>
>;

/**
 * Build a `ProviderAdapterRegistryShape` from a kind-keyed adapter map.
 * Every adapter present in the map is addressable through its default
 * provider instance id. `instances` adds adapters under explicit instance
 * ids, such as two accounts of one driver; each gets its own continuation key.
 */
export const makeAdapterRegistryMock = (
  adapters: KindAdapterMap,
  instances: InstanceAdapterMap = {},
): ProviderAdapterRegistryShape => {
  const byInstanceId = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
  for (const [kind, adapter] of Object.entries(adapters)) {
    if (!adapter) continue;
    const driverKind = ProviderDriverKind.make(kind);
    byInstanceId.set(defaultInstanceIdForDriver(driverKind), adapter);
  }
  for (const [instanceId, adapter] of Object.entries(instances)) {
    if (!adapter) continue;
    byInstanceId.set(ProviderInstanceId.make(instanceId), adapter);
  }

  const getByInstance: ProviderAdapterRegistryShape["getByInstance"] = (instanceId) => {
    const adapter = byInstanceId.get(instanceId);
    return adapter
      ? Effect.succeed(adapter)
      : Effect.fail(
          new ProviderUnsupportedError({
            provider: ProviderDriverKind.make(instanceId),
          }),
        );
  };

  return {
    getByInstance,
    getInstanceInfo: (instanceId) => {
      const adapter = byInstanceId.get(instanceId);
      if (!adapter) {
        return Effect.fail(
          new ProviderUnsupportedError({
            provider: ProviderDriverKind.make(instanceId),
          }),
        );
      }
      return Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(adapter.provider),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(adapter.provider),
          continuationKey: `${adapter.provider}:instance:${instanceId}`,
        },
      });
    },
    listInstances: () => Effect.succeed(Array.from(byInstanceId.keys())),
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};
