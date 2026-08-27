import { describe, expect, it, vi } from "vitest";
import type { BookmarkRepository } from "../shared/bookmark-repository";
import { toBookmarkWorkspace } from "../shared/bookmarks";
import type { WorkspaceRepository } from "../shared/repository";
import { getOrCreateBookmarkDevice, syncBrowserBookmarks } from "../extension/bookmark-sync";

function repository(): BookmarkRepository {
  return {
    beginSync: vi.fn(async () => ({ runId: "run-1", sourceId: "source-1", generation: 1 })),
    appendBatch: vi.fn(async () => undefined),
    finalizeSync: vi.fn(async () => ({ sourceId: "source-1", generation: 1, bookmarkCount: 450, collectionCount: 2, syncedAt: "2026-08-27T12:00:00.000Z" })),
    loadWorkspace: vi.fn(async () => toBookmarkWorkspace("user-1", [])),
    listSources: vi.fn(async () => [{ id: "source-1", device_name: "Work Mac", last_synced_at: "2026-08-27T12:00:00.000Z" }]),
    renameSource: vi.fn(async () => undefined),
    forgetSource: vi.fn(async () => undefined),
  };
}

function entries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    chrome_bookmark_id: String(index),
    url: `https://example.com/${index}`,
    normalized_url: `https://example.com/${index}`,
    title: `Bookmark ${index}`,
    folder_path: index % 2 ? "Work" : "Research",
    syncing: index % 3 ? true : false,
    position: index,
  }));
}

describe("getOrCreateBookmarkDevice", () => {
  it("creates and persists a random installation identity once", async () => {
    const state: Record<string, unknown> = {};
    const area = {
      get: vi.fn(async (key: string) => ({ [key]: state[key] })),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(state, value); }),
    };
    const first = await getOrCreateBookmarkDevice(area, "MacIntel", () => "device-random-0001");
    const second = await getOrCreateBookmarkDevice(area, "MacIntel", () => "different");
    expect(first).toEqual({ key: "device-random-0001", name: "Chrome on macOS" });
    expect(second).toEqual(first);
    expect(area.set).toHaveBeenCalledOnce();
  });
});

describe("syncBrowserBookmarks", () => {
  it("uploads bounded batches and writes cache only after finalization", async () => {
    const bookmarks = repository();
    const workspace = { load: vi.fn(async () => toBookmarkWorkspace("user-1", [])) } as unknown as WorkspaceRepository;
    const cache = { writeEnvelope: vi.fn(async () => undefined) };
    const result = await syncBrowserBookmarks({
      repository: bookmarks,
      workspace,
      cache,
      device: { key: "device-random-0001", name: "Work Mac" },
      read: vi.fn(async () => ({ entries: entries(450), skipped: 3, collectionCount: 2, deviceOnlyCount: 150 })),
      batchSize: 200,
    });
    expect(vi.mocked(bookmarks.appendBatch).mock.calls.map((call) => call[1].length)).toEqual([200, 200, 50]);
    expect(vi.mocked(bookmarks.finalizeSync)).toHaveBeenCalledOnce();
    expect(cache.writeEnvelope).toHaveBeenCalledOnce();
    expect(cache.writeEnvelope.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(bookmarks.finalizeSync).mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ bookmarkCount: 450, skipped: 3, deviceOnlyCount: 150 });
  });

  it("does not write cache when finalization fails", async () => {
    const bookmarks = repository();
    vi.mocked(bookmarks.finalizeSync).mockRejectedValue(new Error("generation conflict"));
    const cache = { writeEnvelope: vi.fn(async () => undefined) };
    await expect(syncBrowserBookmarks({
      repository: bookmarks,
      workspace: { load: vi.fn() } as unknown as WorkspaceRepository,
      cache,
      device: { key: "device-random-0001", name: "Work Mac" },
      read: vi.fn(async () => ({ entries: entries(1), skipped: 0, collectionCount: 1, deviceOnlyCount: 0 })),
      batchSize: 200,
    })).rejects.toThrow("generation conflict");
    expect(cache.writeEnvelope).not.toHaveBeenCalled();
  });

  it("activates an empty snapshot without appending a batch", async () => {
    const bookmarks = repository();
    vi.mocked(bookmarks.finalizeSync).mockResolvedValue({ sourceId: "source-1", generation: 1, bookmarkCount: 0, collectionCount: 0, syncedAt: "2026-08-27T12:00:00.000Z" });
    await syncBrowserBookmarks({
      repository: bookmarks,
      workspace: { load: vi.fn(async () => toBookmarkWorkspace("user-1", [])) } as unknown as WorkspaceRepository,
      cache: { writeEnvelope: vi.fn(async () => undefined) },
      device: { key: "device-random-0001", name: "Work Mac" },
      read: vi.fn(async () => ({ entries: [], skipped: 0, collectionCount: 0, deviceOnlyCount: 0 })),
      batchSize: 200,
    });
    expect(bookmarks.appendBatch).not.toHaveBeenCalled();
    expect(bookmarks.finalizeSync).toHaveBeenCalledOnce();
  });

  it("does not begin a run when Chrome bookmark reading fails", async () => {
    const bookmarks = repository();
    await expect(syncBrowserBookmarks({
      repository: bookmarks,
      workspace: { load: vi.fn() } as unknown as WorkspaceRepository,
      cache: { writeEnvelope: vi.fn() },
      device: { key: "device-random-0001", name: "Work Mac" },
      read: vi.fn(async () => { throw new Error("Chrome read failed"); }),
      batchSize: 200,
    })).rejects.toThrow("Chrome read failed");
    expect(bookmarks.beginSync).not.toHaveBeenCalled();
  });
});
