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
  storage: LocalFirstStorage;
  transport: WorkspaceSyncTransport;
  mutationDebounceMs?: number;
  focusFreshnessMs?: number;
  now?: () => number;
  onActionRequired?: (message: string) => void;
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
  private readonly transport: WorkspaceSyncTransport;
  private readonly mutationDebounceMs: number;
  private readonly focusFreshnessMs: number;
  private readonly now: () => number;
  private readonly onActionRequired?: (message: string) => void;
  private readonly listeners = new Set<(state: SyncEngineState) => void>();
  private current: SyncEngineState = { phase: "offline", revision: 0, pending: 0 };
  private active: Promise<void> | null = null;
  private followUp = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRevisionCheckAt = 0;
  private stopped = false;

  constructor(input: EngineInput) {
    this.storage = input.storage;
    this.transport = input.transport;
    this.mutationDebounceMs = input.mutationDebounceMs ?? 500;
    this.focusFreshnessMs = input.focusFreshnessMs ?? 30_000;
    this.now = input.now ?? Date.now;
    this.onActionRequired = input.onActionRequired;
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
      await this.storage.update(async (latest) => [{
        ...latest,
        snapshot: replaceSavedWorkspace(latest.snapshot, canonical.snapshot),
        revision: canonical.revision,
        cachedAt: new Date(this.now()).toISOString(),
      }, undefined]);
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
    try {
      const result = await this.transport.applyOperations(local.outbox, local.revision);
      await this.commitPush(result);
    } catch (error) {
      if (!(error instanceof WorkspaceRevisionConflictError)) throw error;
      await this.rebaseAndRetry(local.outbox);
    }
  }

  private async commitPush(result: ApplyOperationsResult): Promise<void> {
    if (this.stopped) return;
    const acknowledged = new Set(result.outcomes.map((outcome) => outcome.operationId));
    await this.storage.update(async (latest) => [{
      ...latest,
      snapshot: applyWorkspacePatch(latest.snapshot, {
        ...result.patches,
        tombstones: result.tombstones,
      }),
      revision: result.revision,
      cachedAt: new Date(this.now()).toISOString(),
      outbox: latest.outbox.filter((operation) => !acknowledged.has(operation.operationId)),
    }, undefined]);
  }

  private async rebaseAndRetry(originalPending: WorkspaceOperation[]): Promise<void> {
    const canonical = await this.transport.loadCanonical();
    if (this.stopped) return;
    const local = await this.storage.loadOrThrow();
    const userId = snapshotUserId(local.snapshot) ?? snapshotUserId(canonical.snapshot);
    if (!userId && originalPending.length) throw new Error("Workspace account could not be identified.");
    const rebased = rebaseWorkspaceOperations(
      canonical.snapshot,
      canonical.tombstones,
      originalPending,
      userId ?? "",
    );
    await this.storage.update(async (latest) => [{
      ...latest,
      snapshot: replaceSavedWorkspace(latest.snapshot, rebased.snapshot),
      revision: canonical.revision,
      cachedAt: new Date(this.now()).toISOString(),
      outbox: rebased.pending,
    }, undefined]);
    if (rebased.rejected.length) {
      this.onActionRequired?.(`${rebased.rejected.length} local change could not be synced because its item was deleted elsewhere.`);
    }
    if (!rebased.pending.length) return;
    const retry = await this.transport.applyOperations(rebased.pending, canonical.revision);
    await this.commitPush(retry);
  }
}
