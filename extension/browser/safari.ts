import { createWebExtensionAdapter } from "./webextension";
import type { WebExtensionNamespace } from "./types";

export function createSafariAdapter(api: WebExtensionNamespace) {
  const adapter = createWebExtensionAdapter("safari", api);
  let redirectUrl = "";

  return {
    ...adapter,
    capabilities: { ...adapter.capabilities, identity: Boolean(api.runtime?.getURL) },
    identity: {
      getRedirectURL(path = "") {
        if (!api.runtime) throw new Error("Safari does not provide the runtime URL API required for sign-in.");
        redirectUrl = api.runtime.getURL(path);
        return redirectUrl;
      },
      launchWebAuthFlow(details: { url: string; interactive: boolean }) {
        const updatedEvent = api.tabs.onUpdated;
        const removedEvent = api.tabs.onRemoved;
        if (!updatedEvent || !removedEvent || !api.runtime) {
          return Promise.reject(new Error("Safari does not provide the tab events required for sign-in."));
        }

        const callbackUrl = redirectUrl || api.runtime.getURL("auth-callback.html");
        return new Promise<string | undefined>((resolve, reject) => {
          let authTabId: number | undefined;
          let settled = false;
          const cleanup = () => {
            updatedEvent.removeListener(onUpdated);
            removedEvent.removeListener(onRemoved);
            clearTimeout(timeout);
          };
          const finish = (value?: string, error?: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(value);
          };
          const onUpdated = (tabId: number, changeInfo: { url?: string }) => {
            if ((authTabId === undefined || tabId === authTabId) && changeInfo.url?.startsWith(callbackUrl)) {
              authTabId = tabId;
              void api.tabs.remove(tabId).catch(() => undefined);
              finish(changeInfo.url);
            }
          };
          const onRemoved = (tabId: number) => {
            if (tabId === authTabId) finish(undefined);
          };
          const timeout = setTimeout(() => finish(undefined, new Error("Safari sign-in timed out.")), 300_000);

          updatedEvent.addListener(onUpdated);
          removedEvent.addListener(onRemoved);
          void api.tabs.create({ url: details.url, active: details.interactive }).then((tab) => {
            if (typeof tab.id !== "number") finish(undefined, new Error("Safari could not open the sign-in tab."));
            else authTabId = tab.id;
          }).catch((error) => finish(undefined, error));
        });
      },
    },
  };
}
