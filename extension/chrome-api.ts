import { isSaveableUrl, normalizeUrlForDuplicate } from "../shared/domain";
import type { BrowserTab } from "../shared/capture";
import { browserAdapter } from "./browser";
import type { BrowserAdapter } from "./browser/types";

export type CaptureTab = BrowserTab & { saveable: boolean; selected: boolean };
type TabsApi = { query(queryInfo: { currentWindow: boolean }): Promise<BrowserTab[]> };

export type OpenCollectionResult = { opened: number; grouped: boolean };

export async function listCurrentWindowTabs(api?: TabsApi): Promise<CaptureTab[]> {
  const tabs = api ? await api.query({ currentWindow: true }) : await browserAdapter.tabs.listCurrentWindow();
  return tabs.map((tab) => {
    const saveable = isSaveableUrl(tab.url);
    return { id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl, active: tab.active, index: tab.index, saveable, selected: saveable };
  });
}

export function findDuplicateTabIds(tabs: Array<Pick<BrowserTab, "id" | "url" | "active" | "index">>): number[] {
  const groups = new Map<string, Array<Pick<BrowserTab, "id" | "url" | "active" | "index">>>();
  for (const tab of tabs) {
    const normalized = normalizeUrlForDuplicate(tab.url);
    if (!normalized) continue;
    groups.set(normalized, [...(groups.get(normalized) ?? []), tab]);
  }

  const duplicateIds: number[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
    const kept = ordered.find((tab) => tab.active) ?? ordered[0];
    duplicateIds.push(...ordered.flatMap((tab) => tab !== kept && typeof tab.id === "number" ? [tab.id] : []));
  }
  return duplicateIds;
}

export async function openCollectionTabs(
  collectionName: string,
  urls: string[],
  adapter: Pick<BrowserAdapter, "tabs"> = browserAdapter,
): Promise<OpenCollectionResult> {
  return adapter.tabs.openCollection(collectionName, urls);
}
