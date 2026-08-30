import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../shared/domain";
import type { WorkspaceOperation } from "../shared/workspace-operations";
import type { AccountWorkspaceState, LocalFirstStorage } from "../extension/local-first-storage";
import type { WorkspaceSyncTransport } from "../extension/workspace-sync-transport";
import { WorkspaceSyncEngine } from "../extension/workspace-sync-engine";
import { WorkspaceRevisionConflictError } from "../shared/workspace-sync-repository";

const USER_ID = "00000000-0000-4000-8000-00000000000a";
const SPACE_ID = "10000000-0000-4000-8000-000000000001";
const OPERATION_ID = "40000000-0000-4000-8000-000000000001";
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
