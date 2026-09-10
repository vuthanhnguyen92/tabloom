import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../shared/domain";
import type { WorkspaceOperation } from "../shared/workspace-operations";
import { LocalFirstStorage, type AccountWorkspaceState, type StorageArea } from "../extension/local-first-storage";
import { WorkspaceSyncCoordinator, type WorkspaceSyncState } from "../extension/workspace-sync-coordinator";
import {
  WorkspaceAuthenticationError,
  WorkspaceOfflineError,
  WorkspaceWriteBlockedError,
  WorkspaceWriteFailedError,
} from "../extension/workspace-sync-errors";
import { WorkspaceConflictActionRequiredError } from "../extension/workspace-sync-errors";
import {
  WorkspaceAuthenticationError as RemoteWorkspaceAuthenticationError,
  WorkspaceRevisionConflictError,
} from "../shared/workspace-sync-repository";
import type { WorkspaceSyncExclusiveRunner } from "../extension/workspace-sync-lock";
import type { WorkspaceSyncTransport } from "../extension/workspace-sync-transport";
import { LocalTrashRepository } from "../extension/local-trash-repository";
import { LocalFirstWorkspaceRepository } from "../extension/local-first-repository";

const USER_ID = "00000000-0000-4000-8000-00000000000a";
const SPACE_ID = "10000000-0000-4000-8000-000000000001";
const DEVICE_ID = "50000000-0000-4000-8000-000000000001";
const OPERATION_ID = "40000000-0000-4000-8000-000000000001";
const NOW = "2026-08-31T00:00:00.000Z";
const NEXT = "2026-08-31T00:01:00.000Z";

function workspace(name = "Local"): WorkspaceSnapshot {
  return {
    spaces: [{
      id: SPACE_ID,
      user_id: USER_ID,
      name,
      color: "#7357e6",
      position: 0,
      created_at: NOW,
      updated_at: NOW,
      origin: "saved",
      read_only: false,
    }],
    collections: [],
    links: [],
  };
}

function renameOperation(name = "Optimistic"): WorkspaceOperation {
  return {
    operationId: OPERATION_ID,
    deviceId: DEVICE_ID,
    sequence: 1,
    entity: "space",
    entityId: SPACE_ID,
    action: "update",
    payload: { name },
    createdAt: NOW,
    baseRevision: 1,
  };
}

function laterRenameOperation(name = "Later"): WorkspaceOperation {
  return {
    ...renameOperation(name),
    operationId: "40000000-0000-4000-8000-000000000002",
    sequence: 2,
  };
}

function state(overrides: Partial<AccountWorkspaceState> = {}): AccountWorkspaceState {
  return {
    snapshot: workspace(),
    revision: 1,
    cachedAt: NOW,
    queue: [],
    nextSequence: 1,
    sync: { phase: "synced" },
    ...overrides,
  };
}

