import {
  type AccountFallbackChain,
  type EnvironmentId,
  FallbackChainId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  chainIdFromName,
  describeChain,
  moveInstance,
  unknownInstanceIds,
  withoutChain,
} from "./accountFallbackSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// Chain ids are slugs, so a leading colon cannot collide with one.
const NO_CHAIN = ":none";

export interface FallbackInstanceOption {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}

interface EditingChain {
  readonly id: FallbackChainId | null;
  readonly chain: AccountFallbackChain | null;
}

/**
 * Fallback chains for one environment: the ordered provider instances a thread
 * moves through when one runs out of usage. `accountFallback` is replaced
 * whole on every write, so each edit sends the full object.
 */
export function AccountFallbackSettings({
  environmentId,
  instances,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instances: readonly FallbackInstanceOption[];
  readonly readOnly: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const accountFallback = settings.accountFallback;
  const defaultChainId = settings.accountFallbackChainId;
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [editing, setEditing] = useState<EditingChain | null>(null);
  const instanceLabels = new Map<string, string>(
    instances.map((instance) => [instance.instanceId, instance.label]),
  );
  const knownIds = new Set<string>(instances.map((instance) => instance.instanceId));
  const chains = Object.entries(accountFallback.chains) as [
    FallbackChainId,
    AccountFallbackChain,
  ][];

  const saveChain = (id: FallbackChainId, chain: AccountFallbackChain) =>
    updateSettings({
      accountFallback: { ...accountFallback, chains: { ...accountFallback.chains, [id]: chain } },
    });

  return (
    <>
      <SettingsSection
        {...searchableSetting("fallback-chains")}
        headerAction={
          !readOnly ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => setEditing({ id: null, chain: null })}
            >
              <PlusIcon className="size-3" aria-hidden />
              Add chain
            </Button>
          ) : null
        }
      >
        {chains.length === 0 ? (
          <SettingsRow
            title="No fallback chains."
            description="A chain lists accounts in order. When one runs out of usage, the thread continues on the next."
          />
        ) : (
          chains.map(([id, chain]) => {
            const unknown = unknownInstanceIds(chain, knownIds);
            return (
              <SettingsRow
                key={id}
                title={chain.displayName}
                description={
                  <>
                    <span className="break-words">{describeChain(chain, instanceLabels)}</span>
                    {unknown.length > 0 ? (
                      <span className="block text-warning">
                        Not configured on this environment: {unknown.join(", ")}. The chain skips
                        them.
                      </span>
                    ) : null}
                  </>
                }
                control={
                  !readOnly ? (
                    <div className="flex items-center gap-1">
                      <Button size="xs" variant="ghost" onClick={() => setEditing({ id, chain })}>
                        Edit
                      </Button>
                      <DeleteChainButton
                        label={chain.displayName}
                        isDefault={defaultChainId === id}
                        onConfirm={() =>
                          updateSettings(
                            withoutChain(
                              { accountFallback, accountFallbackChainId: defaultChainId },
                              id,
                            ),
                          )
                        }
                      />
                    </div>
                  ) : null
                }
              />
            );
          })
        )}
        <SettingsRow
          id="fallback-default-chain"
          title="Default chain"
          description="Chain for threads in this environment. Projects can pick another or turn it off."
          control={
            <Select
              value={defaultChainId ?? NO_CHAIN}
              disabled={readOnly}
              onValueChange={(value) => {
                if (value === null) return;
                updateSettings({
                  accountFallbackChainId: value === NO_CHAIN ? null : FallbackChainId.make(value),
                });
              }}
            >
              <SelectTrigger size="sm" aria-label="Default fallback chain">
                <SelectValue>
                  {(value: string | null) =>
                    value === null || value === NO_CHAIN
                      ? "None"
                      : (accountFallback.chains[value as FallbackChainId]?.displayName ?? value)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={NO_CHAIN}>None</SelectItem>
                {chains.map(([id, chain]) => (
                  <SelectItem key={id} value={id}>
                    {chain.displayName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="fallback-handoff-cap"
          title="Handoffs per hour"
          description="Most times one thread may move to another account in an hour. Past that it waits instead."
          control={
            <NumberField
              value={accountFallback.maxHandoffsPerThreadPerHour}
              min={1}
              max={20}
              step={1}
              size="sm"
              className="w-32"
              disabled={readOnly}
              onValueChange={(value) => {
                if (value === null) return;
                const next = Math.min(20, Math.max(1, Math.round(value)));
                if (next === accountFallback.maxHandoffsPerThreadPerHour) return;
                updateSettings({
                  accountFallback: { ...accountFallback, maxHandoffsPerThreadPerHour: next },
                });
              }}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Decrease handoffs per hour" />
                <NumberFieldInput aria-label="Handoffs per thread per hour" />
                <NumberFieldIncrement aria-label="Increase handoffs per hour" />
              </NumberFieldGroup>
            </NumberField>
          }
        />
        <SettingsRow
          id="fallback-webhook-url"
          title="Webhook"
          description="Optional URL that gets a plain-text POST when a thread switches accounts or has to wait."
          control={
            <DraftInput
              size="sm"
              className="w-full @min-[32rem]/settings-row:w-64"
              type="url"
              placeholder="https://example.com/hook"
              aria-label="Fallback webhook URL"
              disabled={readOnly}
              value={accountFallback.webhookUrl ?? ""}
              onCommit={(next) => {
                const webhookUrl = next.trim() || null;
                if (webhookUrl === accountFallback.webhookUrl) return;
                updateSettings({ accountFallback: { ...accountFallback, webhookUrl } });
              }}
            />
          }
        />
      </SettingsSection>
      {editing && !readOnly ? (
        <FallbackChainDialog
          editing={editing}
          instances={instances}
          instanceLabels={instanceLabels}
          existingIds={new Set(Object.keys(accountFallback.chains))}
          onClose={() => setEditing(null)}
          onSave={(id, chain) => {
            saveChain(id, chain);
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

function DeleteChainButton({
  label,
  isDefault,
  onConfirm,
}: {
  readonly label: string;
  readonly isDefault: boolean;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {isDefault
                ? "It is the default chain, so fallback turns off for threads that use the default. "
                : ""}
              Projects that picked this chain stop falling back until they pick another.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Delete chain
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** Create or edit one chain. A new chain's id is derived from its name once, on save. */
function FallbackChainDialog({
  editing,
  instances,
  instanceLabels,
  existingIds,
  onClose,
  onSave,
}: {
  readonly editing: EditingChain;
  readonly instances: readonly FallbackInstanceOption[];
  readonly instanceLabels: ReadonlyMap<string, string>;
  readonly existingIds: ReadonlySet<string>;
  readonly onClose: () => void;
  readonly onSave: (id: FallbackChainId, chain: AccountFallbackChain) => void;
}) {
  const [name, setName] = useState(editing.chain?.displayName ?? "");
  const [instanceIds, setInstanceIds] = useState<ProviderInstanceId[]>(() => [
    ...(editing.chain?.instanceIds ?? []),
  ]);
  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && instanceIds.length > 0;
  const addable = instances.filter((instance) => !instanceIds.includes(instance.instanceId));

  const save = () => {
    if (!canSave) return;
    onSave(editing.id ?? chainIdFromName(trimmedName, existingIds), {
      displayName: trimmedName,
      instanceIds,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing.id ? "Edit fallback chain" : "Add a fallback chain"}</DialogTitle>
          <DialogDescription>
            Threads start on the first account. When it runs out of usage they continue on the next
            one that has room.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="fallback-chain-name">Name</Label>
              <Input
                id="fallback-chain-name"
                placeholder="Claude accounts"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Accounts, in order</Label>
              {instanceIds.length === 0 ? (
                <p className="text-sm text-muted-foreground">Add at least one provider instance.</p>
              ) : (
                <ol className="grid gap-1">
                  {instanceIds.map((instanceId, index) => {
                    const label = instanceLabels.get(instanceId);
                    return (
                      <li key={instanceId} className="flex min-w-0 items-center gap-1">
                        <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">
                          {index + 1}.
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {label ?? `${instanceId} (not configured)`}
                        </span>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Move ${label ?? instanceId} up`}
                          disabled={index === 0}
                          onClick={() => setInstanceIds((ids) => moveInstance(ids, index, -1))}
                        >
                          <ArrowUpIcon />
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Move ${label ?? instanceId} down`}
                          disabled={index === instanceIds.length - 1}
                          onClick={() => setInstanceIds((ids) => moveInstance(ids, index, 1))}
                        >
                          <ArrowDownIcon />
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Remove ${label ?? instanceId}`}
                          onClick={() =>
                            setInstanceIds((ids) => ids.filter((id) => id !== instanceId))
                          }
                        >
                          <XIcon />
                        </Button>
                      </li>
                    );
                  })}
                </ol>
              )}
              {addable.length > 0 ? (
                <Select
                  value={null}
                  onValueChange={(value) => {
                    if (value) setInstanceIds((ids) => [...ids, ProviderInstanceId.make(value)]);
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Add provider instance">
                    <SelectValue placeholder="Add provider instance" />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {addable.map((instance) => (
                      <SelectItem key={instance.instanceId} value={instance.instanceId}>
                        {instance.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {editing.id ? "Save chain" : "Add chain"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
