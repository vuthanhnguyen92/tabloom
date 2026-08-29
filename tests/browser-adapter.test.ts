import { describe, expect, it, vi } from "vitest";
import { createWebExtensionAdapter } from "../extension/browser/webextension";
import { createSafariAdapter } from "../extension/browser/safari";

function createNamespace({ withGroups = true } = {}) {
  let nextTabId = 10;
  const namespace = {
    tabs: {
      query: vi.fn(async () => [{ id: 1, title: "Tab", url: "https://example.com", active: true, index: 0 }]),
      create: vi.fn(async () => ({ id: nextTabId++ })),
      remove: vi.fn(async () => undefined),
      group: withGroups ? vi.fn(async () => 7) : undefined,
      ungroup: withGroups ? vi.fn(async () => undefined) : undefined,
    },
    tabGroups: withGroups ? { update: vi.fn(async () => ({ id: 7 })) } : undefined,
    permissions: { request: vi.fn(async () => true) },
    bookmarks: { getTree: vi.fn(async () => [{ id: "0", title: "", children: [] }]) },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
    identity: {
      getRedirectURL: vi.fn((path?: string) => `https://extension.example/${path ?? ""}`),
      launchWebAuthFlow: vi.fn(async () => "https://extension.example/auth-callback?code=abc"),
    },
  };
  return namespace;
}

describe("BrowserAdapter", () => {
  it("normalizes shared tab, storage, bookmarks, permission, and identity operations", async () => {
    const namespace = createNamespace();
    const adapter = createWebExtensionAdapter("firefox", namespace);

    expect(adapter.target).toBe("firefox");
    expect(await adapter.tabs.listCurrentWindow()).toHaveLength(1);
    await adapter.tabs.close([1]);
    expect(namespace.tabs.remove).toHaveBeenCalledWith([1]);
    expect(await adapter.permissions.request("bookmarks")).toBe(true);
    expect(await adapter.bookmarks.getTree()).toHaveLength(1);
    expect(adapter.identity.getRedirectURL("auth-callback")).toContain("auth-callback");
    expect(await adapter.identity.launchWebAuthFlow({ url: "https://accounts.example", interactive: true })).toContain("code=abc");
  });

  it("opens an ungrouped collection when the target lacks tab-group APIs", async () => {
    const namespace = createNamespace({ withGroups: false });
    const adapter = createWebExtensionAdapter("safari", namespace);

    const result = await adapter.tabs.openCollection("Reading", ["https://example.com/one", "https://example.com/two"]);

    expect(result).toEqual({ opened: 2, grouped: false });
    expect(namespace.permissions.request).not.toHaveBeenCalled();
  });

  it("feature-detects and names tab groups when available", async () => {
    const namespace = createNamespace();
    const adapter = createWebExtensionAdapter("chromium", namespace);

    const result = await adapter.tabs.openCollection("Design", ["https://example.com"]);

    expect(result).toEqual({ opened: 1, grouped: true });
    expect(namespace.permissions.request).toHaveBeenCalledWith({ permissions: ["tabGroups"] });
    expect(namespace.permissions.request.mock.invocationCallOrder[0]).toBeLessThan(namespace.tabs.create.mock.invocationCallOrder[0]);
    expect(namespace.tabs.group).toHaveBeenCalledWith({ tabIds: [10] });
    expect(namespace.tabGroups?.update).toHaveBeenCalledWith(7, { title: "Design", collapsed: false });
  });

  it("reports unavailable optional APIs with target-specific errors", async () => {
    const namespace = { ...createNamespace(), bookmarks: undefined, identity: undefined };
    const adapter = createWebExtensionAdapter("safari", namespace);

    await expect(adapter.bookmarks.getTree()).rejects.toThrow("safari does not provide browser bookmark access");
    expect(() => adapter.identity.getRedirectURL("auth-callback")).toThrow("safari does not provide the identity API");
  });

  it("completes Safari OAuth through the native bridge", async () => {
    const base = createNamespace();
    const sendNativeMessage = vi.fn(async () => ({
      type: "tabloom.oauth.result" as const,
      callbackUrl: "tabloom://auth-callback?code=safari-code",
    }));
    const namespace = {
      ...base,
      identity: undefined,
      runtime: { getURL: (path = "") => `safari-web-extension://tabloom/${path}`, sendNativeMessage },
    };
    const adapter = createSafariAdapter(namespace);

    expect(adapter.identity.getRedirectURL()).toBe("tabloom://auth-callback");
    await expect(adapter.identity.launchWebAuthFlow({ url: "https://accounts.example", interactive: true }))
      .resolves.toBe("tabloom://auth-callback?code=safari-code");
    expect(sendNativeMessage).toHaveBeenCalledWith("app.tabloom.mac", {
      type: "tabloom.oauth.start",
      authorizationUrl: "https://accounts.example",
      callbackScheme: "tabloom",
    });
  });

  it("normalizes Safari native cancellation", async () => {
    const base = createNamespace();
    const namespace = {
      ...base,
      identity: undefined,
      runtime: {
        getURL: (path = "") => `safari-web-extension://tabloom/${path}`,
        sendNativeMessage: vi.fn(async () => ({ type: "tabloom.oauth.cancelled" as const })),
      },
    };
    const adapter = createSafariAdapter(namespace);

    await expect(adapter.identity.launchWebAuthFlow({ url: "https://accounts.example", interactive: true }))
      .resolves.toBeUndefined();
  });

  it("times out a Safari native flow that never responds", async () => {
    vi.useFakeTimers();
    try {
      const base = createNamespace();
      const namespace = {
        ...base,
        identity: undefined,
        runtime: {
          getURL: (path = "") => `safari-web-extension://tabloom/${path}`,
          sendNativeMessage: vi.fn(() => new Promise<never>(() => undefined)),
        },
      };
      const adapter = createSafariAdapter(namespace, { timeoutMs: 20 });
      const result = expect(adapter.identity.launchWebAuthFlow({ url: "https://accounts.example", interactive: true }))
        .rejects.toThrow("Safari sign-in timed out");

      await vi.advanceTimersByTimeAsync(21);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
});
