import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { type BookmarkRepository, CombinedWorkspaceRepository, SupabaseBookmarkRepository, copyBookmarkToCollection } from "../shared/bookmark-repository";
import { toBookmarkWorkspace, type BookmarkSource } from "../shared/bookmarks";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

function bookmarkRepository(snapshot = toBookmarkWorkspace("user-1", [])): BookmarkRepository {
  return {
    beginSync: vi.fn(),
    appendBatch: vi.fn(),
    finalizeSync: vi.fn(),
    loadWorkspace: vi.fn(async () => snapshot),
    listSources: vi.fn(async () => []),
    renameSource: vi.fn(),
    forgetSource: vi.fn(),
  };
}

describe("CombinedWorkspaceRepository", () => {
  it("appends the virtual bookmark workspace to normal records", async () => {
    const normal = new MemoryWorkspaceRepository("user-1", createDemoSnapshot("user-1"));
    const bookmarks = toBookmarkWorkspace("user-1", []);
    const repository = new CombinedWorkspaceRepository(normal, bookmarkRepository(bookmarks));
    const snapshot = await repository.load();
    expect(snapshot.spaces.at(-1)?.id).toBe("system:browser-bookmarks");
    expect(snapshot.spaces.filter((item) => item.origin === "saved")).toHaveLength(3);
  });

  it("delegates normal mutations", async () => {
    const normal = new MemoryWorkspaceRepository("user-1", createDemoSnapshot("user-1"));
    const repository = new CombinedWorkspaceRepository(normal, bookmarkRepository());
    await repository.createCollection({ space_id: "space-launch", name: "Copied" });
    expect((await normal.load()).collections.some((item) => item.name === "Copied")).toBe(true);
  });
});

describe("copyBookmarkToCollection", () => {
  it("copies bookmark metadata through the normal repository", async () => {
    const normal = new MemoryWorkspaceRepository("user-1", createDemoSnapshot("user-1"));
    const bookmark = {
      ...toBookmarkWorkspace("user-1", [{
        identity: "device\u0000mac\u00001", url: "https://example.com", normalized_url: "https://example.com/",
        title: "Example", folder_path: "Work", syncing: false, position: 0,
        source_ids: ["mac"], device_label: "Only on Mac", latest_synced_at: null,
      }]).links[0],
      favicon_url: "https://example.com/favicon.ico",
    };
    const copied = await copyBookmarkToCollection(normal, bookmark, "collection-plan");
    expect(copied).toMatchObject({ collection_id: "collection-plan", title: "Example", url: "https://example.com", origin: "saved" });
  });

  it("rejects normal saved links", async () => {
    const normal = new MemoryWorkspaceRepository("user-1", createDemoSnapshot("user-1"));
    await expect(copyBookmarkToCollection(normal, createDemoSnapshot("user-1").links[0], "collection-plan"))
      .rejects.toThrow("browser bookmarks");
  });
});

describe("SupabaseBookmarkRepository", () => {
  it("maps staged sync RPC payloads and summaries", async () => {
    const rpc = vi.fn(async (name: string) => name === "begin_bookmark_sync"
      ? { data: [{ run_id: "run-1", source_id: "source-1", generation: 4 }], error: null }
      : name === "finalize_bookmark_sync"
        ? { data: [{ source_id: "source-1", generation: 4, bookmark_count: 2, collection_count: 1, synced_at: "2026-08-27T12:00:00.000Z" }], error: null }
        : { data: 2, error: null });
    const repository = new SupabaseBookmarkRepository({ rpc } as unknown as SupabaseClient, "user-1");
    await expect(repository.beginSync("device-key-000001", "Work Mac", 2)).resolves.toEqual({ runId: "run-1", sourceId: "source-1", generation: 4 });
    await repository.appendBatch("run-1", []);
    await expect(repository.finalizeSync("run-1")).resolves.toEqual({ sourceId: "source-1", generation: 4, bookmarkCount: 2, collectionCount: 1, syncedAt: "2026-08-27T12:00:00.000Z" });
    expect(rpc).toHaveBeenCalledWith("begin_bookmark_sync", { p_device_key: "device-key-000001", p_device_name: "Work Mac", p_expected_entry_count: 2 });
  });

  it("loads entries only from source active runs", async () => {
    const sources: Array<BookmarkSource & { active_run_id: string | null }> = [
      { id: "source-1", device_name: "Work Mac", last_synced_at: "2026-08-27T12:00:00.000Z", active_run_id: "run-active" },
    ];
    const inRuns = vi.fn(async () => ({ data: [{
      id: "entry-1", source_id: "source-1", chrome_bookmark_id: "one", url: "https://example.com",
      normalized_url: "https://example.com/", title: "Example", folder_path: "Work", syncing: true, position: 0,
    }], error: null }));
    const from = vi.fn((table: string) => table === "bookmark_sources"
      ? { select: vi.fn(async () => ({ data: sources, error: null })) }
      : { select: vi.fn(() => ({ in: inRuns })) });
    const repository = new SupabaseBookmarkRepository({ from } as unknown as SupabaseClient, "user-1");
    const snapshot = await repository.loadWorkspace();
    expect(inRuns).toHaveBeenCalledWith("run_id", ["run-active"]);
    expect(snapshot.links[0]).toMatchObject({ title: "Example", origin: "browser-bookmark" });
  });
});
