import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";
import type { WorkspaceMergeResult, WorkspaceSyncRepository } from "../shared/workspace-sync-repository";
import { WorkspaceRevisionConflictError } from "../shared/workspace-sync-repository";
import type { WorkspaceCache } from "../extension/workspace-cache";
import {
  FirstSyncCoordinator,
  FirstSyncPreviewChangedError,
} from "../extension/first-sync";

const timestamp = "2026-08-29T00:00:00.000Z";

function workspace(
  names: { space: string; collection: string } = {
    space: "Research",
    collection: "Reading",
  },
  withLink = true,
): WorkspaceSnapshot {
  return {
    spaces: [
      {
        id: "10000000-0000-4000-8000-000000000001",
        user_id: "local-user",
        name: names.space,
        color: "#7357e6",
        position: 0,
        created_at: timestamp,
        updated_at: timestamp,
        origin: "saved",
        read_only: false,
      },
    ],
    collections: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        user_id: "local-user",
        space_id: "10000000-0000-4000-8000-000000000001",
        name: names.collection,
        position: 0,
        created_at: timestamp,
        updated_at: timestamp,
        origin: "saved",
        read_only: false,
      },
    ],
    links: withLink
      ? [
          {
            id: "30000000-0000-4000-8000-000000000001",
            user_id: "local-user",
            collection_id: "20000000-0000-4000-8000-000000000001",
            url: "https://example.com/",
            title: "Example",
            description: "",
            favicon_url: null,
            position: 0,
            created_at: timestamp,
            updated_at: timestamp,
            origin: "saved",
            read_only: false,
            device_label: null,
          },
        ]
      : [],
  };
}

function bootstrapWorkspace() {
  return workspace({ space: "My Space", collection: "My Collection" }, false);
}

function emptyWorkspace(): WorkspaceSnapshot {
  return { spaces: [], collections: [], links: [] };
}

function setup(input: {
  local?: WorkspaceSnapshot;
  cloud?: WorkspaceSnapshot;
  revision?: number;
  merge?: WorkspaceSyncRepository["mergeLocal"];
  failCloudCache?: boolean;
}) {
  const calls: string[] = [];
  const local = input.local ?? workspace();
  const cloud = input.cloud ?? workspace({ space: "Cloud", collection: "Saved" });
  const revision = input.revision ?? 3;
  const localRepository = new MemoryWorkspaceRepository("local-user", local);
  const result: WorkspaceMergeResult = {
    snapshot: cloud,
    revision: revision + 1,
    identityMap: { spaces: {}, collections: {}, links: {} },
    summary: {
      addedSpaces: 0,
      addedCollections: 0,
      addedLinks: 0,
      matchedSpaces: 0,
      matchedCollections: 0,
      matchedLinksById: 0,
      matchedLinksByUrl: 0,
      remappedIds: 0,
      skippedUnsupportedLinks: 0,
    },
  };
  const syncRepository: WorkspaceSyncRepository = {
    loadVersioned: vi.fn(async () => {
      calls.push("load-cloud");
      return { snapshot: cloud, revision };
    }),
    mergeLocal:
      input.merge ??
      vi.fn(async () => {
        calls.push("merge");
        return result;
      }),
  };
  const cache: WorkspaceCache = {
    loadLocal: vi.fn(async () => local),
    saveLocal: vi.fn(async () => undefined),
    loadCloud: vi.fn(async () => null),
    saveCloud: vi.fn(async () => {
      calls.push("cache-cloud");
      if (input.failCloudCache) throw new Error("cache unavailable");
    }),
    loadSyncState: vi.fn(async () => null),
    saveSyncState: vi.fn(async (_userId, state) => {
      calls.push(`state-${state.status}`);
    }),
    migrateLegacyOnce: vi.fn(async () => undefined),
  };
  const activateCanonical = vi.fn(async () => {
    calls.push("activate-cloud");
  });
  const coordinator = new FirstSyncCoordinator({
    userId: "cloud-user",
    localRepository,
    syncRepository,
    cache,
    activateCanonical,
  });
  return { coordinator, calls, cache, activateCanonical, syncRepository, result };
}

