import { isSaveableUrl } from "../shared/domain";
import type { BrowserTab } from "../shared/capture";

export type CaptureTab = BrowserTab & { saveable: boolean; selected: boolean };
type TabsApi = { query(queryInfo: chrome.tabs.QueryInfo): Promise<BrowserTab[]> };

type OpenCollectionApi = {
  permissions: Pick<typeof chrome.permissions, "request">;
  tabs: Pick<typeof chrome.tabs, "create" | "group" | "ungroup">;
  tabGroups: Pick<typeof chrome.tabGroups, "update">;
};

export type OpenCollectionResult = { opened: number; grouped: boolean };

export async function listCurrentWindowTabs(api: TabsApi = chrome.tabs): Promise<CaptureTab[]> {
  const tabs = await api.query({ currentWindow: true });
  return tabs.map((tab) => {
    const saveable = isSaveableUrl(tab.url);
    return { id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl, saveable, selected: saveable };
  });
}

export async function openCollectionTabs(
  collectionName: string,
  urls: string[],
  api: OpenCollectionApi = chrome,
): Promise<OpenCollectionResult> {
  if (!urls.length) return { opened: 0, grouped: false };

  let permissionGranted = false;
  try {
    permissionGranted = await api.permissions.request({ permissions: ["tabGroups"] });
  } catch {
    permissionGranted = false;
  }

  const openedTabs = await Promise.all(urls.map((url, index) => api.tabs.create({ url, active: index === 0 })));
  const tabIds = openedTabs.flatMap((tab) => typeof tab.id === "number" ? [tab.id] : []);
  if (!permissionGranted || tabIds.length !== openedTabs.length) {
    return { opened: openedTabs.length, grouped: false };
  }
  const groupableTabIds = tabIds as [number, ...number[]];

  try {
    const groupId = await api.tabs.group({ tabIds: groupableTabIds });
    await api.tabGroups.update(groupId, { title: collectionName, collapsed: false });
    return { opened: openedTabs.length, grouped: true };
  } catch {
    await api.tabs.ungroup(groupableTabIds).catch(() => undefined);
    return { opened: openedTabs.length, grouped: false };
  }
}
