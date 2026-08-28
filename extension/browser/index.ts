import { createChromiumAdapter } from "./chromium";
import { createFirefoxAdapter } from "./firefox";
import { createSafariAdapter } from "./safari";
import type { BrowserAdapter, BrowserTarget, WebExtensionNamespace } from "./types";

declare const __TABLOOM_BROWSER_TARGET__: BrowserTarget;

const target = typeof __TABLOOM_BROWSER_TARGET__ === "undefined" ? "chromium" : __TABLOOM_BROWSER_TARGET__;
export const browserTarget = target;

let adapter: BrowserAdapter | undefined;

function getAdapter(): BrowserAdapter {
  if (adapter) return adapter;
  const namespace = ((globalThis as typeof globalThis & { browser?: unknown; chrome?: unknown }).browser
    ?? (globalThis as typeof globalThis & { chrome?: unknown }).chrome) as WebExtensionNamespace | undefined;
  if (!namespace) throw new Error("The browser extension API is not available in this context.");
  adapter = target === "firefox"
    ? createFirefoxAdapter(namespace)
    : target === "safari"
      ? createSafariAdapter(namespace)
      : createChromiumAdapter(namespace);
  return adapter;
}

export const browserAdapter = new Proxy({} as BrowserAdapter, {
  get: (_target, property) => Reflect.get(getAdapter(), property),
});

export type { BrowserAdapter, BrowserTarget } from "./types";
