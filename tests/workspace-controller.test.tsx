import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";
import type { WorkspaceTrashRepository } from "../shared/trash-repository";
import { webOrganizerCapabilities } from "../shared/organizer/capabilities";
import { createWebPreferenceStore } from "../shared/organizer/preferences";
import { applyMutationFailure, reduceWorkspaceSnapshot } from "../shared/organizer/mutation-policy";
import { useWorkspaceController } from "../shared/organizer/useWorkspaceController";
import { WorkspaceOrganizer } from "../shared/organizer/WorkspaceOrganizer";
import { SupabaseTrashRepository } from "../shared/trash-repository";
import type { SupabaseClient } from "@supabase/supabase-js";

const snapshot = createDemoSnapshot();
const link = snapshot.links[0];
const capabilities = webOrganizerCapabilities({ openUrl: () => undefined });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const values = new Map<string, string>();
  const preferenceStore = createWebPreferenceStore({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } });
  return { values, options: { repository: new MemoryWorkspaceRepository("demo-user", snapshot), preferenceStore, preferenceScope: "account", userId: "demo-user", mutationPolicy: "rollbackOnFailure" as const, capabilities } };
}

describe("workspace mutation policy", () => {
  it("restores the captured web snapshot and preserves extension optimistic state", () => {
    const optimistic = { ...snapshot, links: [] };
    expect(applyMutationFailure("rollbackOnFailure", snapshot, optimistic)).toEqual({ snapshot, retryRequired: false });
    expect(applyMutationFailure("preserveLocalOnFailure", snapshot, optimistic)).toEqual({ snapshot: optimistic, retryRequired: true });
  });

  it("immutably creates, updates, moves, reorders, deletes a tree, and restores it", () => {
    const original = structuredClone(snapshot);
    const created = reduceWorkspaceSnapshot(snapshot, { type: "create-space", space: { ...snapshot.spaces[0], id: "new-space", position: 3 } });
    expect(created.spaces.map((item) => item.id)).toContain("new-space");
    const collection = { ...snapshot.collections[0], id: "new-collection", space_id: "new-space", position: 0 };
    const withCollection = reduceWorkspaceSnapshot(created, { type: "create-collection", collection });
    const withLink = reduceWorkspaceSnapshot(withCollection, { type: "create-link", link: { ...link, id: "new-link", collection_id: collection.id, position: 0 } });
    const updated = reduceWorkspaceSnapshot(withLink, { type: "update-link", id: "new-link", input: { title: "Changed" } });
    expect(updated.links.find((item) => item.id === "new-link")?.title).toBe("Changed");
    const moved = reduceWorkspaceSnapshot(updated, { type: "move-link", id: link.id, collectionId: "collection-design", index: 1 });
    expect(moved.links.filter((item) => item.collection_id === "collection-design").map((item) => item.title)).toEqual(["Brand system", "Product roadmap", "Homepage explorations", "Prototype"]);
    expect(moved.links.filter((item) => item.collection_id === "collection-plan").map((item) => item.position)).toEqual([0, 1]);
    const reordered = reduceWorkspaceSnapshot(moved, { type: "reorder-collections", spaceId: "space-launch", ids: ["collection-learn", "collection-plan", "collection-design"] });
    expect(reordered.collections.find((item) => item.id === "collection-learn")?.position).toBe(0);
    const deleted = reduceWorkspaceSnapshot(reordered, { type: "delete", rootType: "space", id: "new-space" });
    expect(deleted.collections.some((item) => item.id === "new-collection")).toBe(false);
    expect(deleted.links.some((item) => item.id === "new-link")).toBe(false);
    const restored = reduceWorkspaceSnapshot(deleted, { type: "restore", snapshot: { spaces: [created.spaces[3]], collections: [collection], links: [updated.links.find((item) => item.id === "new-link")!] } });
    expect(restored.links.find((item) => item.id === "new-link")?.title).toBe("Changed");
    expect(snapshot).toEqual(original);
  });

  it("rejects writes through read-only ancestors and malformed reorder sets", () => {
    const readOnly = { ...snapshot, spaces: snapshot.spaces.map((item) => ({ ...item, read_only: true })) };
    expect(() => reduceWorkspaceSnapshot(readOnly, { type: "update-link", id: link.id, input: { title: "No" } })).toThrow(/read.only/i);
    expect(() => reduceWorkspaceSnapshot(snapshot, { type: "reorder-collections", spaceId: "space-launch", ids: ["collection-plan"] })).toThrow();
    const protectedSibling = { ...snapshot, links: snapshot.links.map((item) => item.id === "link-3" ? { ...item, read_only: true } : item) };
    expect(() => reduceWorkspaceSnapshot(protectedSibling, { type: "move-link", id: link.id, collectionId: "collection-design", index: 0 })).toThrow(/read.only/i);
  });

  it("restores only affected writable groups and preserves protected and unrelated positions", () => {
    const before = { ...snapshot, links: snapshot.links.filter((item) => item.id !== link.id).map((item) => item.id === "link-3" ? { ...item, position: 17, read_only: true } : item) };
    const restored = reduceWorkspaceSnapshot(before, { type: "restore", snapshot: { spaces: [], collections: [], links: [link] } });
    expect(restored.spaces).toBe(before.spaces);
    expect(restored.collections).toBe(before.collections);
    expect(restored.links.find((item) => item.id === "link-3")).toBe(before.links.find((item) => item.id === "link-3"));
    expect(restored.links.filter((item) => item.collection_id === "collection-plan").map((item) => item.position)).toEqual([0, 1, 2]);
  });

  it("rejects restored trees with missing or protected ancestors and preserves protected siblings", () => {
    const restored = { spaces: [], collections: [], links: [link] };
    const before = { ...snapshot, links: snapshot.links.filter((item) => item.id !== link.id) };
    expect(() => reduceWorkspaceSnapshot({ ...before, spaces: [] }, { type: "restore", snapshot: restored })).toThrow();
    expect(() => reduceWorkspaceSnapshot({ ...before, collections: before.collections.map((item) => ({ ...item, read_only: true })) }, { type: "restore", snapshot: restored })).toThrow(/read.only/i);
    const protectedSibling = { ...before.links[0], read_only: true, position: 17 };
    const withProtected = { ...before, links: before.links.map((item) => item.id === protectedSibling.id ? protectedSibling : item) };
    expect(reduceWorkspaceSnapshot(withProtected, { type: "restore", snapshot: restored }).links.find((item) => item.id === protectedSibling.id)).toBe(protectedSibling);
  });
});

