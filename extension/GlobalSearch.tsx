import { useMemo } from "react";
import { GlobalSearch as SharedGlobalSearch } from "../shared/organizer/GlobalSearch";
import type { OrganizerCapabilities } from "../shared/organizer/capabilities";
import type { BrowserTab } from "../shared/capture";
import type { SavedLink, WorkspaceSnapshot } from "../shared/domain";
import type { FaviconResolver } from "./browser/types";

export type GlobalSearchProps = {
  snapshot: WorkspaceSnapshot;
  listCurrentTabs: () => Promise<BrowserTab[]>;
  onActivateCurrentTab: (tabId: number) => Promise<void>;
  onError?: (message: string) => void;
  onOpen?: (link: SavedLink) => void;
  resolveFavicon?: FaviconResolver;
};

// Compatibility adapter until the extension composition migrates in Task 6.
export function GlobalSearch({ listCurrentTabs, onActivateCurrentTab, resolveFavicon, ...props }: GlobalSearchProps) {
  const capabilities = useMemo<OrganizerCapabilities>(() => ({
    currentTabs: {
      async list() { return (await listCurrentTabs()).filter((tab) => !tab.active); },
      activate: onActivateCurrentTab,
    },
    async openLink({ url }) { window.open(url, "_blank", "noopener,noreferrer"); },
    async openCollection(_name, urls) { urls.forEach((url) => window.open(url, "_blank", "noopener,noreferrer")); },
    async resolveFavicon(url, capturedUrl) { return resolveFavicon?.({ pageUrl: url, capturedUrl, size: 32 }) ?? capturedUrl ?? null; },
  }), [listCurrentTabs, onActivateCurrentTab, resolveFavicon]);
  return <SharedGlobalSearch {...props} capabilities={capabilities} resolveFavicon={resolveFavicon} savedLinkNewTab />;
}
