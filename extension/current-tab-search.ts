import type { BrowserTab } from "../shared/capture";

export type CurrentTabSearchResult = {
  kind: "current-tab";
  tab: BrowserTab & { id: number; url: string };
};

function supportedUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function currentTabCandidates(tabs: readonly BrowserTab[]): CurrentTabSearchResult[] {
  return tabs.flatMap((tab) =>
    typeof tab.id === "number" && !tab.active && supportedUrl(tab.url)
      ? [{ kind: "current-tab" as const, tab: { ...tab, id: tab.id, url: tab.url } }]
      : [],
  );
}

export function searchCurrentTabs(tabs: readonly BrowserTab[], query: string): CurrentTabSearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return currentTabCandidates(tabs).filter(({ tab }) =>
    `${tab.title ?? ""} ${tab.url}`.toLocaleLowerCase().includes(normalized),
  );
}
