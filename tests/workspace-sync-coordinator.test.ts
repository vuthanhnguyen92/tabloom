import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../shared/domain";
import type { WorkspaceOperation } from "../shared/workspace-operations";
import { LocalFirstStorage, type AccountWorkspaceState, type StorageArea } from "../extension/local-first-storage";
import { WorkspaceSyncCoordinator, type WorkspaceSyncState } from "../extension/workspace-sync-coordinator";
import type { WorkspaceSyncExclusiveRunner } from "../extension/workspace-sync-lock";
import type { WorkspaceSyncTransport } from "../extension/workspace-sync-transport";

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
