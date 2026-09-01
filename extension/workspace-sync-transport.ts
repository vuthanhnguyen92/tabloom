import type { SupabaseClient } from "@supabase/supabase-js";
import type { Collection, SavedLink, Space, WorkspaceSnapshot } from "../shared/domain";
import { decodeWorkspaceSnapshot } from "../shared/repository";
import type { VersionedWorkspaceSnapshot } from "../shared/workspace-merge";
import type {
  WorkspaceOperation,
  WorkspacePatchSet,
  WorkspaceTombstone,
} from "../shared/workspace-operations";
import { throwWorkspaceSyncError } from "../shared/workspace-sync-repository";

export type WorkspaceRevision = { revision: number; serverTime: string };

export type OperationOutcome = {
  operationId: string;
  status: "applied" | "already_applied" | "deleted" | "rejected";
  message?: string;
};

export type ApplyOperationsResult = {
  revision: number;
  outcomes: OperationOutcome[];
  patches: Omit<WorkspacePatchSet, "tombstones">;
  tombstones: WorkspaceTombstone[];
  conflicts: Array<{ operationId: string; code: string; message: string }>;
};

export type CanonicalWorkspaceState = VersionedWorkspaceSnapshot & {
  tombstones: WorkspaceTombstone[];
};

export interface WorkspaceSyncTransport {
  getRevision(): Promise<WorkspaceRevision>;
  applyOperations(
    operations: WorkspaceOperation[],
    expectedRevision: number,
  ): Promise<ApplyOperationsResult>;
  loadCanonical(): Promise<CanonicalWorkspaceState>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_RESPONSE = "invalid workspace sync response";
const DEFAULT_TIMEOUT_MS = 15_000;

function withTimeout<T>(operation: PromiseLike<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Workspace sync timed out. Your changes are still queued.")),
      timeoutMs,
    );
    Promise.resolve(operation).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isBaseRow(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && UUID_PATTERN.test(String(value.id))
    && UUID_PATTERN.test(String(value.user_id))
    && typeof value.name === "string"
    && Number.isSafeInteger(value.position)
    && Number(value.position) >= 0
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string";
}

function isSpace(value: unknown): value is Space {
  return isBaseRow(value) && typeof value.color === "string";
}

function isCollection(value: unknown): value is Collection {
  return isBaseRow(value) && UUID_PATTERN.test(String(value.space_id));
}

function isLink(value: unknown): value is SavedLink {
  if (!isRecord(value)) return false;
  return UUID_PATTERN.test(String(value.id))
    && UUID_PATTERN.test(String(value.user_id))
    && UUID_PATTERN.test(String(value.collection_id))
    && typeof value.url === "string"
    && typeof value.title === "string"
    && typeof value.description === "string"
    && (typeof value.favicon_url === "string" || value.favicon_url === null)
    && Number.isSafeInteger(value.position)
    && Number(value.position) >= 0
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string"
    && (value.device_label === undefined || value.device_label === null || typeof value.device_label === "string");
}

function parseSnapshot(value: unknown): WorkspaceSnapshot {
  if (!isRecord(value)
    || !Array.isArray(value.spaces)
    || !Array.isArray(value.collections)
    || !Array.isArray(value.links)
    || !value.spaces.every(isSpace)
    || !value.collections.every(isCollection)
    || !value.links.every(isLink)
  ) {
    throw new Error(INVALID_RESPONSE);
  }
  return decodeWorkspaceSnapshot(value);
}

function isTombstone(value: unknown): value is WorkspaceTombstone {
  return isRecord(value)
    && ["space", "collection", "link"].includes(String(value.entity))
    && UUID_PATTERN.test(String(value.entityId))
    && isRevision(value.deletedRevision)
    && typeof value.deletedAt === "string";
}

function isOutcome(value: unknown): value is OperationOutcome {
  return isRecord(value)
    && UUID_PATTERN.test(String(value.operationId))
    && ["applied", "already_applied", "deleted", "rejected"].includes(String(value.status))
    && (value.message === undefined || typeof value.message === "string");
}

function isConflict(value: unknown): value is ApplyOperationsResult["conflicts"][number] {
  return isRecord(value)
    && UUID_PATTERN.test(String(value.operationId))
    && typeof value.code === "string"
    && typeof value.message === "string";
}

function parseTombstones(value: unknown): WorkspaceTombstone[] {
  if (!Array.isArray(value) || !value.every(isTombstone)) {
    throw new Error(INVALID_RESPONSE);
  }
  return value;
}

export class SupabaseWorkspaceSyncTransport implements WorkspaceSyncTransport {
  private readonly timeoutMs: number;

  constructor(
    private readonly client: SupabaseClient,
    { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = timeoutMs;
  }

  async getRevision(): Promise<WorkspaceRevision> {
    const result = await withTimeout(this.client.rpc("get_workspace_revision"), this.timeoutMs);
    throwWorkspaceSyncError(result.error);
    if (!isRecord(result.data)
      || !isRevision(result.data.revision)
      || typeof result.data.serverTime !== "string"
    ) {
      throw new Error(INVALID_RESPONSE);
    }
    return { revision: result.data.revision, serverTime: result.data.serverTime };
  }

  async applyOperations(
    operations: WorkspaceOperation[],
    expectedRevision: number,
  ): Promise<ApplyOperationsResult> {
    const result = await withTimeout(this.client.rpc("apply_workspace_operations", {
      operations,
      expected_revision: expectedRevision,
    }), this.timeoutMs);
    throwWorkspaceSyncError(result.error);
    if (!isRecord(result.data)
      || !isRevision(result.data.revision)
      || !Array.isArray(result.data.outcomes)
      || !result.data.outcomes.every(isOutcome)
      || !isRecord(result.data.patches)
      || !Array.isArray(result.data.conflicts)
      || !result.data.conflicts.every(isConflict)
    ) {
      throw new Error(INVALID_RESPONSE);
    }
    const patches = parseSnapshot(result.data.patches);
    return {
      revision: result.data.revision,
      outcomes: result.data.outcomes,
      patches,
      tombstones: parseTombstones(result.data.tombstones),
      conflicts: result.data.conflicts,
    };
  }

  async loadCanonical(): Promise<CanonicalWorkspaceState> {
    const result = await withTimeout(this.client.rpc("load_workspace_snapshot"), this.timeoutMs);
    throwWorkspaceSyncError(result.error);
    if (!isRecord(result.data) || !isRevision(result.data.revision)) {
      throw new Error(INVALID_RESPONSE);
    }
    return {
      revision: result.data.revision,
      snapshot: parseSnapshot(result.data.snapshot),
      tombstones: parseTombstones(result.data.tombstones),
    };
  }
}
