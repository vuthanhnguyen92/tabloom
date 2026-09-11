import { describe, expect, it, vi } from "vitest";
import { MemoryWorkspaceRepository } from "../shared/repository";
import { importBrowserBookmarksIntoSpace } from "../extension/bookmark-space-import";

describe("browser bookmark space import", () => {
  it("imports browser folders as editable collections and labels device-only links", async () => {
    const repository = new MemoryWorkspaceRepository("user-1", {
      spaces: [{ id: "space-1", user_id: "user-1", name: "Imported", color: "#7157d9", position: 0, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", origin: "saved", read_only: false }],
      collections: [],
      links: [],
    });
    const requestPermission = vi.fn(async () => true);

    const result = await importBrowserBookmarksIntoSpace({
      repository,
      spaceId: "space-1",
      requestPermission,
      readBookmarks: vi.fn(async () => ({
        entries: [
          { chrome_bookmark_id: "1", url: "https://example.com/one", normalized_url: "https://example.com/one", title: "One", folder_path: "Research", syncing: true, position: 0 },
          { chrome_bookmark_id: "2", url: "https://example.com/two", normalized_url: "https://example.com/two", title: "Two", folder_path: "Unfiled bookmarks", syncing: false, position: 1 },
        ],
        skipped: 1,
        collectionCount: 2,
        deviceOnlyCount: 1,
      })),
    });

    expect(requestPermission).toHaveBeenCalledOnce();
    expect(result).toEqual({ imported: 2, collections: 2, skipped: 1, deviceOnly: 1 });
    const snapshot = await repository.load();
    expect(snapshot.collections.map((item) => item.name)).toEqual(["Research", "Imported bookmarks"]);
    expect(snapshot.collections.every((item) => item.origin === "saved" && !item.read_only)).toBe(true);
    expect(snapshot.links.map((item) => item.description)).toEqual(["", "Imported from this device"]);
    expect(snapshot.links.every((item) => item.origin === "saved" && !item.read_only)).toBe(true);
  });

  it("leaves the new space empty when bookmark permission is refused", async () => {
    const repository = new MemoryWorkspaceRepository("user-1", { spaces: [], collections: [], links: [] });
    await expect(importBrowserBookmarksIntoSpace({
      repository,
      spaceId: "space-1",
      requestPermission: vi.fn(async () => false),
      readBookmarks: vi.fn(),
    })).rejects.toThrow("Bookmark permission was not granted");
    expect((await repository.load()).collections).toEqual([]);
  });
});
