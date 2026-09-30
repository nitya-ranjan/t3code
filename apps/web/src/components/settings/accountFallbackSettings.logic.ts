import {
  type AccountFallbackChain,
  type AccountFallbackSettings,
  FallbackChainId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

/**
 * A readable id for a new chain, stable in settings.json: the name slugged,
 * with `-2`, `-3`, ... appended when another chain already uses it.
 */
export function chainIdFromName(name: string, existing: ReadonlySet<string>): FallbackChainId {
  const slug =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "chain";
  let candidate = slug;
  for (let suffix = 2; existing.has(candidate); suffix += 1) {
    candidate = `${slug}-${suffix}`;
  }
  return FallbackChainId.make(candidate);
}

/** A copy with the entry at `index` swapped toward `direction`; unchanged at either end. */
export function moveInstance<T>(ids: readonly T[], index: number, direction: -1 | 1): T[] {
  const next = [...ids];
  const target = index + direction;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** "Claude Work → Claude Personal → Codex"; an id with no label shows as itself. */
export function describeChain(
  chain: Pick<AccountFallbackChain, "instanceIds">,
  instanceLabels: ReadonlyMap<string, string>,
): string {
  return chain.instanceIds.map((id) => instanceLabels.get(id) ?? id).join(" → ");
}

/** Chain entries that no longer name a configured provider instance. */
export function unknownInstanceIds(
  chain: Pick<AccountFallbackChain, "instanceIds">,
  known: ReadonlySet<string>,
): string[] {
  return chain.instanceIds.filter((id) => !known.has(id));
}

/**
 * The patch that deletes a chain. `accountFallback` replaces the whole object
 * on write, so the rest of it is carried over; an environment default naming
 * the chain is turned off in the same write.
 */
export function withoutChain(
  settings: {
    readonly accountFallback: AccountFallbackSettings;
    readonly accountFallbackChainId: FallbackChainId | null;
  },
  chainId: FallbackChainId,
): ServerSettingsPatch {
  const { [chainId]: _removed, ...chains } = settings.accountFallback.chains;
  return {
    accountFallback: { ...settings.accountFallback, chains },
    ...(settings.accountFallbackChainId === chainId ? { accountFallbackChainId: null } : {}),
  };
}
