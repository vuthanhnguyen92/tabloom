import { describe, expect, it, vi } from "vitest";
import * as chromeApi from "../extension/chrome-api";

type OpenCollection = (
  collectionName: string,
  urls: string[],
  api: unknown,
) => Promise<{ opened: number; grouped: boolean }>;

function getOpenCollection() {
  return (chromeApi as typeof chromeApi & { openCollectionTabs?: OpenCollection }).openCollectionTabs;
}

function createApi(permissionGranted: boolean) {
  let nextTabId = 100;
  return {
    permissions: { request: vi.fn(async () => permissionGranted) },
    tabs: {
      create: vi.fn(async () => ({ id: nextTabId++ })),
      group: vi.fn(async () => 27),
      ungroup: vi.fn(async () => undefined),
    },
    tabGroups: { update: vi.fn(async () => ({ id: 27 })) },
  };
}

describe("openCollectionTabs", () => {
  it("opens links in a named expanded group when permission is granted", async () => {
    const openCollection = getOpenCollection();
    expect(openCollection).toBeTypeOf("function");
    const api = createApi(true);

    const result = await openCollection!("Design", ["https://figma.com/brand", "https://figma.com/prototype"], api);

    expect(result).toEqual({ opened: 2, grouped: true });
    expect(api.permissions.request).toHaveBeenCalledWith({ permissions: ["tabGroups"] });
    expect(api.tabs.group).toHaveBeenCalledWith({ tabIds: [100, 101] });
    expect(api.tabGroups.update).toHaveBeenCalledWith(27, { title: "Design", collapsed: false });
  });

  it("opens links without grouping when permission is refused", async () => {
    const openCollection = getOpenCollection();
    expect(openCollection).toBeTypeOf("function");
    const api = createApi(false);

    const result = await openCollection!("Plan", ["https://linear.app/roadmap"], api);

    expect(result).toEqual({ opened: 1, grouped: false });
    expect(api.tabs.group).not.toHaveBeenCalled();
    expect(api.tabGroups.update).not.toHaveBeenCalled();
  });

  it("leaves opened links ungrouped when Chrome cannot finish grouping", async () => {
    const openCollection = getOpenCollection();
    expect(openCollection).toBeTypeOf("function");
    const api = createApi(true);
    api.tabGroups.update.mockRejectedValueOnce(new Error("Group naming failed"));

    const result = await openCollection!("Learn", ["https://example.com/notes"], api);

    expect(result).toEqual({ opened: 1, grouped: false });
    expect(api.tabs.ungroup).toHaveBeenCalledWith([100]);
  });
});
