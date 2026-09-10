import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBootstrapResult } from "../extension/workspace-bootstrap";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BROWSER_BOOKMARKS_SPACE_ID, toBookmarkWorkspace } from "../shared/bookmarks";
import { ChromeSnapshotCache } from "../extension/storage";
import { LocalFirstStorage } from "../extension/local-first-storage";
import { LocalFirstWorkspaceRepository } from "../extension/local-first-repository";
import { browserAdapter } from "../extension/browser";

const mocks = vi.hoisted(() => ({
  bootstrapWorkspace: vi.fn(),
  signIn: vi.fn(),
  openAndInspect: vi.fn(),
  storageState: {} as Record<string, unknown>,
  selectionReadGate: null as Promise<void> | null,
  tabs: [] as Array<{ id: number; title: string; url: string; active?: boolean }>,
  activated: [] as number[],
  closed: [] as number[],
  tabListeners: new Set<() => void>(),
  storageListeners: new Set<(keys: string[]) => void>(),
  supabase: null as SupabaseClient | null,
  getRevision: vi.fn(),
  loadCanonical: vi.fn(),
  applyOperations: vi.fn(),
}));

vi.mock("../extension/workspace-bootstrap", async (importOriginal) => ({
  ...await importOriginal<typeof import("../extension/workspace-bootstrap")>(),
  bootstrapWorkspace: mocks.bootstrapWorkspace,
}));

vi.mock("../extension/supabase", () => ({
  get extensionSupabase() { return mocks.supabase; },
  recoverExtensionSessionSilently: vi.fn(),
  signInExtensionWithGoogle: mocks.signIn,
}));

vi.mock("../extension/workspace-sync-transport", () => ({
  SupabaseWorkspaceSyncTransport: class {
    getRevision = mocks.getRevision;
    loadCanonical = mocks.loadCanonical;
    applyOperations = mocks.applyOperations;
  },
}));

vi.mock("../extension/browser", () => ({
  browserTarget: "chromium",
  browserAdapter: {
    target: "chromium",
    capabilities: { bookmarks: true, identity: true, tabGroups: false },
    storage: {
      get: vi.fn(async (key: string) => {
        if (key === "tabloom:selected-spaces:v1") await mocks.selectionReadGate;
        return { [key]: mocks.storageState[key] };
      }),
      set: vi.fn(async (value: Record<string, unknown>) => {
        Object.assign(mocks.storageState, value);
      }),
      remove: vi.fn(async (key: string) => {
        delete mocks.storageState[key];
      }),
    },
    storageChanges: { subscribe: vi.fn((listener: (keys: string[]) => void) => { mocks.storageListeners.add(listener); return () => { mocks.storageListeners.delete(listener); }; }) },
    tabChanges: { subscribe: (listener: () => void) => { mocks.tabListeners.add(listener); return () => { mocks.tabListeners.delete(listener); }; } },
    identity: {
      getRedirectURL: vi.fn((path = "") => `https://stable-id.chromiumapp.org/${path}`),
      launchWebAuthFlow: vi.fn(),
    },
    bookmarks: { getTree: vi.fn(async () => []) },
    favicons: { resolve: vi.fn(() => null) },
    permissions: { request: vi.fn(async () => false) },
    tabs: {
      listCurrentWindow: vi.fn(async () => mocks.tabs),
      openAndInspect: mocks.openAndInspect,
      activateExisting: vi.fn(async (id: number) => { mocks.activated.push(id); return { cleanupError: null }; }),
      close: vi.fn(async (ids: number[]) => { mocks.closed.push(...ids); mocks.tabs = mocks.tabs.filter((tab) => !ids.includes(tab.id)); }),
      openCollection: vi.fn(async () => ({ opened: 3, grouped: true })),
    },
  },
}));

import { ExtensionApp } from "../extension/src";

