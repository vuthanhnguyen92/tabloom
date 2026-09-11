export type BrowserTabSummary = {
  id?: number;
  title?: string;
  url?: string;
  favIconUrl?: string;
};

export type CurrentTabsCapability = {
  list(): Promise<BrowserTabSummary[]>;
  activate(tabId: number): Promise<void>;
};

export type OrganizerCapabilities = {
  openLink(input: { url: string; newTab: boolean }): Promise<void>;
  openCollection(name: string, urls: string[]): Promise<void>;
  resolveFavicon(url: string, source?: string | null): Promise<string | null>;
  currentTabs?: CurrentTabsCapability;
};

type WebOrganizerCapabilityOptions = {
  openUrl(input: { url: string; newTab: boolean }): void | Promise<void>;
  resolveFavicon?(url: string, source?: string | null): string | null | Promise<string | null>;
};

export function webOrganizerCapabilities({
  openUrl,
  resolveFavicon = (_url, source) => source ?? null,
}: WebOrganizerCapabilityOptions): OrganizerCapabilities {
  return {
    async openLink(input) {
      await openUrl(input);
    },
    async openCollection(_name, urls) {
      for (const url of urls) await openUrl({ url, newTab: true });
    },
    async resolveFavicon(url, source) {
      return resolveFavicon(url, source);
    },
  };
}
