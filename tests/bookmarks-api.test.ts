import { describe, expect, it, vi } from "vitest";
import { readBrowserBookmarks, requestBookmarksPermission } from "../extension/bookmarks-api";

describe("requestBookmarksPermission", () => {
  it("requests bookmarks directly at runtime", async () => {
    const request = vi.fn(async () => true);
    await expect(requestBookmarksPermission({ request })).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ permissions: ["bookmarks"] });
  });

  it("returns false when the user denies permission", async () => {
    await expect(requestBookmarksPermission({ request: vi.fn(async () => false) })).resolves.toBe(false);
  });
});

describe("readBrowserBookmarks", () => {
  it("strips only bar/other roots and preserves nested, mobile, and sync state", async () => {
    const getTree = vi.fn(async () => [{
      id: "0",
      title: "",
      children: [
        {
          id: "bar", title: "Bookmarks bar", folderType: "bookmarks-bar", syncing: true, children: [
            { id: "direct", title: "Direct", url: "https://direct.example", index: 0 },
            { id: "work", title: "Work", children: [{ id: "design", title: "Design", children: [
              { id: "figma", title: "Figma", url: "https://figma.com/file#section", index: 0 },
              { id: "internal", title: "Settings", url: "chrome://settings", index: 1 },
            ] }] },
          ],
        },
        {
          id: "other", title: "Other bookmarks", folderType: "other", syncing: false,
          children: [{ id: "local", title: "Local", url: "http://localhost:3000", index: 0 }],
        },
        {
          id: "mobile", title: "Mobile bookmarks", folderType: "mobile",
          children: [{ id: "phone", title: "Phone", url: "https://phone.example", index: 0 }],
        },
      ],
    }]);
    const result = await readBrowserBookmarks({ getTree });
    expect(result.entries.map((item) => item.folder_path)).toEqual([
      "Unfiled bookmarks", "Work / Design", "Unfiled bookmarks", "Mobile bookmarks",
    ]);
    expect(result.entries.map((item) => item.syncing)).toEqual([true, true, false, null]);
    expect(result.entries[1].normalized_url).toBe("https://figma.com/file");
    expect(result).toMatchObject({ skipped: 1, collectionCount: 3, deviceOnlyCount: 2 });
  });

  it("omits empty folders and uses sibling position when index is absent", async () => {
    const result = await readBrowserBookmarks({ getTree: vi.fn(async () => [{
      id: "0", title: "", children: [{ id: "bar", title: "Bookmarks bar", children: [
        { id: "empty", title: "Empty", children: [] },
        { id: "docs", title: "Docs", children: [
          { id: "a", title: "A", url: "https://a.example" },
          { id: "b", title: "B", url: "https://b.example" },
        ] },
      ] },
      ] }]) });
    expect(result.entries.map((item) => item.position)).toEqual([0, 1]);
    expect(result.collectionCount).toBe(1);
  });
});