describe("workspace controller", () => {
  it("holds first content until selected space, rail, and collection preferences resolve", async () => {
    const { options, values } = setup();
    values.set("tabloom:selected-space:account", "space-research");
    values.set("tabloom:sidebar-collapsed", "false");
    values.set("tabloom:collapsed-collections:account", '["collection-plan"]');
    const gate = deferred<string | null>();
    const get = options.preferenceStore.get;
    options.preferenceStore.get = (key) => key === "tabloom:selected-space:account" ? gate.promise : get(key);
    render(<WorkspaceOrganizer {...options} />);
    expect(screen.getByRole("main", { name: "Loading workspace" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("heading", { name: "Product launch" })).not.toBeInTheDocument();
    await act(async () => gate.resolve("space-research"));
    expect(await screen.findByRole("heading", { name: "Research" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open Product launch" }));
    expect(screen.getByRole("button", { name: "Expand Plan" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a web edit optimistically then restores the captured snapshot on rejection", async () => {
    const { options } = setup();
    const gate = deferred<void>();
    options.repository.updateLink = () => gate.promise;
    render(<WorkspaceOrganizer {...options} />);
    await userEvent.click(await screen.findByRole("button", { name: `Edit ${link.title}` }));
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Optimistic title");
    await userEvent.click(screen.getByRole("button", { name: "Save link" }));
    expect(screen.getByText("Optimistic title")).toBeVisible();
    await act(async () => gate.reject(new Error("private server details")));
    expect(await screen.findByText(link.title)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/i);
    expect(screen.queryByText("private server details")).not.toBeInTheDocument();
  });

  it("keeps expanded space actions overlaid without consuming name layout width", async () => {
    const { options } = setup();
    const style = document.createElement("style");
    style.textContent = readFileSync("shared/organizer/organizer.css", "utf8");
    document.head.appendChild(style);
    try {
      render(<WorkspaceOrganizer {...options} />);
      await userEvent.click(await screen.findByRole("button", { name: "Expand sidebar" }));
      const actions = screen.getByRole("button", { name: "Edit Product launch" }).parentElement!;
      expect(getComputedStyle(actions).position).toBe("absolute");
    } finally { style.remove(); }
  });

  it("keeps failed local changes visible and routes Retry through the injected sync path", async () => {
    const { options } = setup();
    options.repository.updateLink = async () => { throw new Error("offline"); };
    const retry = vi.fn(async () => { await MemoryWorkspaceRepository.prototype.updateLink.call(options.repository, link.id, { title: "Local edit" }); });
    render(<WorkspaceOrganizer {...options} mutationPolicy="preserveLocalOnFailure" onRetry={retry} />);
    await userEvent.click(await screen.findByRole("button", { name: `Edit ${link.title}` }));
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Local edit");
    await userEvent.click(screen.getByRole("button", { name: "Save link" }));
    expect(await screen.findByText("Local edit")).toBeVisible();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument());
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByText("Local edit")).toBeVisible();
  });

  it("reconciles canonical IDs after creation and invalid selections after reload", async () => {
    const { options, values } = setup();
    const { result } = renderHook(() => useWorkspaceController(options));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.submitDialog({ type: "create-space", name: "New space", color: "#ffffff" }); });
    const canonical = (await options.repository.load()).spaces.find((item) => item.name === "New space")!;
    expect(result.current.selectedSpaceId).toBe(canonical.id);
    await options.repository.deleteSpace(canonical.id);
    await act(async () => { await result.current.reload(); });
    expect(result.current.selectedSpaceId).toBe("space-launch");
    expect(values.get("tabloom:selected-space:account")).toBe("space-launch");
  });

  it("serializes writes so a failed edit cannot roll back a later successful edit", async () => {
    const { options } = setup();
    const gate = deferred<void>();
    const update = options.repository.updateLink.bind(options.repository);
    options.repository.updateLink = (id, input) => input.title === "First" ? gate.promise : update(id, input);
    const { result } = renderHook(() => useWorkspaceController(options));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let second!: Promise<unknown>;
    act(() => {
      void result.current.submitDialog({ type: "edit-link", id: link.id, title: "First", url: link.url, description: "" });
      second = result.current.submitDialog({ type: "edit-link", id: link.id, title: "Second", url: link.url, description: "" });
    });
    await act(async () => { gate.reject(new Error("failed")); await second; });
    expect(result.current.snapshot.links[0].title).toBe("Second");
  });

  it("does not let a previous account load expose its workspace after a scope change", async () => {
    const { options } = setup();
    const gate = deferred<ReturnType<typeof createDemoSnapshot>>();
    options.repository.load = () => gate.promise;
    const next = setup().options;
    next.repository = new MemoryWorkspaceRepository("other", { spaces: [], collections: [], links: [] });
    const view = render(<WorkspaceOrganizer {...options} />);
    view.rerender(<WorkspaceOrganizer {...next} preferenceScope="other" userId="other" />);
    await screen.findByRole("heading", { name: "Your workspace" });
    await act(async () => gate.resolve(snapshot));
    expect(screen.queryByRole("button", { name: "Open Product launch" })).not.toBeInTheDocument();
  });

  it("keeps a committed create's canonical ID when the follow-up read fails", async () => {
    const { options } = setup();
    const { result } = renderHook(() => useWorkspaceController(options));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const load = options.repository.load.bind(options.repository);
    options.repository.load = async () => { throw new Error("network"); };
    await act(async () => { await result.current.submitDialog({ type: "create-space", name: "Committed", color: "#ffffff" }); });
    const canonical = (await load()).spaces.find((item) => item.name === "Committed")!;
    expect(result.current.snapshot.spaces.find((item) => item.name === "Committed")?.id).toBe(canonical.id);
    expect(result.current.selectedSpaceId).toBe(canonical.id);
  });

  it("normalizes source positions in persistence after a cross-collection move", async () => {
    const { options } = setup();
    const { result } = renderHook(() => useWorkspaceController(options));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.moveLink(link.id, "collection-design", 0); });
    expect((await options.repository.load()).links.filter((item) => item.collection_id === "collection-plan").map((item) => item.position)).toEqual([0, 1]);
  });

  it("uses one atomic move write and leaves server and UI unchanged on rejection", async () => {
    const { options } = setup();
    options.repository.moveLink = async () => { throw new Error("atomic rejection"); };
    const { result } = renderHook(() => useWorkspaceController(options));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.moveLink(link.id, "collection-design", 0); });
    expect(await options.repository.load()).toEqual(snapshot);
    expect(result.current.snapshot).toEqual(snapshot);
    expect(result.current.toasts.at(-1)?.message).toMatch(/could not be saved/i);
  });

  it("resolves queued moves from the current source and keeps both vacated collections normalized", async () => {
    const { options } = setup();
    const firstRead = deferred<ReturnType<typeof createDemoSnapshot>>();
    const load = options.repository.load.bind(options.repository);
    const { result } = renderHook(() => useWorkspaceController(options));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let reads = 0;
    options.repository.load = () => reads++ === 0 ? firstRead.promise : load();
    let second!: Promise<unknown>;
    act(() => {
      void result.current.moveLink(link.id, "collection-design", 0);
      second = result.current.moveLink(link.id, "collection-learn", 0);
    });
    await waitFor(async () => expect((await load()).links.find((item) => item.id === link.id)?.collection_id).toBe("collection-design"));
    await act(async () => { firstRead.resolve(await load()); await second; });
    expect((await load()).links.filter((item) => item.collection_id === "collection-design").map((item) => item.position)).toEqual([0, 1, 2]);
    expect((await load()).links.find((item) => item.id === link.id)?.collection_id).toBe("collection-learn");
  });

  it("holds Add link interactions until an optimistic collection receives its canonical ID", async () => {
    const { options } = setup();
    const gate = deferred<void>();
    const create = options.repository.createCollection.bind(options.repository);
    options.repository.createCollection = async (input) => { await gate.promise; return create(input); };
    render(<WorkspaceOrganizer {...options} />);
    await userEvent.click(await screen.findByRole("button", { name: "New collection" }));
    await userEvent.type(screen.getByLabelText("Name"), "New notes");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("group", { name: "New notes collection" });
    expect(screen.queryByRole("button", { name: "Add link to New notes" })).not.toBeInTheDocument();
    await act(async () => gate.resolve());
    await userEvent.click(await screen.findByRole("button", { name: "Add link to New notes" }));
    await userEvent.type(screen.getByLabelText("Title"), "Correct parent");
    await userEvent.clear(screen.getByLabelText("URL"));
    await userEvent.type(screen.getByLabelText("URL"), "https://example.com/canonical");
    await userEvent.click(screen.getByRole("button", { name: "Save link" }));
    await waitFor(async () => {
      const saved = await options.repository.load();
      expect(saved.links.find((item) => item.title === "Correct parent")?.collection_id).toBe(saved.collections.find((item) => item.name === "New notes")?.id);
    });
  });

  it("disables selecting a temporary space until its canonical record arrives", async () => {
    const { options } = setup();
    const gate = deferred<void>();
    const create = options.repository.createSpace.bind(options.repository);
    options.repository.createSpace = async (input) => { await gate.promise; return create(input); };
    render(<WorkspaceOrganizer {...options} />);
    await userEvent.click(await screen.findByRole("button", { name: "New space" }));
    await userEvent.type(screen.getByLabelText("Name"), "Pending space");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: "Open Pending space" })).toBeDisabled();
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Pending space" })).toBeEnabled());
  });

  it("keeps the mutation queue usable after an atomic move rejection", async () => {
    const { options } = setup();
    options.repository.moveLink = async () => { throw new Error("rejected"); };
    const { result } = renderHook(() => useWorkspaceController(options));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      const move = result.current.moveLink(link.id, "collection-design", 0);
      const edit = result.current.submitDialog({ type: "edit-link", id: link.id, title: "Still editable", url: link.url, description: "" });
      await Promise.all([move, edit]);
    });
    expect(result.current.snapshot.links[0]).toMatchObject({ title: "Still editable", collection_id: "collection-plan" });
    expect((await options.repository.load()).links[0].title).toBe("Still editable");
  });

  it("keeps local create identity-dependent actions pending until Retry reconciles canonical IDs", async () => {
    const { options } = setup();
    const create = options.repository.createCollection.bind(options.repository);
    options.repository.createCollection = async (input) => { await create(input); throw new Error("sync failed after local commit"); };
    const onRetry = vi.fn(async () => undefined);
    const { result } = renderHook(() => useWorkspaceController({ ...options, mutationPolicy: "preserveLocalOnFailure", onRetry }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.submitDialog({ type: "create-collection", spaceId: "space-launch", name: "Local notes" }); });
    const temporary = result.current.snapshot.collections.find((item) => item.name === "Local notes")!;
    expect(result.current.retryRequired).toBe(true);
    expect(result.current.isPending(temporary.id)).toBe(true);
    act(() => result.current.openDialog({ type: "create-link", collectionId: temporary.id }));
    expect(result.current.dialog).toBeNull();
    await act(async () => { await result.current.retry(); });
    const canonical = result.current.snapshot.collections.find((item) => item.name === "Local notes")!;
    expect(canonical.id).not.toBe(temporary.id);
    expect(result.current.isPending(canonical.id)).toBe(false);
    expect(result.current.retryRequired).toBe(false);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("retains newer manual selection when a create returns its canonical record", async () => {
    const { options } = setup();
    const gate = deferred<void>();
    const create = options.repository.createSpace.bind(options.repository);
    options.repository.createSpace = async (input) => { await gate.promise; return create(input); };
    const { result } = renderHook(() => useWorkspaceController(options));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let created!: Promise<unknown>;
    act(() => { created = result.current.submitDialog({ type: "create-space", name: "New", color: "#ffffff" }); });
    await waitFor(() => expect(result.current.snapshot.spaces).toHaveLength(4));
    act(() => result.current.selectSpace("space-research"));
    await act(async () => { gate.resolve(); await created; });
    expect(result.current.selectedSpaceId).toBe("space-research");
  });

  it("keeps a committed Supabase restore visible when its canonical read fails", async () => {
    const { options } = setup();
    await options.repository.deleteLink(link.id);
    let restores = 0;
    const client = { rpc: async (name: string) => {
      if (name === "restore_workspace_trash") {
        restores++;
        return { error: null, data: { status: "restored", trashId: "60000000-0000-4000-8000-000000000001", rootType: "link", rootId: "30000000-0000-4000-8000-000000000001", revision: 8 } };
      }
      return { data: null, error: { message: "read unavailable" } };
    } } as unknown as SupabaseClient;
    const { result } = renderHook(() => useWorkspaceController({ ...options, trashRepository: new SupabaseTrashRepository(client) }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.restore("60000000-0000-4000-8000-000000000001", { spaces: [], collections: [], links: [link] }); });
    expect(result.current.snapshot.links.some((item) => item.id === link.id)).toBe(true);
    expect(result.current.toasts.at(-1)?.message).toMatch(/restored.*refresh/i);
    expect(result.current.toasts.at(-1)?.action?.label).toBe("Refresh");
    expect(restores).toBe(1);
  });

  it("preserves a selection made while the canonical refresh is pending", async () => {
    const { options } = setup();
    const { result } = renderHook(() => useWorkspaceController(options));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const gate = deferred<ReturnType<typeof createDemoSnapshot>>();
    const load = options.repository.load.bind(options.repository);
    options.repository.load = () => gate.promise;
    act(() => { void result.current.submitDialog({ type: "edit-link", id: link.id, title: "Committed", url: link.url, description: "" }); });
    await waitFor(() => expect(result.current.snapshot.links[0].title).toBe("Committed"));
    act(() => result.current.selectSpace("space-research"));
    await act(async () => gate.resolve(await load()));
    expect(result.current.selectedSpaceId).toBe("space-research");
  });

  it("does not undo a user's space selection when an unrelated edit fails", async () => {
    const { options } = setup();
    const gate = deferred<void>();
    options.repository.updateLink = () => gate.promise;
    const { result } = renderHook(() => useWorkspaceController(options));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => { void result.current.submitDialog({ type: "edit-link", id: link.id, title: "Pending", url: link.url, description: "" }); });
    await waitFor(() => expect(result.current.snapshot.links[0].title).toBe("Pending"));
    act(() => result.current.selectSpace("space-research"));
    await act(async () => gate.reject(new Error("fail")));
    expect(result.current.selectedSpaceId).toBe("space-research");
  });

  it("uses the authoritative restore snapshot and rolls failed optimistic restore back", async () => {
    const { options } = setup();
    await options.repository.deleteLink(link.id);
    const gate = deferred<ReturnType<typeof createDemoSnapshot>>();
    const trash: WorkspaceTrashRepository = { list: async () => [], prepareDelete: async () => { throw new Error("unused"); }, deleteEntity: async () => { throw new Error("unused"); }, restore: () => gate.promise };
    const { result } = renderHook(() => useWorkspaceController({ ...options, trashRepository: trash }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => { void result.current.restore("trash", { spaces: [], collections: [], links: [link] }); });
    await waitFor(() => expect(result.current.snapshot.links.some((item) => item.id === link.id)).toBe(true));
    await act(async () => gate.reject(new Error("fail")));
    await waitFor(() => expect(result.current.snapshot.links.some((item) => item.id === link.id)).toBe(false));
    trash.restore = async () => snapshot;
    await act(async () => { await result.current.restore("trash", { spaces: [], collections: [], links: [link] }); });
    expect(result.current.snapshot.links.find((item) => item.id === link.id)).toEqual(link);
  });

  it("waits for duplicate consent and warns before opening a large collection", async () => {
    const { options } = setup();
    const open = vi.fn(async () => undefined);
    const { result } = renderHook(() => useWorkspaceController({ ...options, capabilities: { ...capabilities, openCollection: open } }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.submitDialog({ type: "create-link", collectionId: link.collection_id, title: "Duplicate", url: link.url, description: "" }); });
    expect(result.current.dialog?.type).toBe("duplicate-link");
    expect((await options.repository.load()).links).toHaveLength(8);
    await act(async () => { await result.current.submitDialog({ type: "duplicate-link" }); });
    expect((await options.repository.load()).links).toHaveLength(9);
    act(() => result.current.openCollection(snapshot.collections[0], Array.from({ length: 16 }, () => link)));
    expect(result.current.dialog?.type).toBe("open-many");
    expect(open).not.toHaveBeenCalled();
    await act(async () => { await result.current.submitDialog({ type: "open-many", name: "Plan", urls: [link.url] }); });
    expect(open).toHaveBeenCalledWith("Plan", [link.url]);
  });

  it("requires human container confirmation and uses the prepared Trash intent", async () => {
    const { options } = setup();
    const trash: WorkspaceTrashRepository = {
      list: async () => [],
      prepareDelete: async (targetType, targetId) => ({ intentId: "intent", targetType, targetId, targetName: "Plan", collectionCount: 0, linkCount: 3, expiresAt: "2099-01-01T00:00:00Z" }),
      deleteEntity: vi.fn(async (rootType, rootId, _source, operationId, intentId) => {
        expect(intentId).toBe("intent");
        await options.repository.deleteCollection(rootId);
        return { operationId, rootType, rootId, trashId: "trash", restoreUntil: "2099-01-01T00:00:00Z" };
      }),
      restore: async () => snapshot,
    };
    render(<WorkspaceOrganizer {...options} trashRepository={trash} deleteSource="web" />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Plan" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Plan”?" });
    expect(trash.deleteEntity).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent("3 saved links will move to Trash");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete collection" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Plan collection" })).not.toBeInTheDocument());
    expect(trash.deleteEntity).toHaveBeenCalledWith("collection", "collection-plan", "web", expect.any(String), "intent");
  });

  it("composes slots, native links, keyboard moves and exact drag insertion targets", async () => {
    const { options } = setup();
    render(<WorkspaceOrganizer {...options} accountControls={<button>Account</button>} currentTabs={<aside aria-label="Current tabs">Tabs</aside>} />);
    const anchor = await screen.findByRole("link", { name: /Product roadmap/ });
    expect(anchor).toHaveAttribute("href", link.url);
    expect(anchor).not.toHaveAttribute("target");
    expect(screen.getByRole("button", { name: "Account" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Current tabs" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Move Launch checklist earlier" }));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Plan collection" })).getAllByRole("link")[1]).toHaveTextContent("Launch checklist"));
    const transfer = { effectAllowed: "none", dropEffect: "none", types: [], getData: () => "" };
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag Product roadmap" }), { dataTransfer: transfer });
    fireEvent.dragOver(screen.getByRole("link", { name: /Brand system/ }), { dataTransfer: transfer });
    const target = screen.getByRole("group", { name: "Design collection" }).querySelector(".ext-link-drop-preview")!;
    expect(target).toBeInTheDocument();
    fireEvent.drop(target, { dataTransfer: transfer });
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Design collection" })).getAllByRole("link")[0]).toHaveTextContent("Product roadmap"));
    expect((await options.repository.load()).links.find((item) => item.id === link.id)?.collection_id).toBe("collection-design");
  });

  it("drops a collection on a row even without a preceding hover event", async () => {
    const { options } = setup();
    render(<WorkspaceOrganizer {...options} />);
    const transfer = { effectAllowed: "none", dropEffect: "none", types: [], getData: () => "" };
    fireEvent.dragStart(await screen.findByRole("button", { name: "Drag Design collection" }), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("group", { name: "Plan collection" }), { dataTransfer: transfer });
    await waitFor(() => expect(screen.getAllByRole("group")[0]).toHaveAccessibleName("Design collection"));
    expect((await options.repository.load()).collections.find((item) => item.id === "collection-design")?.position).toBe(0);
  });

  it("shows an injected external drag target and offers saved destinations for bookmark copies", async () => {
    const { options } = setup();
    const accept = vi.fn(() => true);
    const bookmarkCollection = { ...snapshot.collections[0], id: "bookmarks", origin: "browser-bookmark" as const, read_only: true, space_id: "space-research" };
    const bookmark = { ...link, id: "bookmark", collection_id: "bookmarks", origin: "browser-bookmark" as const, read_only: true, title: "Browser bookmark" };
    options.repository = new MemoryWorkspaceRepository("demo-user", { ...snapshot, collections: [...snapshot.collections, bookmarkCollection], links: [...snapshot.links, bookmark] });
    const copy = vi.fn(async (_link, collectionId: string) => { await options.repository.createLink({ collection_id: collectionId, title: "Copied bookmark", url: "https://example.com/copied", description: "", favicon_url: null }); });
    render(<WorkspaceOrganizer {...options} externalDrop={{ session: 1, isDrag: () => true, accept }} onBookmarkDrop={copy} />);
    const transfer = { effectAllowed: "none", dropEffect: "none", types: [], getData: () => "" };
    const plan = await screen.findByRole("group", { name: "Plan collection" });
    fireEvent.dragOver(plan, { dataTransfer: transfer });
    expect(plan).toHaveClass("drop-target");
    fireEvent.drop(plan, { dataTransfer: transfer });
    expect(accept).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Open Research" }));
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag Browser bookmark" }), { dataTransfer: transfer });
    const target = screen.getByRole("group", { name: "Plan copy target" });
    fireEvent.drop(target, { dataTransfer: transfer });
    await waitFor(() => expect(copy).toHaveBeenCalledWith(bookmark, "collection-plan"));
    expect((await options.repository.load()).links.some((item) => item.title === "Copied bookmark")).toBe(true);
  });
});
