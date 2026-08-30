import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../shared/domain";
import type { WorkspaceOperation } from "../shared/workspace-operations";
import { LocalFirstStorage, type AccountWorkspaceState, type StorageArea } from "../extension/local-first-storage";
import { LocalFirstWorkspaceRepository } from "../extension/local-first-repository";
import type { ApplyOperationsResult, WorkspaceSyncTransport } from "../extension/workspace-sync-transport";
import { WorkspaceSyncEngine } from "../extension/workspace-sync-engine";
import { WorkspaceRevisionConflictError } from "../shared/workspace-sync-repository";

const USER_ID = "00000000-0000-4000-8000-00000000000a";
const SPACE_ID = "10000000-0000-4000-8000-000000000001";
const OPERATION_ID = "40000000-0000-4000-8000-000000000001";
const LATER_OPERATION_ID = "40000000-0000-4000-8000-000000000002";
const DEVICE_ID = "50000000-0000-4000-8000-000000000001";
const timestamp = "2026-08-31T00:00:00.000Z";

const empty: WorkspaceSnapshot = { spaces: [], collections: [], links: [] };
const operation: WorkspaceOperation = {
  operationId: OPERATION_ID,
  deviceId: DEVICE_ID,
  sequence: 1,
  entity: "space",
  entityId: SPACE_ID,
  action: "create",
  payload: {
    id: SPACE_ID,
    name: "Research",
    color: "#7357e6",
    position: 0,
    created_at: timestamp,
    updated_at: timestamp,
  },
  createdAt: timestamp,
  baseRevision: 0,
};

const laterOperation: WorkspaceOperation = {
  ...operation,
  operationId: LATER_OPERATION_ID,
  sequence: 2,
  action: "update",
  payload: { name: "Latest local name" },
};

function state(overrides: Partial<AccountWorkspaceState> = {}): AccountWorkspaceState {
  return {
    snapshot: empty,
    revision: 0,
    cachedAt: timestamp,
    outbox: [],
    nextSequence: 1,
    sync: { phase: "synced" },
    ...overrides,
  };
}

function storageWith(initial: AccountWorkspaceState) {
  let current = structuredClone(initial);
  const storage = {
    loadOrThrow: vi.fn(async () => structuredClone(current)),
    update: vi.fn(async (mutator) => {
      const [next, result] = await mutator(structuredClone(current));
      current = structuredClone(next);
      return result;
    }),
  } as unknown as LocalFirstStorage;
  return { storage, read: () => structuredClone(current) };
}

function transportWith(overrides: Partial<WorkspaceSyncTransport> = {}) {
  return {
    getRevision: vi.fn(async () => ({ revision: 0, serverTime: timestamp })),
    applyOperations: vi.fn(async () => ({
      revision: 1,
      outcomes: [{ operationId: OPERATION_ID, status: "applied" as const }],
      patches: { spaces: [], collections: [], links: [] },
      tombstones: [],
      conflicts: [],
    })),
    loadCanonical: vi.fn(async () => ({ revision: 0, snapshot: empty, tombstones: [] })),
    ...overrides,
  } satisfies WorkspaceSyncTransport;
}

afterEach(() => vi.useRealTimers());

