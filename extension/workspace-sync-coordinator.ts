import type { WorkspaceSnapshot } from "../shared/domain";
import {
  rebaseWorkspaceOperations,
  replaceSavedWorkspace,
  type WorkspaceOperation,
} from "../shared/workspace-operations";
import type { AccountWorkspaceState, LocalFirstStorage, QueuedWorkspaceOperation } from "./local-first-storage";
import { WorkspaceOfflineError } from "./workspace-sync-errors";
import type { WorkspaceSyncExclusiveRunner } from "./workspace-sync-lock";
import type { WorkspaceSyncTransport } from "./workspace-sync-transport";

export type WorkspaceSyncState =
  | { phase: "synced"; revision: number; failed: 0; waiting: 0; lastSyncedAt?: string }
  | { phase: "syncing"; activity: "read" | "write"; revision: number; failed: number; waiting: number }
  | { phase: "failed"; revision: number; failed: number; waiting: number; error: string }
  | { phase: "offline"; revision: number; failed: number; waiting: number; error: string };

export interface WorkspaceSyncCoordinatorContract {
  start(): Promise<void>;
  refreshOnFocus(): Promise<void>;
  submit(operation: WorkspaceOperation): Promise<void>;
  retryFailed(): Promise<void>;
  stop(): void;
}

type CoordinatorInput = {
  userId: string;
  storage: LocalFirstStorage;
  transport: WorkspaceSyncTransport;
  exclusiveRunner: WorkspaceSyncExclusiveRunner;
  now?: () => number;
  onSnapshotCommitted?: (snapshot: WorkspaceSnapshot) => void;
  onActionRequired?: (message: string) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Workspace synchronization failed.";
}

function queueCounts(queue: QueuedWorkspaceOperation[]) {
  return {
    failed: queue.filter((entry) => entry.state === "failed").length,
    waiting: queue.filter((entry) => entry.state === "waiting").length,
  };
}

function stateFromPersisted(local: AccountWorkspaceState): WorkspaceSyncState {
  const counts = queueCounts(local.queue);
  if (local.sync.phase === "offline") {
    return { phase: "offline", revision: local.revision, ...counts, error: local.sync.error ?? "Remote workspace is unavailable." };
  }
  if (local.sync.phase === "failed" || local.queue.length > 0) {
    return { phase: "failed", revision: local.revision, ...counts, error: local.sync.error ?? "Workspace changes need to be retried." };
  }
  return {
    phase: "synced",
    revision: local.revision,
    failed: 0,
    waiting: 0,
    ...(local.sync.lastSyncedAt ? { lastSyncedAt: local.sync.lastSyncedAt } : {}),
  };
}

function rebaseQueue(
  canonical: WorkspaceSnapshot,
  tombstones: Parameters<typeof rebaseWorkspaceOperations>[1],
  queue: QueuedWorkspaceOperation[],
  userId: string,
) {
  const previousById = new Map(queue.map((entry) => [entry.operation.operationId, entry]));
  const rebased = rebaseWorkspaceOperations(canonical, tombstones, queue.map((entry) => entry.operation), userId);
  return {
    ...rebased,
    queue: rebased.pending.map((operation) => {
      const previous = previousById.get(operation.operationId);
      return previous ? { ...previous, operation } : { operation, state: "waiting" as const };
    }),
  };
}

