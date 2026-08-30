import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceSnapshot } from "./domain";
import { decodeWorkspaceSnapshot } from "./repository";
import type {
  VersionedWorkspaceSnapshot,
  WorkspaceIdentityMap,
  WorkspaceMergeSummary,
} from "./workspace-merge";

export type WorkspaceMergeResult = {
  snapshot: WorkspaceSnapshot;
  revision: number;
  identityMap: WorkspaceIdentityMap;
  summary: WorkspaceMergeSummary;
};

export class WorkspaceRevisionConflictError extends Error {
  constructor(message = "workspace revision conflict") {
    super(message);
    this.name = "WorkspaceRevisionConflictError";
  }
}

export class WorkspaceAuthenticationError extends Error {
  constructor(message = "workspace authentication required") {
    super(message);
    this.name = "WorkspaceAuthenticationError";
  }
}

export interface WorkspaceSyncRepository {
  loadVersioned(): Promise<VersionedWorkspaceSnapshot>;
  mergeLocal(
    local: WorkspaceSnapshot,
    expectedRevision: number,
  ): Promise<WorkspaceMergeResult>;
}

export type WorkspaceSyncRpcError = { code?: string; message: string };

export function throwWorkspaceSyncError(
  error: WorkspaceSyncRpcError | null,
): void {
  if (!error) return;
  if (error.code === "40001") {
    throw new WorkspaceRevisionConflictError(error.message);
  }
  if (["28000", "42501", "PGRST301", "401"].includes(error.code ?? "")) {
    throw new WorkspaceAuthenticationError(error.message);
  }
  throw new Error(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseVersioned(value: unknown): VersionedWorkspaceSnapshot {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision)) {
    throw new Error("invalid workspace sync response");
  }
  try {
    return {
      revision: value.revision as number,
      snapshot: decodeWorkspaceSnapshot(value.snapshot),
    };
  } catch {
    throw new Error("invalid workspace sync response");
  }
}

function isIdentityMap(value: unknown): value is WorkspaceIdentityMap {
  if (!isRecord(value)) return false;
  return [value.spaces, value.collections, value.links].every(isRecord);
}

function isMergeSummary(value: unknown): value is WorkspaceMergeSummary {
  if (!isRecord(value)) return false;
  return [
    "addedSpaces",
    "addedCollections",
    "addedLinks",
    "matchedSpaces",
    "matchedCollections",
    "matchedLinksById",
    "matchedLinksByUrl",
    "remappedIds",
    "skippedUnsupportedLinks",
  ].every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
}

export class SupabaseWorkspaceSyncRepository
  implements WorkspaceSyncRepository
{
  constructor(private readonly client: SupabaseClient) {}

  async loadVersioned(): Promise<VersionedWorkspaceSnapshot> {
    const result = await this.client.rpc("load_workspace_snapshot");
    throwWorkspaceSyncError(result.error);
    return parseVersioned(result.data);
  }

  async mergeLocal(
    local: WorkspaceSnapshot,
    expectedRevision: number,
  ): Promise<WorkspaceMergeResult> {
    const result = await this.client.rpc("merge_workspace_snapshot", {
      local_snapshot: local,
      expected_revision: expectedRevision,
    });
    throwWorkspaceSyncError(result.error);
    if (!isRecord(result.data)) {
      throw new Error("invalid workspace sync response");
    }
    const versioned = parseVersioned(result.data);
    if (
      !isIdentityMap(result.data.identityMap) ||
      !isMergeSummary(result.data.summary)
    ) {
      throw new Error("invalid workspace sync response");
    }
    return {
      ...versioned,
      identityMap: result.data.identityMap,
      summary: result.data.summary,
    };
  }
}