describe("FirstSyncCoordinator", () => {
  it("adopts populated cloud without confirmation for a default-only local workspace", async () => {
    const { coordinator, activateCanonical, syncRepository } = setup({ local: bootstrapWorkspace() });

    await expect(coordinator.inspect()).resolves.toMatchObject({
      kind: "adopt-cloud",
    });
    expect(syncRepository.loadVersioned).toHaveBeenCalledOnce();
    expect(activateCanonical).toHaveBeenCalledWith(
      workspace({ space: "Cloud", collection: "Saved" }),
      3,
    );
  });

  it("automatically imports meaningful local data when cloud is completely empty", async () => {
    const { coordinator } = setup({ cloud: emptyWorkspace(), revision: 0 });

    await expect(coordinator.inspect()).resolves.toMatchObject({
      kind: "auto-import",
      preview: { expectedRevision: 0 },
    });
  });

  it("requires confirmation when both local and cloud contain meaningful data", async () => {
    const { coordinator } = setup({});

    await expect(coordinator.inspect()).resolves.toMatchObject({
      kind: "confirm",
      preview: { expectedRevision: 3 },
    });
  });

  it("caches canonical cloud state before switching repository authority", async () => {
    const { coordinator, calls, activateCanonical, result } = setup({ cloud: emptyWorkspace(), revision: 0 });
    const decision = await coordinator.inspect();
    if (decision.kind === "adopt-cloud") throw new Error("unexpected decision");

    await coordinator.confirm(decision.preview);

    expect(calls).toEqual([
      "load-cloud",
      "merge",
      "cache-cloud",
      "state-synced",
      "activate-cloud",
    ]);
    expect(activateCanonical).toHaveBeenCalledWith(result.snapshot, result.revision);
  });

  it("keeps local authority and marks sync pending when canonical caching fails", async () => {
    const { coordinator, activateCanonical, cache } = setup({
      cloud: emptyWorkspace(),
      revision: 0,
      failCloudCache: true,
    });
    const decision = await coordinator.inspect();
    if (decision.kind === "adopt-cloud") throw new Error("unexpected decision");

    await expect(coordinator.confirm(decision.preview)).rejects.toThrow(
      "cache unavailable",
    );
    expect(activateCanonical).not.toHaveBeenCalled();
    expect(cache.saveSyncState).toHaveBeenLastCalledWith(
      "cloud-user",
      expect.objectContaining({ status: "error" }),
    );
  });

  it("cancels into a retryable pending state without switching authority", async () => {
    const { coordinator, activateCanonical, cache } = setup({});
    await coordinator.inspect();

    await coordinator.cancel();

    expect(activateCanonical).not.toHaveBeenCalled();
    expect(cache.saveSyncState).toHaveBeenCalledWith("cloud-user", {
      status: "pending",
      revision: 3,
    });
  });

  it("reloads and returns a new preview after a revision conflict", async () => {
    let loadCount = 0;
    const cloud = workspace({ space: "Cloud", collection: "Saved" });
    const { coordinator, syncRepository } = setup({
      cloud,
      revision: 3,
      merge: vi.fn(async () => {
        throw new WorkspaceRevisionConflictError();
      }),
    });
    vi.mocked(syncRepository.loadVersioned).mockImplementation(async () => ({
      snapshot: cloud,
      revision: loadCount++ === 0 ? 3 : 4,
    }));
    const decision = await coordinator.inspect();
    if (decision.kind === "adopt-cloud") throw new Error("unexpected decision");

    const error = await coordinator
      .confirm(decision.preview)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(FirstSyncPreviewChangedError);
    expect((error as FirstSyncPreviewChangedError).preview.expectedRevision).toBe(4);
  });
});
