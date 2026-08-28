import type { BrowserAdapter, BrowserTarget, WebExtensionNamespace } from "./types";

export function createWebExtensionAdapter(target: BrowserTarget, api: WebExtensionNamespace): BrowserAdapter {
  return {
    target,
    capabilities: {
      bookmarks: Boolean(api.bookmarks),
      identity: Boolean(api.identity),
      tabGroups: Boolean(api.tabs.group && api.tabs.ungroup && api.tabGroups?.update),
    },
    storage: api.storage.local,
    identity: {
      getRedirectURL(path) {
        if (!api.identity) throw new Error(`${target} does not provide the identity API required for sign-in.`);
        return api.identity.getRedirectURL(path);
      },
      async launchWebAuthFlow(details) {
        if (!api.identity) throw new Error(`${target} does not provide the identity API required for sign-in.`);
        return api.identity.launchWebAuthFlow(details);
      },
    },
    bookmarks: {
      async getTree() {
        if (!api.bookmarks) throw new Error(`${target} does not provide browser bookmark access.`);
        return api.bookmarks.getTree();
      },
    },
    permissions: {
      request: (permission) => api.permissions.request({ permissions: [permission] }),
    },
    tabs: {
      listCurrentWindow: () => api.tabs.query({ currentWindow: true }),
      close: (tabIds) => api.tabs.remove(tabIds),
      async openCollection(name, urls) {
        if (!urls.length) return { opened: 0, grouped: false };

        let granted = false;
        const canGroup = Boolean(api.tabs.group && api.tabs.ungroup && api.tabGroups?.update);
        if (canGroup) {
          try {
            granted = await api.permissions.request({ permissions: ["tabGroups"] });
          } catch {
            granted = false;
          }
        }

        const openedTabs = await Promise.all(urls.map((url, index) => api.tabs.create({ url, active: index === 0 })));
        const tabIds = openedTabs.flatMap((tab) => typeof tab.id === "number" ? [tab.id] : []);
        if (!canGroup || !granted || tabIds.length !== openedTabs.length) return { opened: openedTabs.length, grouped: false };

        try {
          const groupId = await api.tabs.group!({ tabIds });
          await api.tabGroups!.update(groupId, { title: name, collapsed: false });
          return { opened: openedTabs.length, grouped: true };
        } catch {
          await api.tabs.ungroup!(tabIds).catch(() => undefined);
          return { opened: openedTabs.length, grouped: false };
        }
      },
    },
  };
}
