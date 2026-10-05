import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Coding agent home directories the scanner knows how to read. */
export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

/** File identity saved with an imported session so bounded retries can skip unchanged history. */
export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  inode: Schema.NullOr(Schema.Number),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

/**
 * Empty for now. Kept as a struct so future scan options (source filters,
 * explicit roots) can be added without a new method.
 */
export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

/**
 * A directory that at least one agent CLI has run in, suitable for import as a
 * T3 Code project. `alreadyImported` marks candidates that already have an
 * active project rooted at the same path.
 */
/**
 * Git identity of a candidate directory, read from `.git/config` without
 * spawning git. `remoteKey` is the normalized origin URL, shared by every
 * clone of the same repository so the client can group them. `repository`
 * is the GitHub `owner/name` when the origin is on GitHub.
 */
export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  /**
   * `null` when the directory is not the root of a git repository. Missing on
   * servers that predate the git scan, where the client cannot tell repositories
   * from plain folders and should treat every candidate as a standalone project.
   */
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

/** Empty for now, like {@link AgentSessionScanInput}. The client filters the list. */
export const AgentSessionListInput = Schema.Struct({});
export type AgentSessionListInput = typeof AgentSessionListInput.Type;

/**
 * One Claude Code or Codex session found on an environment. `automated` marks
 * sessions started headlessly (`claude -p`, SDK callers, `codex exec`).
 * `threadId` is set when a T3 Code thread already owns the provider session,
 * whether it was imported or started in T3 Code. `projectId` is set when an
 * active project is rooted at `cwd`.
 */
export const AgentSessionEntry = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  cwdExists: Schema.Boolean,
  title: TrimmedNonEmptyString,
  lastActiveAt: IsoDateTime,
  size: NonNegativeInt,
  automated: Schema.Boolean,
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
});
export type AgentSessionEntry = typeof AgentSessionEntry.Type;

export const AgentSessionListResult = Schema.Struct({
  sessions: Schema.Array(AgentSessionEntry),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionListResult = typeof AgentSessionListResult.Type;

export const AgentSessionKey = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
});
export type AgentSessionKey = typeof AgentSessionKey.Type;

export const AGENT_SESSION_IMPORT_SELECTED_MAX = 100;

export const AgentSessionImportSelectedInput = Schema.Struct({
  sessions: Schema.Array(AgentSessionKey).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AGENT_SESSION_IMPORT_SELECTED_MAX),
  ),
});
export type AgentSessionImportSelectedInput = typeof AgentSessionImportSelectedInput.Type;

/**
 * Why a selected session was not imported. `not-found` means the transcript is
 * gone or no longer matches the listed session; `folder-missing` means its
 * working directory no longer exists, so the provider could not resume it.
 */
export const AgentSessionImportSkipReason = Schema.Literals([
  "not-found",
  "folder-missing",
  "unreadable",
  "conflict",
]);
export type AgentSessionImportSkipReason = typeof AgentSessionImportSkipReason.Type;

export const AgentSessionImportSelectedOutcome = Schema.Union([
  Schema.TaggedStruct("Imported", {
    session: AgentSessionKey,
    threadId: ThreadId,
    projectId: ProjectId,
  }),
  Schema.TaggedStruct("AlreadyInT3", {
    session: AgentSessionKey,
    threadId: ThreadId,
  }),
  Schema.TaggedStruct("Skipped", {
    session: AgentSessionKey,
    reason: AgentSessionImportSkipReason,
  }),
]);
export type AgentSessionImportSelectedOutcome = typeof AgentSessionImportSelectedOutcome.Type;

export const AgentSessionImportSelectedResult = Schema.Struct({
  outcomes: Schema.Array(AgentSessionImportSelectedOutcome),
});
export type AgentSessionImportSelectedResult = typeof AgentSessionImportSelectedResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}
