import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../shared/domain";
import type { WorkspaceOperation } from "../shared/workspace-operations";
import {
  LocalFirstStorage,
  accountOutboxKey,
  accountSyncStateKey,
  accountWorkspaceKey,
  corruptWorkspaceKey,
  deviceIdKey,
  legacyCloudWorkspaceKey,
  type StorageArea,
} from "../extension/local-first-storage";

const USER_ID = "00000000-0000-4000-8000-00000000000a";
const DEVICE_ID = "00000000-0000-4000-8000-00000000000d";
const NOW = "2026-08-31T00:00:00.000Z";

function memoryArea(initial: Record<string, unknown> = {}) {
  const state = { ...initial };
  const area: StorageArea = {
    get: vi.fn(async (key: string) => ({ [key]: state[key] })),
    set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(state, value); }),
  };
  return { area, state };
}

function snapshot(userId = USER_ID): WorkspaceSnapshot {
  return {
    spaces: [{ id: "10000000-0000-4000-8000-000000000001", user_id: userId, name: "My Space", color: "#7357e6", position: 0, created_at: NOW, updated_at: NOW, origin: "saved", read_only: false }],
    collections: [],
    links: [],
  };
}

function operation(): WorkspaceOperation {
  return {
    operationId: "40000000-0000-4000-8000-000000000001",
    deviceId: DEVICE_ID,
    sequence: 1,
    entity: "space",
    entityId: "10000000-0000-4000-8000-000000000001",
    action: "update",
    payload: { name: "Renamed" },
    createdAt: NOW,
    baseRevision: 2,
  };
}

describe("LocalFirstStorage", () => {
  it("uses the approved account-scoped storage keys", () => {
    expect(accountWorkspaceKey("user-a")).toBe("tabloom-cloud-workspace-v2:user-a");
    expect(accountOutboxKey("user-a")).toBe("tabloom-sync-outbox-v1:user-a");
    expect(accountSyncStateKey("user-a")).toBe("tabloom-sync-state-v2:user-a");
    expect(accountWorkspaceKey("user-b")).not.toBe(accountWorkspaceKey("user-a"));
    expect(deviceIdKey).toBe("tabloom-device-id-v1");
  });

  it("writes workspace, outbox, and sync state atomically", async () => {
    const { area, state } = memoryArea();
    const storage = new LocalFirstStorage(area, USER_ID);
    await storage.saveCanonical(snapshot(), 2);
    const pending = operation();

    await storage.update(async (current) => [{
      ...current,
      outbox: [pending],
      nextSequence: 2,
      sync: { ...current.sync, phase: "offline", error: "offline" },
    }, undefined]);

    expect(area.set).toHaveBeenLastCalledWith({
      [accountWorkspaceKey(USER_ID)]: expect.objectContaining({ version: 2, revision: 2, snapshot: snapshot() }),
      [accountOutboxKey(USER_ID)]: { version: 1, outbox: [pending], nextSequence: 2 },
      [accountSyncStateKey(USER_ID)]: expect.objectContaining({ version: 2, revision: 2, phase: "offline", error: "offline" }),
    });
    expect(state[accountOutboxKey(USER_ID)]).toMatchObject({ outbox: [pending] });
  });

  it("migrates v1 cloud data once without deleting the recovery key", async () => {
    const legacy = { snapshot: snapshot(), revision: 7 };
    const { area, state } = memoryArea({ [legacyCloudWorkspaceKey(USER_ID)]: legacy });
    const storage = new LocalFirstStorage(area, USER_ID);

    await expect(storage.migrateV1()).resolves.toMatchObject({ revision: 7, outbox: [], nextSequence: 1 });
    await storage.migrateV1();

    expect(state[legacyCloudWorkspaceKey(USER_ID)]).toEqual(legacy);
    expect(state[accountWorkspaceKey(USER_ID)]).toMatchObject({ version: 2, revision: 7, snapshot: legacy.snapshot });
    expect(state[accountOutboxKey(USER_ID)]).toEqual({ version: 1, outbox: [], nextSequence: 1 });
    expect(area.set).toHaveBeenCalledTimes(1);
  });

  it("quarantines an invalid v2 workspace while preserving a valid outbox", async () => {
    const pending = operation();
    const invalid = { version: 2, revision: -1, snapshot: { spaces: [] } };
    const { area, state } = memoryArea({
      [accountWorkspaceKey(USER_ID)]: invalid,
      [accountOutboxKey(USER_ID)]: { version: 1, outbox: [pending], nextSequence: 2 },
    });
    const storage = new LocalFirstStorage(area, USER_ID, { now: () => 1234 });

    expect(await storage.load()).toBeNull();
    await storage.migrateV1();

    expect(state[corruptWorkspaceKey(USER_ID, 1234)]).toEqual(invalid);
    expect(state[accountOutboxKey(USER_ID)]).toMatchObject({ outbox: [pending] });
  });

  it("rejects malformed outbox operations instead of using partial state", async () => {
    const { area } = memoryArea({
      [accountWorkspaceKey(USER_ID)]: { version: 2, snapshot: snapshot(), revision: 1, cachedAt: NOW },
      [accountOutboxKey(USER_ID)]: { version: 1, outbox: [{ action: "update" }], nextSequence: 2 },
      [accountSyncStateKey(USER_ID)]: { version: 2, phase: "synced", revision: 1, lastSyncedAt: NOW },
    });
    expect(await new LocalFirstStorage(area, USER_ID).load()).toBeNull();
  });

  it("creates one browser-wide device UUID and reuses it across accounts", async () => {
    const { area } = memoryArea();
    const first = new LocalFirstStorage(area, USER_ID);
    const second = new LocalFirstStorage(area, "00000000-0000-4000-8000-00000000000b");

    const firstId = await first.getOrCreateDeviceId();
    const secondId = await second.getOrCreateDeviceId();

    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondId).toBe(firstId);
  });

  it("preserves bookmark records and pending operations when saving canonical data", async () => {
    const initial = snapshot();
    initial.spaces.push({ ...initial.spaces[0], id: "browser-space", origin: "browser-bookmark", read_only: true });
    const pending = operation();
    const { area } = memoryArea();
    const storage = new LocalFirstStorage(area, USER_ID);
    await storage.save({ snapshot: initial, revision: 2, cachedAt: NOW, outbox: [pending], nextSequence: 2, sync: { phase: "offline" } });

    const remote = snapshot();
    remote.spaces[0] = { ...remote.spaces[0], name: "Remote" };
    await storage.saveCanonical(remote, 3);

    expect(await storage.load()).toMatchObject({
      revision: 3,
      outbox: [pending],
      nextSequence: 2,
      snapshot: { spaces: expect.arrayContaining([
        expect.objectContaining({ name: "Remote" }),
        expect.objectContaining({ id: "browser-space", origin: "browser-bookmark" }),
      ]) },
    });
  });
});