export class WorkspaceSyncCoordinator implements WorkspaceSyncCoordinatorContract {
  private readonly now: () => number;
  private readonly listeners = new Set<(state: WorkspaceSyncState) => void>();
  private current: WorkspaceSyncState = { phase: "offline", revision: 0, failed: 0, waiting: 0, error: "Workspace sync has not started." };
  private activeRead: Promise<void> | null = null;
  private unsubscribeStorage: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly input: CoordinatorInput) {
    this.now = input.now ?? Date.now;
  }

  subscribe(listener: (state: WorkspaceSyncState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  private publish(state: WorkspaceSyncState): void {
    if (this.stopped) return;
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }

  private observeLocal(local: AccountWorkspaceState): void {
    if (this.stopped) return;
    this.input.onSnapshotCommitted?.(structuredClone(local.snapshot));
    if (!this.activeRead) this.publish(stateFromPersisted(local));
  }

  async start(): Promise<void> {
    this.stopped = false;
    const local = await this.input.storage.loadOrThrow();
    this.observeLocal(local);
    this.unsubscribeStorage?.();
    this.unsubscribeStorage = this.input.storage.subscribe((next) => this.observeLocal(next));
    await this.runRead(local.sync.lastRevisionCheckAt);
  }

  refreshOnFocus(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.activeRead) return this.activeRead;
    return this.input.storage.loadOrThrow().then((local) => this.runRead(local.sync.lastRevisionCheckAt));
  }

  private runRead(baselineRevisionCheckAt?: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.activeRead) return this.activeRead;
    const running = this.input.exclusiveRunner.runExclusive(this.input.userId, async () => {
      const latest = await this.input.storage.loadOrThrow();
      if (latest.sync.lastRevisionCheckAt
        && latest.sync.lastRevisionCheckAt !== baselineRevisionCheckAt) {
        this.observeLocal(latest);
        return;
      }
      const counts = queueCounts(latest.queue);
      this.publish({ phase: "syncing", activity: "read", revision: latest.revision, ...counts });
      try {
        const remote = await this.input.transport.getRevision();
        if (this.stopped) return;
        const checkedAt = new Date(this.now()).toISOString();
        const canonical = remote.revision !== latest.revision
          ? await this.input.transport.loadCanonical()
          : null;
        if (this.stopped) return;
        const completed = await this.input.storage.update(async (current) => {
          let snapshot = current.snapshot;
          let revision = current.revision;
          let queue = current.queue;
          let rejected = 0;
          if (canonical && canonical.revision !== current.revision) {
            const rebased = rebaseQueue(canonical.snapshot, canonical.tombstones, current.queue, this.input.userId);
            snapshot = replaceSavedWorkspace(current.snapshot, rebased.snapshot);
            revision = canonical.revision;
            queue = rebased.queue;
            rejected = rebased.rejected.length;
          }
          const failedEntry = queue.find((entry) => entry.state === "failed");
          const syncError = rejected > 0
            ? `${rejected} local change${rejected === 1 ? "" : "s"} require attention because remote items were deleted.`
            : failedEntry?.error;
          const sync = queue.length > 0
            ? { phase: "failed" as const, lastRevisionCheckAt: checkedAt, ...(syncError ? { error: syncError } : {}) }
            : { phase: "synced" as const, lastRevisionCheckAt: checkedAt, lastSyncedAt: checkedAt };
          const next: AccountWorkspaceState = {
            ...current,
            snapshot,
            revision,
            queue,
            cachedAt: checkedAt,
            sync,
          };
          return [next, next] as const;
        });
        if (this.stopped) return;
        this.input.onSnapshotCommitted?.(structuredClone(completed.snapshot));
        this.publish(stateFromPersisted(completed));
      } catch (error) {
        if (this.stopped) return;
        const message = errorMessage(error);
        const failed = await this.input.storage.update(async (current) => {
          const next: AccountWorkspaceState = { ...current, sync: { ...current.sync, phase: "offline", error: message } };
          return [next, next] as const;
        }).catch(() => latest);
        this.publish({ phase: "offline", revision: failed.revision, ...queueCounts(failed.queue), error: message });
        throw new WorkspaceOfflineError(message);
      }
    });
    this.activeRead = running.finally(() => {
      if (this.activeRead === running || this.activeRead === wrapped) this.activeRead = null;
    });
    const wrapped = this.activeRead;
    return wrapped;
  }

  async submit(_operation: WorkspaceOperation): Promise<void> {
    throw new Error("Workspace write synchronization is not implemented yet.");
  }

  async retryFailed(): Promise<void> {
    throw new Error("Workspace retry is not implemented yet.");
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribeStorage?.();
    this.unsubscribeStorage = null;
    this.listeners.clear();
  }
}
