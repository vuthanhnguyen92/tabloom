import { createWebExtensionAdapter } from "./webextension";
import type { WebExtensionNamespace } from "./types";

export function createFirefoxAdapter(api: WebExtensionNamespace) {
  return createWebExtensionAdapter("firefox", api);
}
