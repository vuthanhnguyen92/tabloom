import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../shared/domain";
import { ChromeSnapshotCache } from "../extension/storage";
import { listCurrentWindowTabs } from "../extension/chrome-api";

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
