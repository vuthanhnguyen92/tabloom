import { isSaveableUrl } from "../shared/domain";
import type { BrowserTab } from "../shared/capture";

export type CaptureTab = BrowserTab & { saveable: boolean; selected: boolean };
type TabsApi = { query(queryInfo: chrome.tabs.QueryInfo): Promise<BrowserTab[]> };

export async function listCurrentWindowTabs(api: TabsApi = chrome.tabs): Promise<CaptureTab[]> {
  const tabs = await api.query({ currentWindow: true });
  return tabs.map((tab) => {
    const saveable = isSaveableUrl(tab.url);
    return { id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl, saveable, selected: saveable };
  });
}