function observableMemoryArea() {
  const values: Record<string, unknown> = {};
  const listeners = new Set<(keys: string[]) => void>();
  const area: StorageArea = {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (next: Record<string, unknown>) => {
      Object.assign(values, structuredClone(next));
      const keys = Object.keys(next);
      for (const listener of listeners) listener(keys);
    }),
    remove: vi.fn(async (key: string) => {
      delete values[key];
      for (const listener of listeners) listener([key]);
    }),
  };
  return {
    area,
    subscribe(listener: (keys: string[]) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function serialRunner(): WorkspaceSyncExclusiveRunner {
  let tail = Promise.resolve();
  return {
    async runExclusive(_userId, task) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

function transport(overrides: Partial<WorkspaceSyncTransport> = {}): WorkspaceSyncTransport {
  return {
    getRevision: vi.fn(async () => ({ revision: 1, serverTime: NEXT })),
    loadCanonical: vi.fn(async () => ({ revision: 1, snapshot: workspace("Server"), tombstones: [] })),
    applyOperations: vi.fn(async () => ({
      revision: 2,
      outcomes: [],
      patches: { spaces: [], collections: [], links: [] },
      tombstones: [],
      conflicts: [],
    })),
    ...overrides,
  };
}

async function setup(input: {
  initial?: AccountWorkspaceState;
  syncTransport?: WorkspaceSyncTransport;
  runner?: WorkspaceSyncExclusiveRunner;
} = {}) {
  const memory = observableMemoryArea();
  const storage = new LocalFirstStorage(memory.area, USER_ID, { subscribeToChanges: memory.subscribe });
  await storage.save(input.initial ?? state());
  const snapshots: WorkspaceSnapshot[] = [];
  const states: WorkspaceSyncState[] = [];
  const syncTransport = input.syncTransport ?? transport();
  const coordinator = new WorkspaceSyncCoordinator({
    userId: USER_ID,
    storage,
    transport: syncTransport,
    exclusiveRunner: input.runner ?? serialRunner(),
    now: () => Date.parse(NEXT),
    onSnapshotCommitted: (snapshot) => snapshots.push(snapshot),
  });
  coordinator.subscribe((syncState) => states.push(syncState));
  return { coordinator, memory, snapshots, states, storage, syncTransport };
}

describe("WorkspaceSyncCoordinator reads", () => {
  it("retries every interrupted operation without discarding attempt history", async () => {
    const operations = [renameOperation(), laterRenameOperation()];
    const syncTransport = transport({ applyOperations: vi.fn<WorkspaceSyncTransport["applyOperations"]>(async (sent) => ({ revision: 2, outcomes: sent.map((operation) => ({ operationId: operation.operationId, status: "applied" })), patches: workspace("Later"), tombstones: [], conflicts: [] })) });
    const { coordinator, storage } = await setup({ syncTransport, initial: state({ queue: operations.map((operation) => ({ operation, state: "failed", attemptedAt: NOW, error: "Interrupted" })), nextSequence: 3 }) });
    const observed: string[] = [];
    const apply = syncTransport.applyOperations;
    syncTransport.applyOperations = async (...args) => {
      observed.push(...(await storage.loadOrThrow()).queue.map((entry) => entry.attemptedAt!));
      return apply(...args);
    };
    await coordinator.retryFailed();
    expect((await storage.loadOrThrow()).queue).toEqual([]);
    expect(observed.every((timestamp) => timestamp === NOW)).toBe(true);
  });
  it("retries waiting operations even when a rejected dependency removed the failed head", async () => {
    const operation = renameOperation();
    const syncTransport = transport({ applyOperations: vi.fn(async () => ({ revision: 2, outcomes: [{ operationId: operation.operationId, status: "applied" as const }], patches: workspace("Optimistic"), tombstones: [], conflicts: [] })) });
    const { coordinator, storage } = await setup({ syncTransport, initial: state({ queue: [{ operation, state: "waiting", attemptedAt: NOW }], nextSequence: 2, sync: { phase: "failed", error: "Earlier restore was rejected" } }) });
    await coordinator.retryFailed();
    expect(syncTransport.applyOperations).toHaveBeenCalledOnce();
    expect((await storage.loadOrThrow()).queue).toEqual([]);
  });

  it("quarantines a rejected restore while acknowledging other operations in its batch", async () => {
    const deletion: WorkspaceOperation = { ...renameOperation(), action: "delete", payload: {} };
    const restoration: WorkspaceOperation = { ...laterRenameOperation(), action: "restore", payload: { deleteOperationId: deletion.operationId, snapshot: workspace() } };
    const later = { ...renameOperation("Later"), operationId: crypto.randomUUID(), sequence: 3 };
    const syncTransport = transport({ applyOperations: vi.fn(async () => ({ revision: 2, outcomes: [
      { operationId: deletion.operationId, status: "deleted" as const }, { operationId: restoration.operationId, status: "rejected" as const, message: "Recovery receipt unavailable" },
      { operationId: later.operationId, status: "applied" as const },
    ], patches: workspace("Later"), tombstones: [], conflicts: [] })) });
    const { coordinator, storage } = await setup({ syncTransport, initial: state({ queue: [deletion, restoration, later].map((operation) => ({ operation, state: "waiting" })), nextSequence: 4 }) });
    await expect(coordinator.submit(later)).rejects.toThrow("Recovery receipt unavailable");
    expect((await storage.loadOrThrow()).queue).toEqual([]);
    expect((await storage.loadOrThrow()).snapshot.spaces[0].name).toBe("Later");
  });
  it("does not attach storage listeners when stopped during its initial read", async () => {
    const { coordinator, storage, syncTransport, snapshots } = await setup();
    const gate = Promise.withResolvers<AccountWorkspaceState>();
    vi.spyOn(storage, "loadOrThrow").mockReturnValueOnce(gate.promise);
    const subscribe = vi.spyOn(storage, "subscribe");
    const starting = coordinator.start();
    coordinator.stop();
    gate.resolve(state());
    await starting;
    expect(subscribe).not.toHaveBeenCalled();
    expect(syncTransport.getRevision).not.toHaveBeenCalled();
    expect(snapshots).toEqual([]);
  });

  it("renders local state then checks one unchanged revision without flushing writes", async () => {
    const syncTransport = transport();
    const { coordinator, snapshots, states } = await setup({ syncTransport });

    await coordinator.start();

    expect(snapshots[0]).toEqual(workspace());
    expect(syncTransport.getRevision).toHaveBeenCalledOnce();
    expect(syncTransport.loadCanonical).not.toHaveBeenCalled();
    expect(syncTransport.applyOperations).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ phase: "synced", revision: 1, failed: 0, waiting: 0 });
  });

  it("merges changed canonical data and replays queued local work without uploading it", async () => {
    const operation = renameOperation();
    const syncTransport = transport({
      getRevision: vi.fn(async () => ({ revision: 2, serverTime: NEXT })),
      loadCanonical: vi.fn(async () => ({ revision: 2, snapshot: workspace("Server"), tombstones: [] })),
    });
    const { coordinator, storage } = await setup({
      initial: state({
        snapshot: workspace("Optimistic"),
        queue: [{ operation, state: "failed", error: "Retry required" }],
        nextSequence: 2,
        sync: { phase: "failed", error: "Retry required" },
      }),
      syncTransport,
    });

    await coordinator.start();

    const local = await storage.loadOrThrow();
    expect(local.snapshot.spaces[0].name).toBe("Optimistic");
    expect(local.revision).toBe(2);
    expect(local.queue).toEqual([{ operation, state: "failed", error: "Retry required" }]);
    expect(syncTransport.applyOperations).not.toHaveBeenCalled();
  });

  it("ignores overlapping focus reads instead of scheduling follow-up work", async () => {
    let releaseRevision!: () => void;
    const revisionGate = new Promise<void>((resolve) => { releaseRevision = resolve; });
    const syncTransport = transport({
      getRevision: vi.fn(async () => {
        await revisionGate;
        return { revision: 1, serverTime: NEXT };
      }),
    });
    const { coordinator } = await setup({ syncTransport });

    const first = coordinator.refreshOnFocus();
    const ignored = coordinator.refreshOnFocus();
    await vi.waitFor(() => expect(syncTransport.getRevision).toHaveBeenCalledOnce());
    releaseRevision();
    await Promise.all([first, ignored]);

    expect(syncTransport.getRevision).toHaveBeenCalledOnce();
  });

  it("renders account storage changes without starting network work", async () => {
    const syncTransport = transport();
    const { coordinator, snapshots, storage } = await setup({ syncTransport });
    await coordinator.start();
    vi.mocked(syncTransport.getRevision).mockClear();
    vi.mocked(syncTransport.loadCanonical).mockClear();
    vi.mocked(syncTransport.applyOperations).mockClear();

    await storage.update(async (current) => [{ ...current, snapshot: workspace("Other tab") }, undefined]);
    await vi.waitFor(() => expect(snapshots.at(-1)?.spaces[0].name).toBe("Other tab"));

    expect(syncTransport.getRevision).not.toHaveBeenCalled();
    expect(syncTransport.loadCanonical).not.toHaveBeenCalled();
    expect(syncTransport.applyOperations).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent initial reads across Tabloom pages", async () => {
    const memory = observableMemoryArea();
    const storageA = new LocalFirstStorage(memory.area, USER_ID, { subscribeToChanges: memory.subscribe });
    const storageB = new LocalFirstStorage(memory.area, USER_ID, { subscribeToChanges: memory.subscribe });
    await storageA.save(state());
    const runner = serialRunner();
    const syncTransport = transport();
    const coordinatorA = new WorkspaceSyncCoordinator({
      userId: USER_ID,
      storage: storageA,
      transport: syncTransport,
      exclusiveRunner: runner,
      now: () => Date.parse(NEXT),
    });
    const coordinatorB = new WorkspaceSyncCoordinator({
      userId: USER_ID,
      storage: storageB,
      transport: syncTransport,
      exclusiveRunner: runner,
      now: () => Date.parse(NEXT),
    });

    await Promise.all([coordinatorA.start(), coordinatorB.start()]);

    expect(syncTransport.getRevision).toHaveBeenCalledOnce();
    expect(syncTransport.loadCanonical).not.toHaveBeenCalled();
    expect(syncTransport.applyOperations).not.toHaveBeenCalled();
  });

  it("does not hold the local mutation transaction open during a canonical network read", async () => {
    let releaseCanonical!: () => void;
    const canonicalGate = new Promise<void>((resolve) => { releaseCanonical = resolve; });
    const syncTransport = transport({
      getRevision: vi.fn(async () => ({ revision: 2, serverTime: NEXT })),
      loadCanonical: vi.fn(async () => {
        await canonicalGate;
        return { revision: 2, snapshot: workspace("Server"), tombstones: [] };
      }),
    });
    const { coordinator, storage } = await setup({ syncTransport });
    const starting = coordinator.start();
    await vi.waitFor(() => expect(syncTransport.loadCanonical).toHaveBeenCalledOnce());

    const mutation = storage.update(async (current) => [{ ...current, snapshot: workspace("Typed now") }, undefined])
      .then(() => true);
    const settledBeforeNetwork = await Promise.race([
      mutation,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseCanonical();
    await Promise.all([starting, mutation]);

    expect(settledBeforeNetwork).toBe(true);
  });
});

describe("WorkspaceSyncCoordinator writes", () => {
  it("reconciles a local Trash receipt before acknowledging its durable delete", async () => {
    const { area } = observableMemoryArea();
    const storage = new LocalFirstStorage(area, USER_ID);
    await storage.save(state());
    const remoteId = crypto.randomUUID();
    const coordinator = new WorkspaceSyncCoordinator({ userId: USER_ID, storage, exclusiveRunner: serialRunner(),
      onDeleteReceipt: (receipt) => trash.reconcileRemote(receipt.operationId, receipt),
      transport: transport({ applyOperations: async (operations) => ({ revision: 2, outcomes: operations.map((operation) => ({ operationId: operation.operationId, status: "applied", trashId: remoteId, restoreUntil: "2099-01-01T00:00:00Z" })), patches: { spaces: [], collections: [], links: [] }, tombstones: [{ entity: "space", entityId: SPACE_ID, deletedRevision: 2, deletedAt: NOW }], conflicts: [] }) }),
    });
    const repository = await LocalFirstWorkspaceRepository.create({ userId: USER_ID, storage, onMutation: async (operations) => { for (const operation of operations) await coordinator.submit(operation); } });
    const trash = new LocalTrashRepository(area, repository, USER_ID);
    const intent = await trash.prepareDelete("space", SPACE_ID);
    await trash.deleteEntity("space", SPACE_ID, "extension", crypto.randomUUID(), intent.intentId);
    expect((await storage.loadOrThrow()).queue).toEqual([]);
    expect((await trash.list())[0].id).toBe(remoteId);
    coordinator.stop();
  });
  it("persists an optimistic mutation before its one immediate write settles", async () => {
    let resolveApply!: (value: Awaited<ReturnType<WorkspaceSyncTransport["applyOperations"]>>) => void;
    const pendingApply = new Promise<Awaited<ReturnType<WorkspaceSyncTransport["applyOperations"]>>>((resolve) => { resolveApply = resolve; });
    const syncTransport = transport({ applyOperations: vi.fn(() => pendingApply) });
    const { coordinator, storage } = await setup({ syncTransport });
    const operation = renameOperation();

    const submitting = coordinator.submit(operation);
    await vi.waitFor(() => expect(syncTransport.applyOperations).toHaveBeenCalledOnce());
    const optimistic = await storage.loadOrThrow();
    expect(optimistic.snapshot.spaces[0].name).toBe("Optimistic");
    expect(optimistic.queue).toEqual([expect.objectContaining({ operation, state: "waiting", attemptedAt: NEXT })]);

    resolveApply({
      revision: 2,
      outcomes: [{ operationId: OPERATION_ID, status: "applied" }],
      patches: { spaces: [], collections: [], links: [] },
      tombstones: [],
      conflicts: [],
    });
    await submitting;

    expect((await storage.loadOrThrow()).queue).toEqual([]);
    expect((await storage.loadOrThrow()).revision).toBe(2);
    expect(syncTransport.applyOperations).toHaveBeenCalledWith([operation], 1);
  });

  it("keeps a failed optimistic mutation and blocks later operations in sequence", async () => {
    const syncTransport = transport({ applyOperations: vi.fn(async () => { throw new Error("Network unavailable"); }) });
    const { coordinator, storage } = await setup({ syncTransport });
    const first = renameOperation();
    const second = laterRenameOperation();

    await expect(coordinator.submit(first)).rejects.toBeInstanceOf(WorkspaceWriteFailedError);
    await expect(coordinator.submit(second)).rejects.toBeInstanceOf(WorkspaceWriteBlockedError);

    const local = await storage.loadOrThrow();
    expect(local.snapshot.spaces[0].name).toBe("Later");
    expect(local.queue).toEqual([
      expect.objectContaining({ operation: first, state: "failed", error: "Network unavailable" }),
      expect.objectContaining({ operation: second, state: "waiting" }),
    ]);
    expect(syncTransport.applyOperations).toHaveBeenCalledOnce();
  });

  it("retries the failed operation then drains the finite waiting sequence in order", async () => {
    const first = renameOperation();
    const second = laterRenameOperation();
    let revision = 1;
    const syncTransport = transport({
      applyOperations: vi.fn(async (operations: WorkspaceOperation[]) => ({
        revision: ++revision,
        outcomes: operations.map((operation) => ({ operationId: operation.operationId, status: "applied" as const })),
        patches: { spaces: [], collections: [], links: [] },
        tombstones: [],
        conflicts: [],
      })),
    });
    const { coordinator, storage } = await setup({
      initial: state({
        snapshot: workspace("Later"),
        queue: [
          { operation: first, state: "failed", error: "Network unavailable" },
          { operation: second, state: "waiting" },
        ],
        nextSequence: 3,
        sync: { phase: "failed", error: "Network unavailable" },
      }),
      syncTransport,
    });

    await coordinator.retryFailed();

    expect(vi.mocked(syncTransport.applyOperations).mock.calls.map(([operations]) => operations.map((operation) => operation.operationId)))
      .toEqual([[first.operationId], [second.operationId]]);
    expect((await storage.loadOrThrow()).queue).toEqual([]);
    expect((await storage.loadOrThrow()).sync.phase).toBe("synced");
  });

  it("performs one canonical rebase and one bounded retry after a revision conflict", async () => {
    const operation = renameOperation();
    const applyOperations = vi.fn()
      .mockRejectedValueOnce(new WorkspaceRevisionConflictError())
      .mockResolvedValueOnce({
        revision: 3,
        outcomes: [{ operationId: operation.operationId, status: "applied" as const }],
        patches: { spaces: [], collections: [], links: [] },
        tombstones: [],
        conflicts: [],
      });
    const syncTransport = transport({
      applyOperations,
      loadCanonical: vi.fn(async () => ({ revision: 2, snapshot: workspace("Server"), tombstones: [] })),
    });
    const { coordinator, storage } = await setup({ syncTransport });

    await coordinator.submit(operation);

    expect(applyOperations).toHaveBeenCalledTimes(2);
    expect(applyOperations.mock.calls[0][1]).toBe(1);
    expect(applyOperations.mock.calls[1][1]).toBe(2);
    expect(syncTransport.loadCanonical).toHaveBeenCalledOnce();
    expect((await storage.loadOrThrow()).snapshot.spaces[0].name).toBe("Optimistic");
    expect((await storage.loadOrThrow()).queue).toEqual([]);
  });

  it("stops after the bounded conflict retry fails", async () => {
    const applyOperations = vi.fn(async () => { throw new WorkspaceRevisionConflictError(); });
    const syncTransport = transport({
      applyOperations,
      loadCanonical: vi.fn(async () => ({ revision: 2, snapshot: workspace("Server"), tombstones: [] })),
    });
    const { coordinator, storage } = await setup({ syncTransport });

    await expect(coordinator.submit(renameOperation())).rejects.toBeInstanceOf(WorkspaceWriteFailedError);

    expect(applyOperations).toHaveBeenCalledTimes(2);
    expect(syncTransport.loadCanonical).toHaveBeenCalledOnce();
    expect((await storage.loadOrThrow()).queue[0]).toMatchObject({ state: "failed" });
  });

  it("removes an impossible operation and applies its remote tombstone as action required", async () => {
    const operation = renameOperation();
    const syncTransport = transport({
      applyOperations: vi.fn(async () => ({
        revision: 2,
        outcomes: [{ operationId: operation.operationId, status: "rejected" as const, code: "missing_parent", message: "Space was deleted elsewhere" }],
        patches: { spaces: [], collections: [], links: [] },
        tombstones: [{ entity: "space" as const, entityId: SPACE_ID, deletedRevision: 2, deletedAt: NEXT }],
        conflicts: [{ operationId: operation.operationId, code: "missing_parent", message: "Space was deleted elsewhere" }],
      })),
    });
    const { coordinator, storage } = await setup({ syncTransport });

    await expect(coordinator.submit(operation)).rejects.toBeInstanceOf(WorkspaceConflictActionRequiredError);

    const local = await storage.loadOrThrow();
    expect(local.queue).toEqual([]);
    expect(local.snapshot.spaces).toEqual([]);
    expect(local.sync).toMatchObject({ phase: "failed", error: "Space was deleted elsewhere" });
  });

  it.each([
    [new RemoteWorkspaceAuthenticationError("Session expired"), WorkspaceAuthenticationError],
    [new TypeError("Failed to fetch"), WorkspaceOfflineError],
  ])("returns a typed UI error for %s", async (transportError, ExpectedError) => {
    const syncTransport = transport({ applyOperations: vi.fn(async () => { throw transportError; }) });
    const { coordinator, storage } = await setup({ syncTransport });

    await expect(coordinator.submit(renameOperation())).rejects.toBeInstanceOf(ExpectedError);

    expect((await storage.loadOrThrow()).queue[0]).toMatchObject({ state: "failed", error: transportError.message });
  });
});
