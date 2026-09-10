import { describe, expect, it, vi } from "vitest";
import { LocalTrashRepository } from "../extension/local-trash-repository";
import { createLocalWorkspaceRepository } from "../extension/storage";
import { LocalFirstStorage } from "../extension/local-first-storage";
import { LocalFirstWorkspaceRepository } from "../extension/local-first-repository";
import type { StorageArea } from "../extension/workspace-cache";
import type { WorkspaceTrashRepository } from "../shared/trash-repository";
import { LOCAL_WORKSPACE_KEY } from "../extension/workspace-cache";

function area(): StorageArea {
  const values: Record<string, unknown> = {};
  return { async get(key) { return { [key]: structuredClone(values[key]) }; }, async set(items) { Object.assign(values, structuredClone(items)); } };
}
async function fixture() {
  const storage = area();
  const workspace = await createLocalWorkspaceRepository(storage);
  const original = await workspace.load();
  const link = await workspace.createLink({ collection_id: original.collections[0].id, title: "Recover me", url: "https://example.com", description: "Notes", favicon_url: null });
  const trash = new LocalTrashRepository(storage, workspace, "local");
  return { storage, workspace, trash, link };
}

describe("local Trash", () => {
  it("recovers a signed-out deletion across repository reconstruction with stable IDs", async () => {
    const { storage, workspace, trash, link } = await fixture();
    const operationId = crypto.randomUUID();
    const receipt = await trash.deleteEntity("link", link.id, "extension", operationId);
    expect((await workspace.load()).links).toEqual([]);
    const reopened = await createLocalWorkspaceRepository(storage);
    const recovered = new LocalTrashRepository(storage, reopened, "local");
    expect(await recovered.list()).toEqual([expect.objectContaining({ operationId, rootName: "Recover me", source: "extension" })]);
    expect((await recovered.restore(receipt.trashId)).links).toEqual([link]);
    expect(await recovered.list()).toEqual([]);
  });

  it("requires an unexpired matching human intent and counts descendants", async () => {
    const { workspace, trash, link } = await fixture();
    const collection = (await workspace.load()).collections[0];
    await expect(trash.deleteEntity("collection", collection.id, "extension", crypto.randomUUID())).rejects.toMatchObject({ code: "confirmation_required" });
    const intent = await trash.prepareDelete("collection", collection.id);
    expect(intent).toMatchObject({ targetName: collection.name, linkCount: 1, collectionCount: 0 });
    const receipt = await trash.deleteEntity("collection", collection.id, "extension", crypto.randomUUID(), intent.intentId);
    expect((await trash.restore(receipt.trashId)).links).toEqual([link]);
  });
  it("rejects stale human confirmation when the confirmed tree changes", async () => {
    const { workspace, trash, link } = await fixture();
    const intent = await trash.prepareDelete("collection", link.collection_id);
    await workspace.createLink({ collection_id: link.collection_id, title: "Added later", url: "https://example.com/later", description: "", favicon_url: null });
    await expect(trash.deleteEntity("collection", link.collection_id, "extension", crypto.randomUUID(), intent.intentId)).rejects.toMatchObject({ code: "confirmation_required" });
    expect((await workspace.load()).links).toHaveLength(2);
  });

  it("does not restore foreign-owner or protected records from local storage", async () => {
    const { storage, trash, link } = await fixture();
    await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    const entry = (await trash.list())[0];
    entry.snapshot.links[0].user_id = "foreign-user";
    await storage.set({ "tabloom-trash-v1:local": [entry] });
    await expect(trash.restore(entry.id)).rejects.toThrow();
  });

  it("preserves protected siblings and rejects restore into a protected ancestor", async () => {
    const { storage, workspace, trash, link } = await fixture();
    const receipt = await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    const snapshot = await workspace.load();
    const protectedSpace = { ...snapshot.spaces[0], id: crypto.randomUUID(), origin: "browser-bookmark" as const, read_only: true, position: 9 };
    const protectedCollection = { ...snapshot.collections[0], id: crypto.randomUUID(), space_id: protectedSpace.id };
    await storage.set({ [LOCAL_WORKSPACE_KEY]: { version: 2, snapshot: { ...snapshot, spaces: [...snapshot.spaces, protectedSpace], collections: [...snapshot.collections, protectedCollection] }, bookmarkSources: [], cachedAt: new Date().toISOString() } });
    await expect(trash.restore(receipt.trashId, protectedCollection.id)).rejects.toMatchObject({ code: "destination_required" });
    const restored = await trash.restore(receipt.trashId);
    expect(restored.spaces.find((item) => item.id === protectedSpace.id)).toEqual(protectedSpace);
  });

  it("reconciles receipts without duplicates and accepts the original local receipt for Undo", async () => {
    const { trash, link } = await fixture();
    const local = await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    const remote = { ...local, trashId: crypto.randomUUID() };
    await trash.reconcileRemote(local.operationId, remote);
    await trash.reconcileRemote(local.operationId, remote);
    expect(await trash.list()).toEqual([expect.objectContaining({ id: remote.trashId, operationId: local.operationId })]);
    expect((await trash.restore(local.trashId)).links[0].id).toBe(link.id);
  });
  it("merges remote listing by operation ID even before its response receipt reconciles", async () => {
    const { storage, workspace, trash, link } = await fixture();
    await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    const local = (await trash.list())[0];
    const remoteEntry = { ...local, id: crypto.randomUUID() };
    const remote: WorkspaceTrashRepository = { list: async () => [remoteEntry], listForSync: async () => [remoteEntry], deleteEntity: vi.fn(), prepareDelete: vi.fn(), restore: vi.fn() };
    const repository = new LocalTrashRepository(storage, workspace, "local", { remote });
    const listed = await repository.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: remoteEntry.id, operationId: local.operationId, localId: local.localId });
  });

  it("requests a destination when a parent is deleted and rejects protected destinations", async () => {
    const { workspace, trash, link } = await fixture();
    const receipt = await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    const intent = await trash.prepareDelete("collection", link.collection_id);
    await trash.deleteEntity("collection", link.collection_id, "extension", crypto.randomUUID(), intent.intentId);
    await expect(trash.restore(receipt.trashId)).rejects.toMatchObject({ code: "destination_required", details: { destinationType: "collection" } });
    const target = await workspace.createCollection({ space_id: (await workspace.load()).spaces[0].id, name: "Target" });
    expect((await trash.restore(receipt.trashId, target.id)).links[0]).toMatchObject({ id: link.id, collection_id: target.id });
  });

  it("expires entries after 30 days and isolates storage scopes", async () => {
    const { storage, workspace, link } = await fixture();
    let now = Date.now();
    const trash = new LocalTrashRepository(storage, workspace, "local", { now: () => now });
    const receipt = await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    expect(await new LocalTrashRepository(storage, workspace, "other").list()).toEqual([]);
    now += 30 * 24 * 60 * 60 * 1000;
    expect(await trash.list()).toEqual([]);
    await expect(trash.restore(receipt.trashId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("commits Trash and the live tree atomically and leaves recovery available on failed restore storage", async () => {
    const { storage, workspace, trash, link } = await fixture();
    const writes = vi.spyOn(storage, "set");
    const receipt = await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockRejectedValueOnce(new Error("disk full"));
    await expect(trash.restore(receipt.trashId)).rejects.toThrow("disk full");
    expect((await trash.list())[0].id).toBe(receipt.trashId);
    expect((await workspace.load()).links).toEqual([]);
    expect((await trash.restore(receipt.trashId)).links[0].id).toBe(link.id);
  });

  it("caches remote MCP Trash for offline recovery and queues restore by its server receipt", async () => {
    const { storage, workspace, trash, link } = await fixture();
    await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    const remoteEntry = { ...(await trash.list())[0], id: crypto.randomUUID(), source: "mcp" as const };
    const userId = crypto.randomUUID();
    for (const item of remoteEntry.snapshot.links) item.user_id = userId;
    const snapshot = await workspace.load();
    for (const item of [...snapshot.spaces, ...snapshot.collections]) item.user_id = userId;
    const local = new LocalFirstStorage(storage, userId);
    await local.saveCanonical(snapshot, 1);
    const backed = await LocalFirstWorkspaceRepository.create({ userId, storage: local, onMutation: async () => { throw new Error("offline"); } });
    const remote: WorkspaceTrashRepository = { list: vi.fn(async () => [remoteEntry]), deleteEntity: vi.fn(), prepareDelete: vi.fn(), restore: vi.fn() };
    const repository = new LocalTrashRepository(storage, backed, userId, { remote });
    expect((await repository.list())[0]).toMatchObject({ id: remoteEntry.id, source: "mcp" });
    vi.mocked(remote.list).mockRejectedValue(new Error("offline"));
    expect((await repository.list())[0].id).toBe(remoteEntry.id);
    await expect(repository.restore(remoteEntry.id)).rejects.toThrow("offline");
    expect((await local.loadOrThrow()).queue[0].operation).toMatchObject({ action: "restore", payload: { trashId: remoteEntry.id } });
  });

  it("persists an explicit offline restore after its delete and retains the local tree", async () => {
    const { storage, workspace, link } = await fixture();
    const userId = crypto.randomUUID();
    const snapshot = await workspace.load();
    for (const item of [...snapshot.spaces, ...snapshot.collections, ...snapshot.links]) item.user_id = userId;
    const local = new LocalFirstStorage(storage, userId);
    await local.saveCanonical(snapshot, 1);
    const backed = await LocalFirstWorkspaceRepository.create({ userId, storage: local, onMutation: async () => { throw new Error("offline"); } });
    const trash = new LocalTrashRepository(storage, backed, userId);
    const operationId = crypto.randomUUID();
    await expect(trash.deleteEntity("link", link.id, "extension", operationId)).rejects.toThrow("offline");
    const entry = (await trash.list())[0];
    await expect(trash.restore(entry.id)).rejects.toThrow("offline");
    const persisted = await local.loadOrThrow();
    expect(persisted.snapshot.links[0].id).toBe(link.id);
    expect(persisted.queue.map(({ operation }) => operation.action)).toEqual(["delete", "restore"]);
    expect(persisted.queue[0].operation.operationId).toBe(operationId);
    expect(persisted.queue[1].operation.payload).toMatchObject({ deleteOperationId: operationId });
    expect((await trash.list())[0]).toMatchObject({ restorePending: true });
    await expect(trash.restore(entry.id)).rejects.toThrow("offline");
    expect((await local.loadOrThrow()).queue).toHaveLength(2);
    await trash.completeRestore(persisted.queue[1].operation.operationId);
    expect(await trash.list()).toEqual([]);
  });
  it("returns the canonical restored tree after a successful sync", async () => {
    const { storage, workspace } = await fixture();
    const userId = crypto.randomUUID();
    const initial = await workspace.load();
    for (const item of [...initial.spaces, ...initial.collections, ...initial.links]) item.user_id = userId;
    const state = new LocalFirstStorage(storage, userId);
    await state.saveCanonical(initial, 1);
    const repository = await LocalFirstWorkspaceRepository.create({ userId, storage: state, onMutation: async (operations) => {
      if (operations[0].action === "restore") await state.update(async (current) => [{ ...current, snapshot: { ...current.snapshot, links: current.snapshot.links.map((link) => ({ ...link, title: "Canonical restored title" })) } }, undefined]);
    } });
    const trash = new LocalTrashRepository(storage, repository, userId);
    const receipt = await trash.deleteEntity("link", initial.links[0].id, "extension", crypto.randomUUID());
    expect((await trash.restore(receipt.trashId)).links[0].title).toBe("Canonical restored title");
  });
  it("preserves the chosen destination and subsequent local edits while retrying a pending restore", async () => {
    const { storage, workspace, link } = await fixture();
    const userId = crypto.randomUUID();
    const initial = await workspace.load();
    for (const item of [...initial.spaces, ...initial.collections, ...initial.links]) item.user_id = userId;
    const target = { ...initial.collections[0], id: crypto.randomUUID(), name: "Target", position: 1 };
    initial.collections.push(target);
    const state = new LocalFirstStorage(storage, userId);
    await state.saveCanonical(initial, 1);
    const repository = await LocalFirstWorkspaceRepository.create({ userId, storage: state, onMutation: async () => { throw new Error("offline"); } });
    const trash = new LocalTrashRepository(storage, repository, userId);
    await expect(trash.deleteEntity("link", link.id, "extension", crypto.randomUUID())).rejects.toThrow();
    const entry = (await trash.list())[0];
    await expect(trash.restore(entry.id, target.id)).rejects.toThrow();
    await expect(repository.updateLink(link.id, { title: "Edited locally" })).rejects.toThrow();
    await expect(trash.restore(entry.id)).rejects.toThrow();
    expect((await state.loadOrThrow()).snapshot.links[0]).toMatchObject({ collection_id: target.id, title: "Edited locally" });
  });
});
