import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createDemoSnapshot } from "../shared/domain";
import { ChromeSnapshotCache } from "../extension/storage";
import { listCurrentWindowTabs } from "../extension/chrome-api";
import * as chromeApi from "../extension/chrome-api";

describe("extension permissions", () => {
  it("can request tab-group access at runtime without requiring it at installation", () => {
    const manifest = JSON.parse(readFileSync("extension/public/manifest.json", "utf8")) as { permissions?: string[]; optional_permissions?: string[] };
    expect(manifest.permissions).not.toContain("tabGroups");
    expect(manifest.optional_permissions).toContain("tabGroups");
  });

  it("requests bookmark access at runtime without requiring it at installation", () => {
    const manifest = JSON.parse(readFileSync("extension/public/manifest.json", "utf8")) as { permissions?: string[]; optional_permissions?: string[] };
    expect(manifest.permissions).not.toContain("bookmarks");
    expect(manifest.optional_permissions).toContain("bookmarks");
  });
});

describe("ChromeSnapshotCache", () => {
  it("round-trips the latest workspace snapshot", async () => {
    const state: Record<string, unknown> = {};
    const area = {
      get: vi.fn(async (key: string) => ({ [key]: state[key] })),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(state, value); }),
    };
    const cache = new ChromeSnapshotCache(area);
    const snapshot = createDemoSnapshot();
    await cache.write(snapshot);
    expect(await cache.read()).toEqual(snapshot);
  });
});

describe("listCurrentWindowTabs", () => {
  it("maps saveable tabs and marks unsupported tabs", async () => {
    const query = vi.fn(async () => [
      { id: 1, title: "Docs", url: "https://example.com", favIconUrl: "https://example.com/icon.png" },
      { id: 2, title: "Settings", url: "chrome://settings" },
    ]);
    const tabs = await listCurrentWindowTabs({ query });
    expect(tabs[0]).toMatchObject({ id: 1, saveable: true, selected: true });
    expect(tabs[1]).toMatchObject({ id: 2, saveable: false, selected: false });
  });
});

describe("duplicate current tabs", () => {
  const findDuplicateTabIds = (chromeApi as typeof chromeApi & {
    findDuplicateTabIds?: (tabs: Array<{ id?: number; url?: string; active?: boolean; index?: number }>) => number[];
  }).findDuplicateTabIds;

  it("keeps the active tab and closes the other copies", () => {
    expect(findDuplicateTabIds).toBeTypeOf("function");
    expect(findDuplicateTabIds!([
      { id: 1, url: "https://example.com/page", active: false, index: 0 },
      { id: 2, url: "https://EXAMPLE.com:443/page", active: true, index: 1 },
      { id: 3, url: "https://example.com/page", active: false, index: 2 },
    ])).toEqual([1, 3]);
  });

  it("keeps the leftmost tab when none of the copies is active", () => {
    expect(findDuplicateTabIds).toBeTypeOf("function");
    expect(findDuplicateTabIds!([
      { id: 7, url: "https://example.com/docs", active: false, index: 5 },
      { id: 6, url: "https://example.com/docs", active: false, index: 2 },
    ])).toEqual([7]);
  });

  it("does not merge distinct queries, fragments, or unsupported browser pages", () => {
    expect(findDuplicateTabIds).toBeTypeOf("function");
    expect(findDuplicateTabIds!([
      { id: 10, url: "https://example.com/page?view=one#top", index: 0 },
      { id: 11, url: "https://example.com/page?view=two#top", index: 1 },
      { id: 12, url: "https://example.com/page?view=one#details", index: 2 },
      { id: 13, url: "chrome://settings", index: 3 },
      { id: 14, url: "chrome://settings", index: 4 },
    ])).toEqual([]);
  });
});