function accountSnapshot(userId: string, offset = 0) {
  const snapshot = createDemoSnapshot();
  const ids = new Map([...snapshot.spaces, ...snapshot.collections, ...snapshot.links].map((item, index) => [item.id, `00000000-0000-4000-8000-${String(index + 1 + offset).padStart(12, "0")}`]));
  return {
    spaces: snapshot.spaces.map((item) => ({ ...item, id: ids.get(item.id)!, user_id: userId })),
    collections: snapshot.collections.map((item) => ({ ...item, id: ids.get(item.id)!, space_id: ids.get(item.space_id)!, user_id: userId })),
    links: snapshot.links.map((item) => ({ ...item, id: ids.get(item.id)!, collection_id: ids.get(item.collection_id)!, user_id: userId })),
  };
}

describe("ExtensionApp bootstrap", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    mocks.bootstrapWorkspace.mockReset();
    mocks.signIn.mockReset();
    vi.mocked(browserAdapter.storage.get).mockClear();
    mocks.openAndInspect.mockReset();
    for (const key of Object.keys(mocks.storageState)) delete mocks.storageState[key];
    mocks.tabs = [];
    mocks.activated = [];
    mocks.closed = [];
    mocks.tabListeners.clear();
    mocks.storageListeners.clear();
    mocks.selectionReadGate = null;
    mocks.supabase = null;
    mocks.getRevision.mockReset().mockResolvedValue({ revision: 1, serverTime: "2026-09-10T00:00:00Z" });
    mocks.loadCanonical.mockReset();
    mocks.applyOperations.mockReset();
  });

  it("keeps the boot boundary mounted until clean-install recovery resolves", async () => {
    const deferred = Promise.withResolvers<WorkspaceBootstrapResult>();
    mocks.bootstrapWorkspace.mockReturnValue(deferred.promise);

    render(<ExtensionApp />);

    expect(screen.getByRole("main", { name: "Restoring workspace" })).toBeVisible();
    expect(screen.queryByText("My Collection")).not.toBeInTheDocument();

    deferred.resolve({
      mode: "recovered",
      localRepository: null,
      session: { user: { id: "user-1" } },
      recoverySuggested: false,
    });

    await waitFor(() => {
      expect(screen.queryByRole("main", { name: "Restoring workspace" })).not.toBeInTheDocument();
    });
  });

  it("leaves saved-card clicks to native current-tab and modifier-key browser behavior", async () => {
    const snapshot = createDemoSnapshot();
    mocks.bootstrapWorkspace.mockResolvedValue({
      mode: "local-only",
      localRepository: new MemoryWorkspaceRepository("local-user", snapshot),
      session: null,
      recoverySuggested: false,
    });

    render(<ExtensionApp />);
    const card = await screen.findByRole("link", { name: /Product roadmap/i });
    let regularClickWasPrevented = false;
    document.addEventListener("click", (event) => {
      regularClickWasPrevented = event.defaultPrevented;
      event.preventDefault();
    }, { once: true });
    const regularClick = createEvent.click(card, { button: 0 });
    fireEvent(card, regularClick);
    let commandClickWasPrevented = false;
    document.addEventListener("click", (event) => {
      commandClickWasPrevented = event.defaultPrevented;
      event.preventDefault();
    }, { once: true });
    const commandClick = createEvent.click(card, { button: 0, metaKey: true });
    fireEvent(card, commandClick);

    expect(regularClickWasPrevented).toBe(false);
    expect(commandClickWasPrevented).toBe(false);
    expect(mocks.openAndInspect).not.toHaveBeenCalled();
  });

  it("composes the current-tabs sheet around one shared organizer", async () => {
    mocks.bootstrapWorkspace.mockResolvedValue({
      mode: "local-only",
      localRepository: new MemoryWorkspaceRepository("local-user", createDemoSnapshot()),
      session: null,
      recoverySuggested: false,
    });

    render(<ExtensionApp />);

    expect(await screen.findByTestId("shared-workspace-organizer")).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Current tabs" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "New collection" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "New collection" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("waits for selected-space and collapse preferences before revealing the organizer", async () => {
    const snapshot = createDemoSnapshot();
    const space = { ...snapshot.spaces[0], id: "remembered", name: "Remembered space", position: 1 };
    snapshot.spaces.push(space);
    snapshot.collections.push({ ...snapshot.collections[0], id: "remembered-collection", space_id: space.id, name: "Remembered collection" });
    mocks.storageState["tabloom:selected-spaces:v1"] = { local: space.id };
    mocks.storageState["tabloom:sidebar-collapsed"] = "false";
    mocks.storageState["tabloom:collapsed-collections:v1"] = { local: ["remembered-collection"] };
    mocks.bootstrapWorkspace.mockResolvedValue({ mode: "local-only", localRepository: new MemoryWorkspaceRepository("local-user", snapshot), session: null, recoverySuggested: false });

    render(<ExtensionApp />);
    await screen.findByTestId("shared-workspace-organizer");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Remembered space");
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Expand Remembered collection" })).toHaveAttribute("aria-expanded", "false");
  });

  it("routes sharing from a local collection into the existing sign-in modal", async () => {
    const snapshot = createDemoSnapshot();
    mocks.bootstrapWorkspace.mockResolvedValue({
      mode: "local-only",
      localRepository: new MemoryWorkspaceRepository("local-user", snapshot),
      session: null,
      recoverySuggested: false,
    });

    render(<ExtensionApp />);
    await userEvent.click(await screen.findByRole("button", { name: "Share Plan" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Share Plan" })).getByRole("button", { name: "Sign in to sync" }));

    expect(screen.getByRole("dialog", { name: "Sync with Tabloom" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Share Plan" })).not.toBeInTheDocument();
  });

  it("highlights an already saved tab and closes it without making another copy", async () => {
    const snapshot = createDemoSnapshot();
    const link = snapshot.links[0];
    const repository = new MemoryWorkspaceRepository("local-user", snapshot);
    mocks.tabs = [{ id: 41, title: "Duplicate tab", url: link.url }];
    mocks.bootstrapWorkspace.mockResolvedValue({ mode: "local-only", localRepository: repository, session: null, recoverySuggested: false });
    render(<ExtensionApp />);
    const card = await screen.findByRole("link", { name: /Product roadmap/ });
    const collection = screen.getByRole("group", { name: "Plan collection" });
    const dataTransfer = { types: ["application/x-tabloom-tab"], getData: () => JSON.stringify(mocks.tabs[0]), setData: vi.fn() };
    fireEvent.drop(collection, { dataTransfer });
    expect(screen.getByRole("dialog", { name: "Duplicate current tab" })).toBeVisible();
    expect(card).toHaveClass("duplicate-highlight");
    await userEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open Duplicate tab" })).not.toBeInTheDocument());
    expect(mocks.closed).toEqual([41]);
    expect((await repository.load()).links).toHaveLength(snapshot.links.length);
  });

  it("keeps the current-tabs sheet vertical and reclaims its width when collapsed", async () => {
    mocks.bootstrapWorkspace.mockResolvedValue({ mode: "local-only", localRepository: new MemoryWorkspaceRepository("local-user", createDemoSnapshot()), session: null, recoverySuggested: false });
    const style = document.createElement("style");
    style.textContent = readFileSync("shared/organizer/organizer.css", "utf8") + readFileSync("extension/style.css", "utf8").replace(/@import[^;]+;/g, "");
    document.head.appendChild(style);
    try {
      render(<ExtensionApp />);
      await screen.findByTestId("shared-workspace-organizer");
      expect(getComputedStyle(screen.getByRole("button", { name: "New collection" })).borderRadius).toBe("10px");
      await userEvent.click(screen.getByRole("button", { name: "Collapse current tabs" }));
      expect(getComputedStyle(screen.getByRole("main")).gridTemplateColumns).toContain("54px");
      expect(getComputedStyle(screen.getByRole("complementary", { name: "Current tabs" })).gridColumn).toBe("3");
    } finally { style.remove(); }
  });

  it("refreshes live window changes and activates current-tab search results through the browser", async () => {
    mocks.tabs = [{ id: 41, title: "Live docs", url: "https://example.com/docs" }, { id: 99, title: "Tabloom", url: "chrome-extension://tabloom/index.html", active: true }];
    mocks.bootstrapWorkspace.mockResolvedValue({ mode: "local-only", localRepository: new MemoryWorkspaceRepository("local-user", createDemoSnapshot()), session: null, recoverySuggested: false });
    render(<ExtensionApp />);
    expect(await screen.findByRole("button", { name: "Open Live docs" })).toBeVisible();
    mocks.tabs = [{ id: 42, title: "Replacement docs", url: "https://example.com/replacement" }];
    act(() => { mocks.tabListeners.forEach((listener) => listener()); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open Live docs" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open Replacement docs" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Search all links" }));
    await userEvent.type(screen.getByRole("searchbox"), "Replacement");
    await userEvent.click(await screen.findByRole("button", { name: "Replacement docs, Current window" }));
    expect(mocks.activated).toEqual([42]);
    expect(screen.queryByRole("dialog", { name: "Search Tabloom" })).not.toBeInTheDocument();
  });

  it("uses current-tab anchors for saved search results without intercepting modifier clicks", async () => {
    mocks.bootstrapWorkspace.mockResolvedValue({ mode: "local-only", localRepository: new MemoryWorkspaceRepository("local-user", createDemoSnapshot()), session: null, recoverySuggested: false });
    render(<ExtensionApp />);
    await userEvent.click(await screen.findByRole("button", { name: "Search all links" }));
    await userEvent.type(screen.getByRole("searchbox"), "Product roadmap");
    const link = screen.getByRole("link", { name: "Product roadmap, Product launch, Plan" });
    expect(link).not.toHaveAttribute("target", "_blank");
    let prevented = true;
    document.addEventListener("click", (event) => { prevented = event.defaultPrevented; event.preventDefault(); }, { once: true });
    fireEvent.click(link, { ctrlKey: true, button: 0 });
    expect(prevented).toBe(false);
    expect(screen.getByRole("dialog", { name: "Search Tabloom" })).toBeVisible();
  });

  it.each(["toast", "account"])("preserves a failed local-first edit and routes %s Retry through the existing coordinator", async (surface) => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const snapshot = accountSnapshot(userId);
    mocks.supabase = {} as SupabaseClient;
    await new ChromeSnapshotCache(browserAdapter.storage).saveCloud(userId, { revision: 1, snapshot });
    mocks.bootstrapWorkspace.mockResolvedValue({ mode: "local-session", localRepository: new MemoryWorkspaceRepository("local-user", snapshot), session: { user: { id: userId, email: "owner@example.com" } }, recoverySuggested: false });
    mocks.applyOperations.mockRejectedValueOnce(new Error("Offline"));
    render(<ExtensionApp />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit Product roadmap" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Title" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Title" }), "Locally edited roadmap");
    await userEvent.click(screen.getByRole("button", { name: "Save link" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("link", { name: /Locally edited roadmap/ })).toBeVisible();
    const storage = new LocalFirstStorage(browserAdapter.storage, userId);
    const failed = await storage.loadOrThrow();
    expect(failed.snapshot.links[0].title).toBe("Locally edited roadmap");
    expect(failed.queue[0].state).toBe("failed");
    mocks.applyOperations.mockResolvedValueOnce({
      revision: 2, outcomes: [{ operationId: failed.queue[0].operation.operationId, status: "applied" }],
      patches: { spaces: [], collections: [], links: [failed.snapshot.links[0]] }, tombstones: [], conflicts: [],
    });
    if (surface === "account") {
      await userEvent.click(screen.getByRole("button", { name: "Open account menu" }));
      await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));
    } else await userEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument());
    expect((await storage.loadOrThrow()).queue).toHaveLength(0);
    expect(screen.getByRole("link", { name: /Locally edited roadmap/ })).toBeVisible();
  });

  it("mounts browser bookmark sync in the remembered read-only space", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const snapshot = accountSnapshot(userId);
    const bookmarks = toBookmarkWorkspace(userId, []);
    snapshot.spaces.push(...bookmarks.spaces);
    mocks.supabase = { from: () => ({ select: () => ({ order: async () => ({ data: [], error: null }) }) }) } as unknown as SupabaseClient;
    mocks.storageState["tabloom:selected-spaces:v1"] = { [`account:${userId}`]: BROWSER_BOOKMARKS_SPACE_ID };
    await new ChromeSnapshotCache(browserAdapter.storage).saveCloud(userId, { revision: 1, snapshot });
    mocks.bootstrapWorkspace.mockResolvedValue({ mode: "local-session", localRepository: new MemoryWorkspaceRepository("local-user", snapshot), session: { user: { id: userId } }, recoverySuggested: false });
    render(<ExtensionApp />);
    expect(await screen.findByRole("button", { name: "Sync browser bookmarks" })).toBeVisible();
    expect(screen.getByTestId("shared-workspace-organizer")).toContainElement(screen.getByRole("region", { name: "Browser bookmark sync" }));
    expect(screen.queryByRole("button", { name: "New collection" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save all as collection" })).toBeDisabled();
  });

  it("coalesces sync commits until deferred preferences finish, then reloads canonical data once", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const snapshot = accountSnapshot(userId);
    mocks.supabase = {} as SupabaseClient;
    const scope = `account:${userId}`;
    mocks.storageState["tabloom:selected-spaces:v1"] = { [scope]: snapshot.spaces[1].id };
    await new ChromeSnapshotCache(browserAdapter.storage).saveCloud(userId, { revision: 1, snapshot });
    mocks.bootstrapWorkspace.mockResolvedValue({ mode: "recovered", localRepository: null, session: { user: { id: userId } }, recoverySuggested: false });
    const gate = Promise.withResolvers<void>();
    mocks.selectionReadGate = gate.promise;
    const revision = Promise.withResolvers<{ revision: number; serverTime: string }>();
    mocks.getRevision.mockReturnValue(revision.promise);
    const canonical = structuredClone(snapshot);
    canonical.spaces[1].name = "Canonical research";
    mocks.loadCanonical.mockResolvedValue({ revision: 2, snapshot: canonical, tombstones: [] });
    const load = vi.spyOn(LocalFirstWorkspaceRepository.prototype, "load");
    render(<ExtensionApp />);
    const storage = new LocalFirstStorage(browserAdapter.storage, userId);
    await waitFor(() => expect(mocks.getRevision).toHaveBeenCalledOnce());
    await waitFor(() => expect(browserAdapter.storage.get).toHaveBeenCalledWith("tabloom:selected-spaces:v1"));
    await act(async () => revision.resolve({ revision: 2, serverTime: "2026-09-10T00:00:00Z" }));
    await waitFor(async () => expect((await storage.loadOrThrow()).sync.lastRevisionCheckAt).toBeTruthy());
    // Separate browser-storage notifications must remain pending across renders too.
    for (const name of ["Queued research", "Latest research"]) {
      await act(async () => {
        await storage.update(async (current) => {
          current.snapshot.spaces[1].name = name;
          return [current, undefined];
        });
        mocks.storageListeners.forEach((listener) => listener([`tabloom-cloud-workspace-v2:${userId}`]));
      });
    }
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Latest research"));
    expect(load).toHaveBeenCalledTimes(2);
    expect(mocks.storageState["tabloom:selected-spaces:v1"]).toEqual({ [scope]: snapshot.spaces[1].id });
  });

  it("activates account repository and preferences together after delayed creation", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const snapshot = accountSnapshot(userId);
    const scope = `account:${userId}`;
    const selected = snapshot.spaces[1];
    const collapsed = snapshot.collections.filter((item) => item.space_id === selected.id).map((item) => item.id);
    mocks.supabase = {} as SupabaseClient;
    mocks.storageState["tabloom:selected-spaces:v1"] = { [scope]: selected.id };
    mocks.storageState["tabloom:collapsed-collections:v1"] = { [scope]: collapsed };
    await new ChromeSnapshotCache(browserAdapter.storage).saveCloud(userId, { revision: 1, snapshot });
    mocks.bootstrapWorkspace.mockResolvedValue({ mode: "local-session", localRepository: new MemoryWorkspaceRepository("local-user", createDemoSnapshot()), session: { user: { id: userId } }, recoverySuggested: false });
    const gate = Promise.withResolvers<void>();
    const create = LocalFirstWorkspaceRepository.create;
    const creating = vi.spyOn(LocalFirstWorkspaceRepository, "create").mockImplementation(async (options) => {
      const repository = await create(options);
      await gate.promise;
      return repository;
    });
    render(<ExtensionApp />);
    await waitFor(() => expect(creating).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Product launch");
    expect(mocks.storageState["tabloom:selected-spaces:v1"]).toMatchObject({ [scope]: selected.id });
    expect(mocks.storageState["tabloom:collapsed-collections:v1"]).toMatchObject({ [scope]: collapsed });
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Research"));
    for (const collection of snapshot.collections.filter((item) => collapsed.includes(item.id))) {
      expect(screen.getByRole("button", { name: `Expand ${collection.name}` })).toHaveAttribute("aria-expanded", "false");
    }
    expect(mocks.storageState["tabloom:selected-spaces:v1"]).toMatchObject({ [scope]: selected.id });
    expect(mocks.storageState["tabloom:collapsed-collections:v1"]).toMatchObject({ [scope]: collapsed });
  });

  it("does not activate or attach listeners after unmount during account creation", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const snapshot = accountSnapshot(userId);
    mocks.supabase = {} as SupabaseClient;
    await new ChromeSnapshotCache(browserAdapter.storage).saveCloud(userId, { revision: 1, snapshot });
    mocks.bootstrapWorkspace.mockResolvedValue({ mode: "recovered", localRepository: null, session: { user: { id: userId } }, recoverySuggested: false });
    const gate = Promise.withResolvers<void>();
    const create = LocalFirstWorkspaceRepository.create;
    const creating = vi.spyOn(LocalFirstWorkspaceRepository, "create").mockImplementation(async (options) => {
      const repository = await create(options);
      await gate.promise;
      return repository;
    });
    const view = render(<ExtensionApp />);
    await waitFor(() => expect(creating).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => gate.resolve());
    expect(mocks.getRevision).not.toHaveBeenCalled();
    expect(mocks.storageListeners.size).toBe(0);
    expect(mocks.tabListeners.size).toBe(0);
    expect(mocks.storageState["tabloom:selected-spaces:v1"]).toBeUndefined();
  });

  it("keeps a newer account active when an earlier account creation completes after logout", async () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const first = accountSnapshot(firstId);
    const second = accountSnapshot(secondId, 100);
    second.spaces[1].name = "Second account research";
    const selections = { local: "space-launch", [`account:${firstId}`]: first.spaces[1].id, [`account:${secondId}`]: second.spaces[1].id };
    mocks.storageState["tabloom:selected-spaces:v1"] = { ...selections };
    mocks.supabase = { auth: { signOut: vi.fn(async () => ({ error: null })) } } as unknown as SupabaseClient;
    const cache = new ChromeSnapshotCache(browserAdapter.storage);
    await cache.saveCloud(firstId, { revision: 1, snapshot: first });
    await cache.saveCloud(secondId, { revision: 1, snapshot: second });
    mocks.bootstrapWorkspace.mockResolvedValue({ mode: "local-session", localRepository: new MemoryWorkspaceRepository("local-user", createDemoSnapshot()), session: { user: { id: firstId } }, recoverySuggested: false });
    const gate = Promise.withResolvers<void>();
    const create = LocalFirstWorkspaceRepository.create;
    const creating = vi.spyOn(LocalFirstWorkspaceRepository, "create").mockImplementation(async (options) => {
      const repository = await create(options);
      if (options.userId === firstId) await gate.promise;
      return repository;
    });
    const view = render(<ExtensionApp />);
    await waitFor(() => expect(creating).toHaveBeenCalledOnce());
    await userEvent.click(await screen.findByRole("button", { name: "Open account menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    await userEvent.click(await screen.findByRole("button", { name: "Sign in to sync" }));
    mocks.signIn.mockResolvedValue({ user: { id: secondId } });
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Second account research"));
    await act(async () => gate.resolve());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Second account research");
    expect(mocks.storageState["tabloom:selected-spaces:v1"]).toEqual(selections);
    expect(mocks.getRevision).toHaveBeenCalledOnce();
    expect(mocks.storageListeners.size).toBe(1);
    view.unmount();
    expect(mocks.storageListeners.size).toBe(0);
    expect(mocks.tabListeners.size).toBe(0);
  });
});
