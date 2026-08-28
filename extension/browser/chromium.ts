import { createWebExtensionAdapter } from "./webextension";
import type { WebExtensionNamespace } from "./types";

export function createChromiumAdapter(api: WebExtensionNamespace) {
  return createWebExtensionAdapter("chromium", api);
}