describe("WorkspaceSyncEngine", () => {
  it("debounces mutation requests and batches the persisted outbox", async () => {
    vi.useFakeTimers();
    const { storage } = storageWith(state({ outbox: [operation] }));
    const transport = transportWith();
    const engine = new WorkspaceSyncEngine({ storage, transport, mutationDebounceMs: 500 });

    engine.requestSync("mutation");
    engine.requestSync("mutation");
    engine.requestSync("mutation");
    await vi.advanceTimersByTimeAsync(499);
    expect(transport.applyOperations).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(transport.applyOperations).toHaveBeenCalledTimes(1);
    expect(transport.applyOperations).toHaveBeenCalledWith([operation], 0);
  });

  it("pushes startup changes before checking the revision", async () => {
    const calls: string[] = [];
    const { storage } = storageWith(state({ outbox: [operation] }));
    const transport = transportWith({
      applyOperations: vi.fn(async () => { calls.push("push"); return transportWith().applyOperations([], 0); }),
      getRevision: vi.fn(async () => { calls.push("revision"); return { revision: 1, serverTime: timestamp }; }),
    });
    await new WorkspaceSyncEngine({ storage, transport }).start();
    expect(calls).toEqual(["push", "revision"]);
  });

  it("does not pull when the remote revision is unchanged", async () => {
    const { storage } = storageWith(state({ revision: 3 }));
    const transport = transportWith({
      getRevision: vi.fn(async () => ({ revision: 3, serverTime: timestamp })),
    });
    await new WorkspaceSyncEngine({ storage, transport }).start();
    expect(transport.getRevision).toHaveBeenCalledOnce();
    expect(transport.loadCanonical).not.toHaveBeenCalled();
  });

  it("runs one follow-up cycle for overlapping refreshes", async () => {
    let resolveRevision!: (value: { revision: number; serverTime: string }) => void;
    const first = new Promise<{ revision: number; serverTime: string }>((resolve) => { resolveRevision = resolve; });
    const { storage } = storageWith(state());
    const transport = transportWith({
      getRevision: vi.fn()
        .mockImplementationOnce(() => first)
        .mockResolvedValue({ revision: 0, serverTime: timestamp }),
    });
    const engine = new WorkspaceSyncEngine({ storage, transport });
    const one = engine.refresh();
    const two = engine.refresh();
    const three = engine.refresh();
    await vi.waitFor(() => expect(transport.getRevision).toHaveBeenCalledOnce());
    resolveRevision({ revision: 0, serverTime: timestamp });
    await Promise.all([one, two, three]);
    expect(transport.getRevision).toHaveBeenCalledTimes(2);
  });

  it("applies patches and acknowledges operations atomically", async () => {
    const { storage, read } = storageWith(state({ outbox: [operation] }));
    const savedSpace = {
      ...operation.payload,
      user_id: USER_ID,
      origin: "saved" as const,
      read_only: false,
    };
    const transport = transportWith({
      applyOperations: vi.fn(async () => ({
        revision: 1,
        outcomes: [{ operationId: OPERATION_ID, status: "applied" as const }],
        patches: { spaces: [savedSpace], collections: [], links: [] },
        tombstones: [],
        conflicts: [],
      })),
      getRevision: vi.fn(async () => ({ revision: 1, serverTime: timestamp })),
    });
    await new WorkspaceSyncEngine({ storage, transport }).refresh();
    expect(read().snapshot.spaces).toEqual([savedSpace]);
    expect(read().outbox).toEqual([]);
    expect(read().revision).toBe(1);
  });

  it("keeps and replays operations queued while an earlier batch is in flight", async () => {
    let resolvePush!: (value: Awaited<ReturnType<WorkspaceSyncTransport["applyOperations"]>>) => void;
    const push = new Promise<Awaited<ReturnType<WorkspaceSyncTransport["applyOperations"]>>>((resolve) => { resolvePush = resolve; });
    const immutableOperationIds = new Set<string>();
    const { storage, read } = storageWith(state({
      snapshot: { ...empty, spaces: [{ ...operation.payload, user_id: USER_ID, origin: "saved", read_only: false }] },
      outbox: [operation],
      nextSequence: 2,
    }));
    const transport = transportWith({ applyOperations: vi.fn(() => push) });
    const engine = new WorkspaceSyncEngine({ storage, transport, immutableOperationIds });

    const running = engine.refresh();
    await vi.waitFor(() => expect(immutableOperationIds).toEqual(new Set([OPERATION_ID])));
    await storage.update(async (current) => [{
      ...current,
      snapshot: { ...current.snapshot, spaces: current.snapshot.spaces.map((space) => ({ ...space, name: "Latest local name" })) },
      outbox: [...current.outbox, laterOperation],
      nextSequence: 3,
    }, undefined]);
    resolvePush({
      revision: 1,
      outcomes: [{ operationId: OPERATION_ID, status: "applied" }],
      patches: { spaces: [{ ...operation.payload, user_id: USER_ID, name: "Server name", origin: "saved", read_only: false }], collections: [], links: [] },
      tombstones: [],
      conflicts: [],
    });
    await running;

    expect(read().outbox).toEqual([laterOperation]);
    expect(read().snapshot.spaces[0].name).toBe("Latest local name");
    expect(immutableOperationIds).toEqual(new Set());
  });

  it("preserves an edit from a second new-tab page while the first page uploads a create", async () => {
    const values: Record<string, unknown> = {};
    const area: StorageArea = {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
    };
    const storageA = new LocalFirstStorage(area, USER_ID);
    const storageB = new LocalFirstStorage(area, USER_ID);
    await storageA.saveCanonical(empty, 0);
    const immutableA = new Set<string>();
    const repositoryA = await LocalFirstWorkspaceRepository.create({
      userId: USER_ID,
      storage: storageA,
      onMutation: vi.fn(),
      immutableOperationIds: () => immutableA,
    });
    const repositoryB = await LocalFirstWorkspaceRepository.create({
      userId: USER_ID,
      storage: storageB,
      onMutation: vi.fn(),
      immutableOperationIds: () => new Set(),
    });
    const created = await repositoryA.createSpace({ name: "First page", color: "#7357e6" });
    let resolvePush!: (value: Awaited<ReturnType<WorkspaceSyncTransport["applyOperations"]>>) => void;
    const transport = transportWith({
      applyOperations: vi.fn(() => new Promise<ApplyOperationsResult>((resolve) => { resolvePush = resolve; })),
      getRevision: vi.fn(async () => ({ revision: 1, serverTime: timestamp })),
    });
    const engine = new WorkspaceSyncEngine({ userId: USER_ID, storage: storageA, transport, immutableOperationIds: immutableA });

    const running = engine.refresh();
    await vi.waitFor(() => expect(transport.applyOperations).toHaveBeenCalledOnce());
    await repositoryB.updateSpace(created.id, { name: "Second page edit" });
    resolvePush({
      revision: 1,
      outcomes: [{ operationId: (await storageA.loadOrThrow()).outbox[0].operationId, status: "applied" }],
      patches: { spaces: [{ ...created, name: "First page" }], collections: [], links: [] },
      tombstones: [],
      conflicts: [],
    });
    await running;

    const current = await storageA.loadOrThrow();
    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({ action: "update", payload: { name: "Second page edit" } });
    expect(current.snapshot.spaces[0].name).toBe("Second page edit");
  });

  it("pulls newer canonical data while preserving bookmark records", async () => {
    const bookmark = {
      id: "10000000-0000-4000-8000-000000000002",
      user_id: USER_ID,
      name: "Bookmarks",
      color: "#444444",
      position: 0,
      created_at: timestamp,
      updated_at: timestamp,
      origin: "browser-bookmark" as const,
      read_only: true,
    };
    const { storage, read } = storageWith(state({ snapshot: { ...empty, spaces: [bookmark] } }));
    const transport = transportWith({
      getRevision: vi.fn(async () => ({ revision: 2, serverTime: timestamp })),
      loadCanonical: vi.fn(async () => ({ revision: 2, snapshot: empty, tombstones: [] })),
    });
    await new WorkspaceSyncEngine({ storage, transport }).refresh();
    expect(read().snapshot.spaces).toEqual([bookmark]);
    expect(read().revision).toBe(2);
  });

  it("publishes a committed snapshot after pulling remote changes", async () => {
    const remoteSpace = { ...operation.payload, user_id: USER_ID, origin: "saved" as const, read_only: false };
    const onSnapshotCommitted = vi.fn();
    const { storage } = storageWith(state());
    const transport = transportWith({
      getRevision: vi.fn(async () => ({ revision: 2, serverTime: timestamp })),
      loadCanonical: vi.fn(async () => ({ revision: 2, snapshot: { ...empty, spaces: [remoteSpace] }, tombstones: [] })),
    });
    await new WorkspaceSyncEngine({ storage, transport, onSnapshotCommitted }).refresh();
    expect(onSnapshotCommitted).toHaveBeenLastCalledWith(expect.objectContaining({ spaces: [remoteSpace] }));
  });

  it("retains rejected operations and reports their server message", async () => {
    const onActionRequired = vi.fn();
    const { storage, read } = storageWith(state({ outbox: [operation] }));
    const transport = transportWith({
      applyOperations: vi.fn(async () => ({
        revision: 1,
        outcomes: [{ operationId: OPERATION_ID, status: "rejected" as const, message: "Invalid reorder" }],
        patches: empty,
        tombstones: [],
        conflicts: [{ operationId: OPERATION_ID, code: "invalid_reorder", message: "Invalid reorder" }],
      })),
      getRevision: vi.fn(async () => ({ revision: 1, serverTime: timestamp })),
    });
    await new WorkspaceSyncEngine({ storage, transport, onActionRequired }).refresh();
    expect(read().outbox).toEqual([operation]);
    expect(onActionRequired).toHaveBeenCalledWith("Invalid reorder");
  });

  it("rebases once after a conflict and reports rejected tombstoned work", async () => {
    const localSpace = {
      ...operation.payload,
      user_id: USER_ID,
      origin: "saved" as const,
      read_only: false,
    };
    const { storage, read } = storageWith(state({ snapshot: { ...empty, spaces: [localSpace] }, outbox: [operation] }));
    const onActionRequired = vi.fn();
    const transport = transportWith({
      applyOperations: vi.fn()
        .mockRejectedValueOnce(new WorkspaceRevisionConflictError())
        .mockResolvedValue({ revision: 2, outcomes: [], patches: empty, tombstones: [], conflicts: [] }),
      loadCanonical: vi.fn(async () => ({
        revision: 2,
        snapshot: empty,
        tombstones: [{ entity: "space" as const, entityId: SPACE_ID, deletedRevision: 2, deletedAt: timestamp }],
      })),
      getRevision: vi.fn(async () => ({ revision: 2, serverTime: timestamp })),
    });
    await new WorkspaceSyncEngine({ storage, transport, onActionRequired }).refresh();
    expect(read().outbox).toEqual([]);
    expect(read().snapshot.spaces).toEqual([]);
    expect(onActionRequired).toHaveBeenCalledOnce();
  });

  it("keeps pending changes and publishes offline after a second conflict", async () => {
    const localSpace = { ...operation.payload, user_id: USER_ID, origin: "saved" as const, read_only: false };
    const { storage, read } = storageWith(state({ snapshot: { ...empty, spaces: [localSpace] }, outbox: [operation] }));
    const transport = transportWith({
      applyOperations: vi.fn().mockRejectedValue(new WorkspaceRevisionConflictError()),
      loadCanonical: vi.fn(async () => ({ revision: 1, snapshot: empty, tombstones: [] })),
    });
    const phases: string[] = [];
    const engine = new WorkspaceSyncEngine({ storage, transport });
    engine.subscribe((next) => phases.push(next.phase));
    await engine.refresh();
    expect(read().outbox).toEqual([operation]);
    expect(phases.at(-1)).toBe("offline");
  });

  it("rebases operations added while the canonical conflict snapshot is loading", async () => {
    const localSpace = { ...operation.payload, user_id: USER_ID, origin: "saved" as const, read_only: false };
    const { storage, read } = storageWith(state({ snapshot: { ...empty, spaces: [localSpace] }, outbox: [operation], nextSequence: 2 }));
    const transport = transportWith({
      applyOperations: vi.fn()
        .mockRejectedValueOnce(new WorkspaceRevisionConflictError())
        .mockResolvedValueOnce({
          revision: 2,
          outcomes: [
            { operationId: OPERATION_ID, status: "applied" as const },
            { operationId: LATER_OPERATION_ID, status: "applied" as const },
          ],
          patches: { spaces: [{ ...localSpace, name: "Latest local name" }], collections: [], links: [] },
          tombstones: [],
          conflicts: [],
        }),
      loadCanonical: vi.fn(async () => {
        await storage.update(async (current) => [{
          ...current,
          snapshot: { ...current.snapshot, spaces: current.snapshot.spaces.map((space) => ({ ...space, name: "Latest local name" })) },
          outbox: [...current.outbox, laterOperation],
          nextSequence: 3,
        }, undefined]);
        return { revision: 1, snapshot: empty, tombstones: [] };
      }),
      getRevision: vi.fn(async () => ({ revision: 2, serverTime: timestamp })),
    });

    await new WorkspaceSyncEngine({ storage, transport }).refresh();

    expect(transport.applyOperations).toHaveBeenNthCalledWith(2, [operation, laterOperation], 1);
    expect(read().outbox).toEqual([]);
    expect(read().snapshot.spaces[0].name).toBe("Latest local name");
  });

  it("syncs online immediately and checks focus only after freshness expires", async () => {
    vi.useFakeTimers();
    let now = Date.parse(timestamp);
    const { storage } = storageWith(state({
      sync: { phase: "synced", lastRevisionCheckAt: new Date(now).toISOString() },
    }));
    const transport = transportWith();
    const engine = new WorkspaceSyncEngine({ storage, transport, now: () => now });
    await engine.start();
    vi.mocked(transport.getRevision).mockClear();

    engine.requestSync("focus");
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.getRevision).not.toHaveBeenCalled();

    engine.requestSync("online");
    await vi.runAllTimersAsync();
    expect(transport.getRevision).toHaveBeenCalledOnce();

    vi.mocked(transport.getRevision).mockClear();
    now += 30_000;
    engine.requestSync("focus");
    await vi.runAllTimersAsync();
    expect(transport.getRevision).toHaveBeenCalledOnce();
  });

  it("immediately publishes state to subscribers and honors unsubscribe", async () => {
    const { storage } = storageWith(state());
    const engine = new WorkspaceSyncEngine({ storage, transport: transportWith() });
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    expect(listener).toHaveBeenCalledWith({ phase: "offline", revision: 0, pending: 0 });
    unsubscribe();
    await engine.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not write a completed request after the engine is stopped", async () => {
    let resolveRevision!: (value: { revision: number; serverTime: string }) => void;
    const revision = new Promise<{ revision: number; serverTime: string }>((resolve) => { resolveRevision = resolve; });
    const { storage, read } = storageWith(state());
    const transport = transportWith({ getRevision: vi.fn(() => revision) });
    const engine = new WorkspaceSyncEngine({ storage, transport });
    const running = engine.refresh();
    await vi.waitFor(() => expect(transport.getRevision).toHaveBeenCalledOnce());
    engine.stop();
    resolveRevision({ revision: 9, serverTime: timestamp });
    await running;
    expect(read().revision).toBe(0);
    expect(transport.loadCanonical).not.toHaveBeenCalled();
  });
});
