import type { WorkspaceSnapshot } from "../shared/domain";
import {
  WorkspaceAuthenticationError as RemoteWorkspaceAuthenticationError,
  WorkspaceRevisionConflictError,
} from "../shared/workspace-sync-repository";
import {
  applyWorkspacePatch,
  rebaseWorkspaceOperations,
  replaceSavedWorkspace,
  type WorkspaceOperation,
} from "../shared/workspace-operations";
import type { AccountWorkspaceState, LocalFirstStorage, QueuedWorkspaceOperation } from "./local-first-storage";
import {
  WorkspaceConflictActionRequiredError,
  WorkspaceAuthenticationError,
  WorkspaceOfflineError,
  WorkspaceWriteBlockedError,
  WorkspaceWriteFailedError,
} from "./workspace-sync-errors";
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
  private activeWrites = 0;
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
    if (!this.activeRead && this.activeWrites === 0) this.publish(stateFromPersisted(local));
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
      const latest = await this.input.storage.normalizeInterruptedAttempts();
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

  async submit(operation: WorkspaceOperation): Promise<void> {
    if (this.stopped) throw new WorkspaceOfflineError("Workspace sync is unavailable.", operation.operationId);
    const queued = await this.input.storage.update(async (current) => {
      const existing = current.queue.find((entry) => entry.operation.operationId === operation.operationId);
      if (existing) return [current, current] as const;
      const rebased = rebaseWorkspaceOperations(current.snapshot, [], [operation], this.input.userId);
      if (rebased.rejected.length) {
        throw new WorkspaceConflictActionRequiredError("The workspace item was deleted elsewhere.", operation.operationId);
      }
      const next: AccountWorkspaceState = {
        ...current,
        snapshot: replaceSavedWorkspace(current.snapshot, rebased.snapshot),
        queue: [...current.queue, { operation, state: "waiting" as const }]
          .sort((left, right) => left.operation.sequence - right.operation.sequence),
        nextSequence: Math.max(current.nextSequence, operation.sequence + 1),
        cachedAt: new Date(this.now()).toISOString(),
      };
      return [next, next] as const;
    });
    this.input.onSnapshotCommitted?.(structuredClone(queued.snapshot));
    const earlierFailure = queued.queue.find((entry) => entry.state === "failed"
      && entry.operation.sequence < operation.sequence);
    if (earlierFailure) {
      const message = `A previous change failed to sync: ${earlierFailure.error ?? "Retry it to continue."}`;
      this.publish({ phase: "failed", revision: queued.revision, ...queueCounts(queued.queue), error: message });
      throw new WorkspaceWriteBlockedError(message, operation.operationId);
    }
    await this.withWriteStatus(() => this.writeThrough(operation.operationId));
  }

  async retryFailed(): Promise<void> {
    if (this.stopped) throw new WorkspaceOfflineError("Workspace sync is unavailable.");
    const retry = await this.input.storage.update(async (current) => {
      const firstFailed = current.queue.find((entry) => entry.state === "failed");
      if (!firstFailed) return [current, { state: current, ids: [] as string[] }] as const;
      const queue = current.queue.map((entry) => entry.operation.operationId === firstFailed.operation.operationId
        ? { operation: entry.operation, state: "waiting" as const }
        : entry);
      const next: AccountWorkspaceState = { ...current, queue };
      return [next, { state: next, ids: queue.map((entry) => entry.operation.operationId) }] as const;
    });
    if (!retry.ids.length) {
      this.publish(stateFromPersisted(retry.state));
      return;
    }
    await this.withWriteStatus(async () => {
      for (const operationId of retry.ids) await this.writeThrough(operationId);
    });
  }

  private async withWriteStatus(task: () => Promise<void>): Promise<void> {
    this.activeWrites += 1;
    const initial = await this.input.storage.loadOrThrow();
    this.publish({ phase: "syncing", activity: "write", revision: initial.revision, ...queueCounts(initial.queue) });
    try {
      await task();
    } finally {
      this.activeWrites -= 1;
      if (!this.stopped && this.activeWrites === 0) {
        const latest = await this.input.storage.loadOrThrow().catch(() => null);
        if (latest) this.publish(stateFromPersisted(latest));
      }
    }
  }

  private async writeThrough(operationId: string): Promise<void> {
    await this.input.exclusiveRunner.runExclusive(this.input.userId, async () => {
      let local = await this.input.storage.loadOrThrow();
      const targetIndex = local.queue.findIndex((entry) => entry.operation.operationId === operationId);
      if (targetIndex < 0) return;
      const blocked = local.queue.slice(0, targetIndex).find((entry) => entry.state === "failed");
      if (blocked) {
        throw new WorkspaceWriteBlockedError(
          `A previous change failed to sync: ${blocked.error ?? "Retry it to continue."}`,
          operationId,
        );
      }
      const eligible = local.queue.slice(0, targetIndex + 1).filter((entry) => entry.state === "waiting");
      if (!eligible.length) return;
      const attemptedAt = new Date(this.now()).toISOString();
      const eligibleIds = new Set(eligible.map((entry) => entry.operation.operationId));
      local = await this.input.storage.update(async (current) => {
        const next: AccountWorkspaceState = {
          ...current,
          queue: current.queue.map((entry) => eligibleIds.has(entry.operation.operationId)
            ? { ...entry, attemptedAt }
            : entry),
        };
        return [next, next] as const;
      });
      this.publish({ phase: "syncing", activity: "write", revision: local.revision, ...queueCounts(local.queue) });

      try {
        let sent = eligible.map((entry) => entry.operation);
        let result;
        try {
          result = await this.input.transport.applyOperations(sent, local.revision);
        } catch (error) {
          if (!(error instanceof WorkspaceRevisionConflictError)) throw error;
          const canonical = await this.input.transport.loadCanonical();
          const reconciliation = await this.input.storage.update(async (current) => {
            const rebased = rebaseQueue(canonical.snapshot, canonical.tombstones, current.queue, this.input.userId);
            const message = rebased.rejected.length
              ? `${rebased.rejected.length} local change${rebased.rejected.length === 1 ? "" : "s"} require attention because remote items were deleted.`
              : undefined;
            const next: AccountWorkspaceState = {
              ...current,
              snapshot: replaceSavedWorkspace(current.snapshot, rebased.snapshot),
              revision: canonical.revision,
              queue: rebased.queue,
              cachedAt: new Date(this.now()).toISOString(),
              sync: message ? { phase: "failed", error: message } : current.sync,
            };
            return [next, { state: next, rejected: rebased.rejected, message }] as const;
          });
          this.input.onSnapshotCommitted?.(structuredClone(reconciliation.state.snapshot));
          if (reconciliation.rejected.length) {
            const rejectedOperationId = reconciliation.rejected[0].operationId;
            throw new WorkspaceConflictActionRequiredError(
              reconciliation.message ?? "A workspace change requires attention.",
              rejectedOperationId,
            );
          }
          sent = reconciliation.state.queue
            .filter((entry) => eligibleIds.has(entry.operation.operationId))
            .map((entry) => entry.operation);
          if (!sent.length) return;
          result = await this.input.transport.applyOperations(sent, canonical.revision);
        }
        const sentIds = new Set(sent.map((operation) => operation.operationId));
        const rejected = result.outcomes.find((outcome) => sentIds.has(outcome.operationId) && outcome.status === "rejected");
        const conflict = result.conflicts.find((item) => sentIds.has(item.operationId));
        if (rejected || conflict) {
          const message = rejected?.message ?? conflict?.message ?? "A workspace change requires attention.";
          const conflictIds = new Set([
            ...result.outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.operationId),
            ...result.conflicts.map((item) => item.operationId),
          ]);
          const actionRequired = await this.input.storage.update(async (current) => {
            const patched = applyWorkspacePatch(current.snapshot, { ...result.patches, tombstones: result.tombstones });
            const remaining = current.queue.filter((entry) => !conflictIds.has(entry.operation.operationId));
            const rebased = rebaseQueue(patched, result.tombstones, remaining, this.input.userId);
            const next: AccountWorkspaceState = {
              ...current,
              snapshot: replaceSavedWorkspace(patched, rebased.snapshot),
              revision: result.revision,
              queue: rebased.queue,
              cachedAt: new Date(this.now()).toISOString(),
              sync: { phase: "failed", error: message },
            };
            return [next, next] as const;
          });
          this.input.onSnapshotCommitted?.(structuredClone(actionRequired.snapshot));
          throw new WorkspaceConflictActionRequiredError(message, rejected?.operationId ?? conflict?.operationId);
        }
        const acknowledged = new Set(result.outcomes
          .filter((outcome) => sentIds.has(outcome.operationId) && outcome.status !== "rejected")
          .map((outcome) => outcome.operationId));
        if (acknowledged.size !== sentIds.size) {
          throw new WorkspaceWriteFailedError("The server did not acknowledge every workspace change.", sent[0]?.operationId);
        }
        const completed = await this.input.storage.update(async (current) => {
          const patched = applyWorkspacePatch(current.snapshot, { ...result.patches, tombstones: result.tombstones });
          const remaining = current.queue.filter((entry) => !acknowledged.has(entry.operation.operationId));
          const rebased = rebaseQueue(patched, result.tombstones, remaining, this.input.userId);
          const failed = rebased.queue.find((entry) => entry.state === "failed");
          const syncedAt = new Date(this.now()).toISOString();
          const next: AccountWorkspaceState = {
            ...current,
            snapshot: replaceSavedWorkspace(patched, rebased.snapshot),
            revision: result.revision,
            queue: rebased.queue,
            cachedAt: syncedAt,
            sync: rebased.queue.length
              ? { phase: "failed", ...(failed?.error ? { error: failed.error } : {}) }
              : { phase: "synced", lastSyncedAt: syncedAt, lastRevisionCheckAt: current.sync.lastRevisionCheckAt },
          };
          return [next, next] as const;
        });
        this.input.onSnapshotCommitted?.(structuredClone(completed.snapshot));
      } catch (error) {
        const message = errorMessage(error);
        const firstOperationId = eligible[0].operation.operationId;
        if (error instanceof WorkspaceConflictActionRequiredError) {
          const latest = await this.input.storage.loadOrThrow();
          this.input.onActionRequired?.(message);
          this.publish({ phase: "failed", revision: latest.revision, ...queueCounts(latest.queue), error: message });
          throw error;
        }
        const failed = await this.input.storage.update(async (current) => {
          const queue = current.queue.map((entry) => {
            if (entry.operation.operationId === firstOperationId) {
              return { ...entry, state: "failed" as const, attemptedAt, error: message };
            }
            if (eligibleIds.has(entry.operation.operationId)) {
              return { operation: entry.operation, state: "waiting" as const };
            }
            return entry;
          });
          const next: AccountWorkspaceState = { ...current, queue, sync: { ...current.sync, phase: "failed", error: message } };
          return [next, next] as const;
        });
        this.input.onActionRequired?.(message);
        this.publish({ phase: "failed", revision: failed.revision, ...queueCounts(failed.queue), error: message });
        if (error instanceof WorkspaceWriteBlockedError) throw error;
        if (error instanceof RemoteWorkspaceAuthenticationError || (error instanceof Error && error.name === "WorkspaceAuthenticationError")) {
          throw new WorkspaceAuthenticationError(message, firstOperationId);
        }
        if (error instanceof TypeError) throw new WorkspaceOfflineError(message, firstOperationId);
        throw new WorkspaceWriteFailedError(message, firstOperationId);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribeStorage?.();
    this.unsubscribeStorage = null;
    this.listeners.clear();
  }
}
