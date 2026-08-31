import { describe, expect, it, vi } from "vitest";
import type { StorageArea } from "../extension/workspace-cache";
import { WorkspaceSyncLock, workspaceSyncLeaseKey, type LockManagerLike } from "../extension/workspace-sync-lock";

const USER_ID = "00000000-0000-4000-8000-00000000000a";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function serialLockManager(): LockManagerLike {
  const tails = new Map<string, Promise<void>>();
  return {
    async request(name, callback) {
      const previous = tails.get(name) ?? Promise.resolve();
      const gate = deferred();
      const tail = previous.then(() => gate.promise);
      tails.set(name, tail);
      await previous;
      try {
        return await callback();
      } finally {
        gate.resolve();
        if (tails.get(name) === tail) tails.delete(name);
      }
    },
  };
}

function observableMemoryArea(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  const listeners = new Set<(key: string) => void>();
  const area: StorageArea = {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (next: Record<string, unknown>) => {
      Object.assign(values, next);
      for (const key of Object.keys(next)) for (const listener of listeners) listener(key);
    }),
    remove: vi.fn(async (key: string) => {
      delete values[key];
      for (const listener of listeners) listener(key);
    }),
  };
  return {
    area,
    values,
    waitForChange(key: string) {
      return new Promise<void>((resolve) => {
        const listener = (changedKey: string) => {
          if (changedKey !== key) return;
          listeners.delete(listener);
          resolve();
        };
        listeners.add(listener);
      });
    },
  };
}

describe("WorkspaceSyncLock", () => {
  it("serializes the same account through Web Locks while allowing another account", async () => {
    const lock = new WorkspaceSyncLock({ area: observableMemoryArea().area, locks: serialLockManager() });
    const firstGate = deferred();
    const calls: string[] = [];

    const first = lock.runExclusive(USER_ID, async () => {
      calls.push("first:start");
      await firstGate.promise;
      calls.push("first:end");
    });
    const second = lock.runExclusive(USER_ID, async () => { calls.push("second"); });
    const other = lock.runExclusive("another-user", async () => { calls.push("other"); });

    await vi.waitFor(() => expect(calls).toEqual(["first:start", "other"]));
    firstGate.resolve();
    await Promise.all([first, second, other]);
    expect(calls).toEqual(["first:start", "other", "first:end", "second"]);
  });

  it("uses the storage lease to serialize fallback callers", async () => {
    const memory = observableMemoryArea();
    const firstGate = deferred();
    const calls: string[] = [];
    const first = new WorkspaceSyncLock({
      area: memory.area,
      ownerId: "owner-a",
      now: () => 100,
      leaseMs: 1_000,
      waitForLeaseChange: (key) => memory.waitForChange(key),
    });
    const second = new WorkspaceSyncLock({
      area: memory.area,
      ownerId: "owner-b",
      now: () => 100,
      leaseMs: 1_000,
      waitForLeaseChange: (key) => memory.waitForChange(key),
    });

    const firstRun = first.runExclusive(USER_ID, async () => {
      calls.push("first");
      await firstGate.promise;
    });
    await vi.waitFor(() => expect(calls).toEqual(["first"]));
    const secondRun = second.runExclusive(USER_ID, async () => { calls.push("second"); });
    await Promise.resolve();
    expect(calls).toEqual(["first"]);
    firstGate.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(calls).toEqual(["first", "second"]);
  });

  it("recovers an expired fallback lease", async () => {
    const key = workspaceSyncLeaseKey(USER_ID);
    const memory = observableMemoryArea({ [key]: { ownerId: "dead-owner", expiresAt: 99 } });
    const lock = new WorkspaceSyncLock({
      area: memory.area,
      ownerId: "new-owner",
      now: () => 100,
      leaseMs: 1_000,
      waitForLeaseChange: (changedKey) => memory.waitForChange(changedKey),
    });

    await expect(lock.runExclusive(USER_ID, async () => "recovered")).resolves.toBe("recovered");
    expect(memory.values[key]).toBeUndefined();
  });

  it("does not release a lease that another owner replaced", async () => {
    const key = workspaceSyncLeaseKey(USER_ID);
    const memory = observableMemoryArea();
    const lock = new WorkspaceSyncLock({
      area: memory.area,
      ownerId: "original-owner",
      now: () => 100,
      leaseMs: 1_000,
      waitForLeaseChange: (changedKey) => memory.waitForChange(changedKey),
    });

    await lock.runExclusive(USER_ID, async () => {
      await memory.area.set({ [key]: { ownerId: "replacement-owner", expiresAt: 2_000 } });
    });

    expect(memory.values[key]).toEqual({ ownerId: "replacement-owner", expiresAt: 2_000 });
  });
});
