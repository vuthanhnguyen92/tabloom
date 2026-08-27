import { describe, expect, it } from "vitest";
import {
  mergeBookmarkEntries,
  normalizeBookmarkUrl,
  toBookmarkWorkspace,
  type BookmarkEntryRecord,
  type BookmarkSource,
} from "../shared/bookmarks";
import { filterWorkspace } from "../shared/domain";

const sources: BookmarkSource[] = [
  { id: "mac", device_name: "Work Mac", last_synced_at: "2026-08-27T10:00:00.000Z" },
  { id: "pc", device_name: "Home PC", last_synced_at: "2026-08-27T11:00:00.000Z" },
];

function entry(overrides: Partial<BookmarkEntryRecord> = {}): BookmarkEntryRecord {
  return {
    id: "entry-1",
    source_id: "mac",
    chrome_bookmark_id: "bookmark-1",
    url: "https://example.com/docs",
    normalized_url: "https://example.com/docs",
    title: "Example docs",
    folder_path: "Work",
    syncing: true,
    position: 0,
    ...overrides,
  };
}

describe("normalizeBookmarkUrl", () => {
  it("normalizes scheme, host, default port, and fragment conservatively", () => {
    expect(normalizeBookmarkUrl("HTTPS://EXAMPLE.com:443/docs/?view=all#top"))
      .toBe("https://example.com/docs/?view=all");
  });

  it("preserves query strings and meaningful trailing slashes", () => {
    expect(normalizeBookmarkUrl("https://example.com/docs"))
      .not.toBe(normalizeBookmarkUrl("https://example.com/docs/"));
    expect(normalizeBookmarkUrl("https://example.com/docs?view=one"))
      .not.toBe(normalizeBookmarkUrl("https://example.com/docs?view=two"));
  });
});

describe("mergeBookmarkEntries", () => {
  it("merges account-synced copies and uses the most recently synced source", () => {
    const merged = mergeBookmarkEntries(sources, [
      entry({ source_id: "mac", chrome_bookmark_id: "mac-1", title: "Old title", position: 4 }),
      entry({ id: "entry-2", source_id: "pc", chrome_bookmark_id: "pc-8", title: "Current title", position: 1 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ title: "Current title", position: 1, source_ids: ["mac", "pc"], device_label: null });
  });

  it("keeps identical URLs in different folders separate", () => {
    const merged = mergeBookmarkEntries(sources, [
      entry({ folder_path: "Work" }),
      entry({ id: "entry-2", source_id: "pc", chrome_bookmark_id: "pc-1", folder_path: "Personal" }),
    ]);
    expect(merged.map((item) => item.folder_path)).toEqual(["Personal", "Work"]);
  });

  it("keeps device-only and unknown entries source-specific with labels", () => {
    const merged = mergeBookmarkEntries(sources, [
      entry({ source_id: "mac", chrome_bookmark_id: "same", syncing: false }),
      entry({ id: "entry-2", source_id: "pc", chrome_bookmark_id: "same", syncing: null }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.device_label)).toEqual([
      "Only on Work Mac",
      "Sync status unknown · Home PC",
    ]);
  });
});

describe("toBookmarkWorkspace", () => {
  it("creates stable read-only virtual records and sorts Unfiled first", () => {
    const merged = mergeBookmarkEntries(sources, [
      entry({ folder_path: "Work / Design" }),
      entry({ id: "entry-2", chrome_bookmark_id: "root", folder_path: "Unfiled bookmarks", url: "https://root.example", normalized_url: "https://root.example" }),
      entry({ id: "entry-3", chrome_bookmark_id: "work", folder_path: "Work", url: "https://work.example", normalized_url: "https://work.example" }),
    ]);
    const first = toBookmarkWorkspace("user-1", merged);
    const second = toBookmarkWorkspace("user-1", merged);
    expect(first).toEqual(second);
    expect(first.spaces[0]).toMatchObject({ id: "system:browser-bookmarks", origin: "browser-bookmark", read_only: true });
    expect(first.collections.map((item) => item.name)).toEqual(["Unfiled bookmarks", "Work", "Work / Design"]);
    expect(first.links.every((item) => item.origin === "browser-bookmark" && item.read_only)).toBe(true);
  });

  it("includes device labels in workspace search", () => {
    const merged = mergeBookmarkEntries(sources, [entry({ syncing: false })]);
    const snapshot = toBookmarkWorkspace("user-1", merged);
    expect(filterWorkspace(snapshot, "Work Mac").links).toHaveLength(1);
  });
});
