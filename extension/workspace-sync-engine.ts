import {
  applyWorkspacePatch,
  rebaseWorkspaceOperations,
  replaceSavedWorkspace,
  type WorkspaceOperation,
} from "../shared/workspace-operations";
import { WorkspaceRevisionConflictError } from "../shared/workspace-sync-repository";
import type { WorkspaceSnapshot } from "../shared/domain";
import type { AccountWorkspaceState, LocalFirstStorage } from "./local-first-storage";
import type { ApplyOperationsResult, WorkspaceSyncTransport } from "./workspace-sync-transport";

export type SyncReason = "mutation" | "startup" | "focus" | "online" | "manual";

export type SyncEngineState =
  | { phase: "synced"; revision: number; pending: 0; lastSyncedAt: string }
  | { phase: "syncing"; revision: number; pending: number }
  | { phase: "offline"; revision: number; pending: number; error?: string };

type EngineInput = {
  userId?: string;
  storage: LocalFirstStorage;
  transport: WorkspaceSyncTransport;
  mutationDebounceMs?: number;
  focusFreshnessMs?: number;
  now?: () => number;
  onActionRequired?: (message: string) => void;
  onSnapshotCommitted?: (snapshot: WorkspaceSnapshot) => void;
  immutableOperationIds?: Set<string>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Workspace sync failed.";
}

function snapshotUserId(snapshot: WorkspaceSnapshot): string | undefined {
  return snapshot.spaces[0]?.user_id
    ?? snapshot.collections[0]?.user_id
    ?? snapshot.links[0]?.user_id;
}

export class WorkspaceSyncEngine {
  private readonly storage: LocalFirstStorage;
  private readonly userId?: string;
  private readonly transport: WorkspaceSyncTransport;
  private readonly mutationDebounceMs: number;
  private readonly focusFreshnessMs: number;
  private readonly now: () => number;
  private readonly onActionRequired?: (message: string) => void;
  private readonly onSnapshotCommitted?: (snapshot: WorkspaceSnapshot) => void;
  private readonly immutableOperationIds: Set<string>;
  private readonly listeners = new Set<(state: SyncEngineState) => void>();
  private current: SyncEngineState = { phase: "offline", revision: 0, pending: 0 };
  private active: Promise<void> | null = null;
  private followUp = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRevisionCheckAt = 0;
  private stopped = false;

  constructor(input: EngineInput) {
    this.userId = input.userId;
    this.storage = input.storage;
    this.transport = input.transport;
    this.mutationDebounceMs = input.mutationDebounceMs ?? 500;
    this.focusFreshnessMs = input.focusFreshnessMs ?? 30_000;
    this.now = input.now ?? Date.now;
    this.onActionRequired = input.onActionRequired;
    this.onSnapshotCommitted = input.onSnapshotCommitted;
    this.immutableOperationIds = input.immutableOperationIds ?? new Set();
  }

  subscribe(listener: (state: SyncEngineState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  private publish(state: SyncEngineState): void {
    if (this.stopped) return;
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const local = await this.storage.loadOrThrow();
    const persistedCheck = local.sync.lastRevisionCheckAt
      ? Date.parse(local.sync.lastRevisionCheckAt)
      : Number.NaN;
    this.lastRevisionCheckAt = Number.isFinite(persistedCheck) ? persistedCheck : 0;
    await this.refresh();
  }

  requestSync(reason: SyncReason): void {
    if (this.stopped) return;
    if (reason === "focus" && this.now() - this.lastRevisionCheckAt < this.focusFreshnessMs) return;
    if (reason === "mutation") {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        void this.refresh();
      }, this.mutationDebounceMs);
      return;
    }
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) {
      this.followUp = true;
      return this.active;
    }
    this.active = (async () => {
      do {
        this.followUp = false;
        await this.runCycle();
      } while (this.followUp && !this.stopped);
    })().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  stop(): void {
    this.stopped = true;
    this.followUp = false;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.listeners.clear();
  }

  private async runCycle(): Promise<void> {
    try {
      await this.synchronize();
    } catch (error) {
      if (this.stopped) return;
      const local = await this.storage.loadOrThrow().catch(() => null);
      const revision = local?.revision ?? this.current.revision;
      const pending = local?.outbox.length ?? this.current.pending;
      const message = errorMessage(error);
      this.onActionRequired?.(message);
      if (local) {
        await this.storage.update(async (latest) => [{
          ...latest,
          sync: { ...latest.sync, phase: "offline", error: message },
        }, undefined]).catch(() => undefined);
      }
      this.publish({ phase: "offline", revision, pending, error: message });
    }
  }

