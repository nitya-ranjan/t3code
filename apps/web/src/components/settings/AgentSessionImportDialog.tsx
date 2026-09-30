import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AgentSessionEntry, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useContext, useMemo, useState } from "react";

import { agentSessionImportSelected, agentSessionList } from "../../state/agentSessions";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  agentSessionKey,
  describeImportOutcomes,
  filterAgentSessions,
  isAgentSessionImportable,
} from "./agentSessionImport.logic";

const PROVIDER_LABEL: Record<AgentSessionEntry["provider"], string> = {
  claudeAgent: "Claude",
  codex: "Codex",
};

/**
 * Pick Claude Code and Codex sessions on one environment and import them as
 * threads that resume the same provider session. Each lands in the project for
 * its folder, which is created when missing.
 */
export function AgentSessionImportDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId = chosenEnvironmentId ?? primaryEnvironmentId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Claude Code and Codex sessions</DialogTitle>
          <DialogDescription>
            Imported sessions become threads that continue the same conversation. Each one joins the
            project for its folder.
          </DialogDescription>
        </DialogHeader>
        {environmentId === null ? (
          <DialogPanel>
            <p className="text-sm text-muted-foreground">Connect to a computer first.</p>
          </DialogPanel>
        ) : (
          <SessionPicker
            key={environmentId}
            environmentId={environmentId}
            environmentPicker={
              environments.length > 1 ? (
                <Select
                  items={environments.map((environment) => ({
                    value: environment.environmentId,
                    label: environment.label,
                  }))}
                  value={environmentId}
                  onValueChange={(value) => {
                    if (value !== null) setChosenEnvironmentId(value);
                  }}
                >
                  <SelectTrigger size="sm" className="w-48" aria-label="Computer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {environments.map((environment) => (
                      <SelectItem key={environment.environmentId} value={environment.environmentId}>
                        {environment.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null
            }
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function SessionPicker({
  environmentId,
  environmentPicker,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentPicker: React.ReactNode;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const listAtom = useMemo(() => agentSessionList({ environmentId, input: {} }), [environmentId]);
  const listResult = useAtomValue(listAtom);
  const importSelected = useAtomCommand(agentSessionImportSelected, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [showAutomated, setShowAutomated] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const listing = Option.getOrNull(AsyncResult.value(listResult));
  const loadError =
    listResult._tag === "Failure" ? formatEnvironmentQueryError(listResult.cause) : null;
  const visible = useMemo(
    () => filterAgentSessions(listing?.sessions ?? [], { query, showAutomated }),
    [listing, query, showAutomated],
  );
  const chosen = (listing?.sessions ?? []).filter(
    (session) => isAgentSessionImportable(session) && selected.has(agentSessionKey(session)),
  );

  const toggle = (session: AgentSessionEntry, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(agentSessionKey(session));
    else next.delete(agentSessionKey(session));
    setSelected(next);
  };

  const runImport = async () => {
    if (chosen.length === 0) return;
    setIsImporting(true);
    setSummary(null);
    const result = await importSelected({
      environmentId,
      input: {
        sessions: chosen.map((session) => ({
          providerInstanceId: session.providerInstanceId,
          providerSessionId: session.providerSessionId,
        })),
      },
    });
    setIsImporting(false);
    if (result._tag === "Success") {
      setSummary(describeImportOutcomes(result.value.outcomes));
      setSelected(new Set());
    } else {
      setSummary("Import failed. Check that the computer is still connected, then try again.");
    }
    registry.refresh(listAtom);
  };

  return (
    <>
      <DialogPanel>
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {environmentPicker}
            <Input
              size="sm"
              className="min-w-40 flex-1"
              placeholder="Search by title or folder"
              aria-label="Search sessions"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={showAutomated} onCheckedChange={(next) => setShowAutomated(next)} />
              Show automated runs
            </label>
          </div>
          {loadError !== null ? (
            <p className="text-sm text-destructive-foreground">{loadError}</p>
          ) : listing === null ? (
            <p className="text-sm text-muted-foreground">Looking for sessions…</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sessions match.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded-md border">
              {visible.map((session) => {
                const key = agentSessionKey(session);
                const importable = isAgentSessionImportable(session);
                const threadId = session.threadId;
                return (
                  <li key={key} className="flex items-start gap-3 px-3 py-2">
                    <Checkbox
                      className="mt-0.5"
                      aria-label={`Import ${session.title}`}
                      checked={threadId !== undefined || selected.has(key)}
                      disabled={!importable || isImporting}
                      onCheckedChange={(checked) => toggle(session, checked === true)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{session.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{session.cwd}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {threadId !== undefined ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            onClose();
                            void navigate({
                              to: "/$environmentId/$threadId",
                              params: buildThreadRouteParams(
                                scopeThreadRef(environmentId, threadId),
                              ),
                            });
                          }}
                        >
                          Open thread
                        </Button>
                      ) : !session.cwdExists ? (
                        <Badge variant="warning">Folder missing</Badge>
                      ) : null}
                      {session.automated ? <Badge variant="outline">Automated</Badge> : null}
                      <Badge variant="secondary">{PROVIDER_LABEL[session.provider]}</Badge>
                      <span className="w-16 text-right text-xs text-muted-foreground">
                        {formatRelativeTimeLabel(session.lastActiveAt)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {listing?.truncated ? (
            <p className="text-xs text-muted-foreground">
              Showing the newest sessions. Older ones are not listed.
            </p>
          ) : null}
          {summary !== null ? <p className="text-sm">{summary}</p> : null}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button onClick={() => void runImport()} disabled={chosen.length === 0 || isImporting}>
          {isImporting
            ? "Importing…"
            : chosen.length === 0
              ? "Import"
              : `Import ${chosen.length} session${chosen.length === 1 ? "" : "s"}`}
        </Button>
      </DialogFooter>
    </>
  );
}
