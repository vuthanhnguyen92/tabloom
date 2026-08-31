import { describe, expect, it, vi } from "vitest";
import { createWebExtensionAdapter } from "../extension/browser/webextension";
import { createSafariAdapter } from "../extension/browser/safari";

function createNamespace({ withGroups = true } = {}) {
  let nextTabId = 10;
  const storageListeners = new Set<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void>();
  const namespace = {
    tabs: {
      query: vi.fn(async () => [{ id: 1, title: "Tab", url: "https://example.com", active: true, index: 0 }]),
      create: vi.fn(async () => ({ id: nextTabId++ })),
      update: vi.fn(async (tabId: number) => ({ id: tabId, title: "Target", url: "https://target.example", active: true, index: 1 })),
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
      onChanged: {
        addListener: vi.fn((listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void) => storageListeners.add(listener)),
        removeListener: vi.fn((listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void) => storageListeners.delete(listener)),
        emit(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) {
          for (const listener of storageListeners) listener(changes, areaName);
        },
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

  it("emits local storage keys and stops after unsubscribe", () => {
    const namespace = createNamespace();
    const adapter = createWebExtensionAdapter("chromium", namespace);
    const listener = vi.fn();

    const unsubscribe = adapter.storageChanges.subscribe(listener);
    namespace.storage.onChanged.emit({ workspace: { newValue: { revision: 2 } } }, "local");
    namespace.storage.onChanged.emit({ ignored: { newValue: true } }, "sync");

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(["workspace"]);
    unsubscribe();
    namespace.storage.onChanged.emit({ queue: { newValue: [] } }, "local");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("opens an ungrouped collection when the target lacks tab-group APIs", async () => {
    const namespace = createNamespace({ withGroups: false });
    const adapter = createWebExtensionAdapter("safari", namespace);

    const result = await adapter.tabs.openCollection("Reading", ["https://example.com/one", "https://example.com/two"]);

    expect(result).toEqual({ opened: 2, grouped: false });
    expect(namespace.permissions.request).not.toHaveBeenCalled();
  });

  it("activates an existing tab before closing the calling Tabloom tab", async () => {
    const namespace = createNamespace();
    const adapter = createWebExtensionAdapter("chromium", namespace);

    await expect(adapter.tabs.activateExisting(9)).resolves.toEqual({ tabloomClosed: true });

    expect(namespace.tabs.query).toHaveBeenCalledWith({ currentWindow: true, active: true });
    expect(namespace.tabs.update).toHaveBeenCalledWith(9, { active: true });
    expect(namespace.tabs.update.mock.invocationCallOrder[0]).toBeLessThan(namespace.tabs.remove.mock.invocationCallOrder[0]);
    expect(namespace.tabs.remove).toHaveBeenCalledWith(1);
  });

  it("leaves Tabloom open when target activation fails", async () => {
    const namespace = createNamespace();
    namespace.tabs.update.mockRejectedValueOnce(new Error("activation failed"));
    const adapter = createWebExtensionAdapter("firefox", namespace);

    await expect(adapter.tabs.activateExisting(9)).rejects.toThrow("activation failed");
    expect(namespace.tabs.remove).not.toHaveBeenCalled();
  });

  it("reports cleanup failure after a successful activation", async () => {
    const namespace = createNamespace();
    namespace.tabs.remove.mockRejectedValueOnce(new Error("close failed"));
    const adapter = createWebExtensionAdapter("safari", namespace);

    await expect(adapter.tabs.activateExisting(9)).resolves.toEqual({ tabloomClosed: false, cleanupError: "close failed" });
    expect(namespace.tabs.update).toHaveBeenCalledWith(9, { active: true });
  });

  it("does not close the target when it is already the calling tab", async () => {
    const namespace = createNamespace();
    const adapter = createWebExtensionAdapter("chromium", namespace);

    await expect(adapter.tabs.activateExisting(1)).resolves.toEqual({ tabloomClosed: false });
    expect(namespace.tabs.remove).not.toHaveBeenCalled();
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

  it("requests tab-group permission before checking the permission-gated naming API", async () => {
    const namespace = createNamespace();
    let tabGroupsGranted = false;
    const updateGroup = vi.fn(async () => ({ id: 7 }));
    namespace.permissions.request.mockImplementation(async ({ permissions }) => {
      tabGroupsGranted = permissions.includes("tabGroups");
      return tabGroupsGranted;
    });
    Object.defineProperty(namespace, "tabGroups", {
      configurable: true,
      get: () => tabGroupsGranted ? { update: updateGroup } : undefined,
    });
    const adapter = createWebExtensionAdapter("chromium", namespace);

    expect(adapter.capabilities.tabGroups).toBe(true);
    await expect(adapter.tabs.openCollection("Design", ["https://example.com"])).resolves.toEqual({
      opened: 1,
      grouped: true,
    });
    expect(namespace.permissions.request).toHaveBeenCalledWith({ permissions: ["tabGroups"] });
    expect(updateGroup).toHaveBeenCalledWith(7, { title: "Design", collapsed: false });
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