  private async synchronize(): Promise<void> {
    let local = await this.storage.loadOrThrow();
    this.publish({ phase: "syncing", revision: local.revision, pending: local.outbox.length });
    if (local.outbox.length) await this.push(local);

    local = await this.storage.loadOrThrow();
    const remote = await this.transport.getRevision();
    if (this.stopped) return;
    this.lastRevisionCheckAt = this.now();
    await this.storage.update(async (latest) => [{
      ...latest,
      sync: {
        ...latest.sync,
        phase: "syncing",
        lastRevisionCheckAt: new Date(this.lastRevisionCheckAt).toISOString(),
        error: undefined,
      },
    }, undefined]);

    local = await this.storage.loadOrThrow();
    if (remote.revision > local.revision && local.outbox.length === 0) {
      const canonical = await this.transport.loadCanonical();
      if (this.stopped) return;
      const committed = await this.storage.update(async (latest) => {
        const snapshot = replaceSavedWorkspace(latest.snapshot, canonical.snapshot);
        return [{
        ...latest,
        snapshot,
        revision: canonical.revision,
        cachedAt: new Date(this.now()).toISOString(),
        }, snapshot] as const;
      });
      this.onSnapshotCommitted?.(committed);
    }

    const syncedAt = new Date(this.now()).toISOString();
    const completed = await this.storage.update(async (latest) => {
      const pending = latest.outbox.length;
      return [{
        ...latest,
        sync: {
          ...latest.sync,
          phase: pending === 0 ? "synced" : "offline",
          lastSyncedAt: pending === 0 ? syncedAt : latest.sync.lastSyncedAt,
          error: undefined,
        },
      }, { revision: latest.revision, pending }] as const;
    });
    if (completed.pending === 0) {
      this.publish({ phase: "synced", revision: completed.revision, pending: 0, lastSyncedAt: syncedAt });
    } else {
      this.publish({ phase: "offline", revision: completed.revision, pending: completed.pending });
    }
  }

  private async push(local: AccountWorkspaceState): Promise<void> {
    const batch = [...local.outbox];
    for (const operation of batch) this.immutableOperationIds.add(operation.operationId);
    try {
      const result = await this.transport.applyOperations(batch, local.revision);
      await this.commitPush(result, batch);
    } catch (error) {
      if (!(error instanceof WorkspaceRevisionConflictError)) throw error;
      await this.rebaseAndRetry();
    } finally {
      for (const operation of batch) this.immutableOperationIds.delete(operation.operationId);
    }
  }

  private async commitPush(result: ApplyOperationsResult, sent: WorkspaceOperation[]): Promise<void> {
    if (this.stopped) return;
    const sentIds = new Set(sent.map((operation) => operation.operationId));
    const acknowledged = new Set(result.outcomes
      .filter((outcome) => sentIds.has(outcome.operationId) && outcome.status !== "rejected")
      .map((outcome) => outcome.operationId));
    const rejected = result.outcomes.filter((outcome) => outcome.status === "rejected");
    if (rejected.length || result.conflicts.length) {
      const message = rejected[0]?.message ?? result.conflicts[0]?.message ?? `${rejected.length + result.conflicts.length} local change could not be synced.`;
      this.onActionRequired?.(message);
    }
    const committed = await this.storage.update(async (latest) => {
      const remaining = latest.outbox.filter((operation) => !acknowledged.has(operation.operationId));
      const patched = applyWorkspacePatch(latest.snapshot, {
        ...result.patches,
        tombstones: result.tombstones,
      });
      const userId = this.userId ?? snapshotUserId(latest.snapshot) ?? snapshotUserId(patched);
      const replayed = userId
        ? rebaseWorkspaceOperations(patched, result.tombstones, remaining, userId)
        : { snapshot: patched, pending: remaining, rejected: [] };
      return [{
        ...latest,
        snapshot: replayed.snapshot,
        revision: result.revision,
        cachedAt: new Date(this.now()).toISOString(),
        outbox: replayed.pending,
      }, replayed] as const;
    });
    if (committed.rejected.length) {
      this.onActionRequired?.(`${committed.rejected.length} local change could not be synced because its item was deleted elsewhere.`);
    }
    if (!this.stopped) this.onSnapshotCommitted?.(committed.snapshot);
  }

  private async rebaseAndRetry(): Promise<void> {
    const canonical = await this.transport.loadCanonical();
    if (this.stopped) return;
    const rebased = await this.storage.update(async (latest) => {
      const userId = this.userId ?? snapshotUserId(latest.snapshot) ?? snapshotUserId(canonical.snapshot);
      if (!userId && latest.outbox.length) throw new Error("Workspace account could not be identified.");
      const next = rebaseWorkspaceOperations(
        canonical.snapshot,
        canonical.tombstones,
        latest.outbox,
        userId ?? "",
      );
      const snapshot = replaceSavedWorkspace(latest.snapshot, next.snapshot);
      return [{
        ...latest,
        snapshot,
        revision: canonical.revision,
        cachedAt: new Date(this.now()).toISOString(),
        outbox: next.pending,
      }, { ...next, snapshot }] as const;
    });
    if (!this.stopped) this.onSnapshotCommitted?.(rebased.snapshot);
    if (rebased.rejected.length) {
      this.onActionRequired?.(`${rebased.rejected.length} local change could not be synced because its item was deleted elsewhere.`);
    }
    if (!rebased.pending.length) return;
    for (const operation of rebased.pending) this.immutableOperationIds.add(operation.operationId);
    try {
      const retry = await this.transport.applyOperations(rebased.pending, canonical.revision);
      await this.commitPush(retry, rebased.pending);
    } finally {
      for (const operation of rebased.pending) this.immutableOperationIds.delete(operation.operationId);
    }
  }
}
