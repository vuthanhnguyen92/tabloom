import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot, type WorkspaceSnapshot } from "../shared/domain";
import {
  BrowserWorkspaceCache,
  LEGACY_WORKSPACE_KEY,
  LOCAL_WORKSPACE_KEY,
  cloudWorkspaceKey,
  syncStateKey,
  type StorageArea,
} from "../extension/workspace-cache";

function memoryArea(initial: Record<string, unknown> = {}) {
  const state = { ...initial };
  const area: StorageArea = {
    get: vi.fn(async (key: string) => ({ [key]: state[key] })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(state, value);
    }),
  };
  return { area, state };
}

function userSnapshot(): WorkspaceSnapshot {
  return {
    spaces: [
      {
        id: "10000000-0000-4000-8000-000000000001",
        user_id: "local-user",
        name: "Research",
        color: "#7357e6",
        position: 0,
        created_at: "2026-08-29T00:00:00.000Z",
        updated_at: "2026-08-29T00:00:00.000Z",
        origin: "saved",
        read_only: false,
      },
    ],
    collections: [],
    links: [],
  };
}

describe("BrowserWorkspaceCache", () => {
  it("uses separate local, per-user cloud, and per-user sync-state keys", async () => {
    const { area, state } = memoryArea();
    const cache = new BrowserWorkspaceCache(area);
    const snapshot = userSnapshot();

    await cache.saveLocal(snapshot);
    await cache.saveCloud("user-a", { snapshot, revision: 2 });
    await cache.saveCloud("user-b", { snapshot: createDemoSnapshot("user-b"), revision: 5 });
    await cache.saveSyncState("user-a", { status: "synced", revision: 2 });

    expect(state[LOCAL_WORKSPACE_KEY]).toMatchObject({ snapshot });
    expect(state[cloudWorkspaceKey("user-a")]).toEqual({ snapshot, revision: 2 });
    expect(state[cloudWorkspaceKey("user-b")]).toMatchObject({ revision: 5 });
    expect(state[syncStateKey("user-a")]).toEqual({ status: "synced", revision: 2 });
  });

  it("migrates user-created content from the legacy key once", async () => {
    const snapshot = userSnapshot();
    const { area, state } = memoryArea({ [LEGACY_WORKSPACE_KEY]: snapshot });
    const cache = new BrowserWorkspaceCache(area);

    await cache.migrateLegacyOnce();
    await cache.migrateLegacyOnce();

    expect(await cache.loadLocal()).toEqual(snapshot);
    expect(state[LOCAL_WORKSPACE_KEY]).toMatchObject({ version: 2, snapshot });
    expect(area.set).toHaveBeenCalledTimes(1);
  });

  it("does not promote the historical sample workspace", async () => {
    const { area } = memoryArea({
      [LEGACY_WORKSPACE_KEY]: createDemoSnapshot(),
    });
    const cache = new BrowserWorkspaceCache(area);

    await cache.migrateLegacyOnce();

    expect(await cache.loadLocal()).toBeNull();
  });
});
