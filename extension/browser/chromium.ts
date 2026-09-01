import { createWebExtensionAdapter } from "./webextension";
import type { WebExtensionNamespace } from "./types";

export function createChromiumAdapter(api: WebExtensionNamespace) {
  const adapter = createWebExtensionAdapter("chromium", api);
  return {
    ...adapter,
    favicons: {
      resolve: ({ pageUrl, capturedUrl, size = 32 }: Parameters<typeof adapter.favicons.resolve>[0]) => {
        if (!pageUrl || !api.runtime?.getURL) return capturedUrl ?? null;
        try {
          const faviconUrl = new URL(api.runtime.getURL("_favicon/"));
          faviconUrl.searchParams.set("pageUrl", pageUrl);
          faviconUrl.searchParams.set("size", String(size));
          return faviconUrl.toString();
        } catch {
          return capturedUrl ?? null;
        }
      },
    },
  };
}
