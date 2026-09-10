import { describe, expect, it, vi } from "vitest";
import { LocalTrashRepository } from "../extension/local-trash-repository";
import { createLocalWorkspaceRepository } from "../extension/storage";
import { LocalFirstStorage } from "../extension/local-first-storage";
import { LocalFirstWorkspaceRepository } from "../extension/local-first-repository";
import type { StorageArea } from "../extension/workspace-cache";
import type { WorkspaceTrashRepository } from "../shared/trash-repository";
import { LOCAL_WORKSPACE_KEY } from "../extension/workspace-cache";
import { WorkspaceSyncCoordinator } from "../extension/workspace-sync-coordinator";
import { rebaseWorkspaceOperations, type WorkspaceOperation } from "../shared/workspace-operations";

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
  it("rejects a malformed owner before committing any deletion or Trash storage", async () => {
    const { storage, workspace, trash, link } = await fixture();
    const snapshot = await workspace.load();
    snapshot.links[0].user_id = crypto.randomUUID();
    await storage.set({ [LOCAL_WORKSPACE_KEY]: { version: 2, snapshot, bookmarkSources: [], cachedAt: new Date().toISOString() } });
    await expect(trash.deleteEntity("link", link.id, "extension", crypto.randomUUID())).rejects.toThrow("Invalid Trash owner");
    expect((await workspace.load()).links).toHaveLength(1);
    expect(await trash.list()).toEqual([]);
    snapshot.links[0].user_id = "local-user";
    await storage.set({ [LOCAL_WORKSPACE_KEY]: { version: 2, snapshot, bookmarkSources: [], cachedAt: new Date().toISOString() } });
    const receipt = await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    expect((await trash.list())[0].id).toBe(receipt.trashId);
    expect((await trash.restore(receipt.trashId)).links[0].id).toBe(link.id);
  });

  it.each(["local", "account"] as const)("really moves a restored collection to another space in %s mode", async (mode) => {
    const { storage, workspace, trash: localTrash, link } = await fixture();
    const target = await workspace.createSpace({ name: "Target space", color: "#7357e6" });
    const sibling = await workspace.createCollection({ space_id: (await workspace.load()).spaces[0].id, name: "Source sibling" });
    const targetSibling = await workspace.createCollection({ space_id: target.id, name: "Target sibling" });
    let repository = workspace, trash = localTrash;
    let state: LocalFirstStorage | undefined;
    if (mode === "account") {
      const userId = crypto.randomUUID(), initial = await workspace.load();
      for (const item of [...initial.spaces, ...initial.collections, ...initial.links]) item.user_id = userId;
      state = new LocalFirstStorage(storage, userId); await state.saveCanonical(initial, 1);
      repository = await LocalFirstWorkspaceRepository.create({ userId, storage: state, onMutation: async () => {} });
      trash = new LocalTrashRepository(storage, repository, userId);
    }
    const intent = await trash.prepareDelete("collection", link.collection_id);
    const receipt = await trash.deleteEntity("collection", link.collection_id, "extension", crypto.randomUUID(), intent.intentId);
    await trash.restore(receipt.trashId);
    if (state) {
      const restore = (await state.loadOrThrow()).queue.find((item) => item.operation.action === "restore")!;
      await state.update(async (current) => [{ ...current, queue: [] }, undefined]);
      await trash.completeRestore(restore.operation.operationId);
    }
    const moved = await trash.restore(receipt.trashId, target.id);
    expect(moved.collections.find((item) => item.id === link.collection_id)).toMatchObject({ space_id: target.id, position: 1 });
    expect(moved.collections.find((item) => item.id === sibling.id)?.position).toBe(0);
    expect(moved.collections.find((item) => item.id === targetSibling.id)?.position).toBe(0);
    expect(moved.links[0]).toMatchObject({ id: link.id, collection_id: link.collection_id, title: link.title });
    if (state) expect((await state.loadOrThrow()).queue[0].operation).toMatchObject({ action: "move", entity: "collection", entityId: link.collection_id, payload: { destinationSpaceId: target.id } });
    else expect((await (await createLocalWorkspaceRepository(storage)).load()).collections.find((item) => item.id === link.collection_id)?.space_id).toBe(target.id);
  });
  it.each(["source", "destination"])("rejects a collection move when its latest %s ancestry is read-only", async (protectedParent) => {
    const { storage, workspace, link } = await fixture();
    const target = await workspace.createSpace({ name: "Target", color: "#7357e6" });
    const initial = await workspace.load();
    const sourceId = initial.collections.find((item) => item.id === link.collection_id)!.space_id;
    initial.spaces = initial.spaces.map((item) => item.id === (protectedParent === "source" ? sourceId : target.id) ? { ...item, read_only: true } : item);
    await storage.set({ [LOCAL_WORKSPACE_KEY]: { version: 2, snapshot: initial, bookmarkSources: [], cachedAt: new Date().toISOString() } });
    await expect(workspace.moveCollection!({ id: link.collection_id, sourceSpaceId: sourceId, destinationSpaceId: target.id })).rejects.toThrow(/read-only/i);
    expect((await (await createLocalWorkspaceRepository(storage)).load()).collections[0].space_id).toBe(sourceId);
  });
  it("refreshes existing canonical alias deadlines together from remote listing", async () => {
    const { storage, workspace, trash, link } = await fixture();
    const receipt = await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    const first = (await trash.list())[0];
    const secondId = crypto.randomUUID();
    await trash.saveLocal({ ...first, localId: secondId, operationId: crypto.randomUUID() });
    const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const remote: WorkspaceTrashRepository = { list: async () => [{ ...first, expiresAt: deadline }], listForSync: async () => [{ ...first, expiresAt: deadline }], prepareDelete: vi.fn(), deleteEntity: vi.fn(), restore: vi.fn() };
    const refreshed = new LocalTrashRepository(storage, workspace, "local", { remote });
    expect(await refreshed.list()).toEqual([expect.objectContaining({ id: receipt.trashId, expiresAt: deadline })]);
    const expired = new LocalTrashRepository(storage, workspace, "local", { now: () => Date.parse(deadline) + 1 });
    expect(await expired.list()).toEqual([]);
    for (const id of [receipt.trashId, secondId]) await expect(expired.restore(id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("coalesces existing canonical receipt aliases and restores idempotently by either local Undo ID", async () => {
    const { storage, workspace, trash, link } = await fixture();
    const first = await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    const entry = (await trash.list())[0];
    const second = { ...entry, id: crypto.randomUUID(), operationId: crypto.randomUUID() };
    second.localId = second.id;
    await trash.saveLocal(second);
    const canonicalId = crypto.randomUUID();
    await trash.reconcileRemote(first.operationId, { ...first, trashId: canonicalId });
    await trash.reconcileRemote(second.operationId, { ...first, operationId: second.operationId, trashId: canonicalId });
    const reopened = new LocalTrashRepository(storage, workspace, "local");
    expect(await reopened.list()).toHaveLength(1);
    expect((await reopened.restore(first.trashId)).links[0].id).toBe(link.id);
    expect(await reopened.list()).toEqual([]);
    expect((await reopened.restore(second.localId)).links[0].id).toBe(link.id);
    for (const operationId of [first.operationId, second.operationId]) expect((await reopened.deleteEntity("link", link.id, "extension", operationId)).trashId).toBe(canonicalId);
    expect((await workspace.load()).links).toHaveLength(1);
    const expired = new LocalTrashRepository(storage, workspace, "local", { now: () => Date.parse(first.restoreUntil) + 1 });
    expect(await expired.list()).toEqual([]);
    for (const id of [canonicalId, first.trashId, second.localId]) await expect(expired.restore(id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("uses a new restore identity after a definitive destination rejection", async () => {
    const { storage, workspace, link } = await fixture();
    const userId = crypto.randomUUID();
    const initial = await workspace.load();
    for (const item of [...initial.spaces, ...initial.collections, ...initial.links]) item.user_id = userId;
    const target = { ...initial.collections[0], id: crypto.randomUUID(), name: "Target", position: 1 };
    initial.collections.push(target);
    const state = new LocalFirstStorage(storage, userId);
    await state.saveCanonical(initial, 1);
    const sent: WorkspaceOperation[] = [];
    let server = structuredClone(initial), revision = 1;
    const coordinator = new WorkspaceSyncCoordinator({ userId, storage: state, exclusiveRunner: { runExclusive: async (_user, task) => task() },
      transport: { getRevision: async () => ({ revision, serverTime: new Date().toISOString() }), loadCanonical: async () => ({ revision, snapshot: server, tombstones: [] }),
        applyOperations: async (operations) => {
          sent.push(...structuredClone(operations)); revision++;
          const rejected = operations.some((operation) => operation.action === "restore" && !operation.payload.destinationId);
          if (rejected) server = { ...server, collections: [target], links: [] };
          else server = rebaseWorkspaceOperations(server, [], operations, userId).snapshot;
          return { revision, outcomes: operations.map((operation) => ({ operationId: operation.operationId, status: rejected ? "rejected" as const : "applied" as const, ...(rejected ? { message: "destination_required" } : {}) })), patches: server,
            tombstones: rejected ? [{ entity: "collection" as const, entityId: link.collection_id, deletedRevision: revision, deletedAt: new Date().toISOString() }] : [], conflicts: [] };
        } }, onRestoreCommitted: async (operationId) => trash.completeRestore(operationId), onRestoreRejected: async (operationId) => trash.rejectRestore(operationId),
    });
    const repository = await LocalFirstWorkspaceRepository.create({ userId, storage: state, onMutation: async (operations) => { for (const operation of operations) await coordinator.submit(operation); } });
    const trash = new LocalTrashRepository(storage, repository, userId);
    const receipt = await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    await expect(trash.restore(receipt.trashId)).rejects.toMatchObject({ code: "destination_required" });
    const original = sent.at(-1)!;
    expect((await state.loadOrThrow()).queue).toEqual([]);
    await trash.restore(receipt.trashId, target.id);
    expect(sent.at(-1)).toMatchObject({ action: "restore", payload: { destinationId: target.id } });
    expect(sent.at(-1)!.operationId).not.toBe(original.operationId);
    expect((await repository.load()).links[0].collection_id).toBe(target.id);
    expect(await trash.list()).toEqual([]);
  });
  it("resolves a lost restore response before a destination change gets a new operation identity", async () => {
    const { storage, workspace, link } = await fixture();
    const userId = crypto.randomUUID();
    const initial = await workspace.load();
    for (const item of [...initial.spaces, ...initial.collections, ...initial.links]) item.user_id = userId;
    const target = { ...initial.collections[0], id: crypto.randomUUID(), name: "Target", position: 1 };
    initial.collections.push(target);
    const state = new LocalFirstStorage(storage, userId);
    await state.saveCanonical(initial, 1);
    let server = structuredClone(initial), revision = 1, lost = true;
    const applied = new Set<string>();
    const sent: WorkspaceOperation[] = [];
    const coordinator = new WorkspaceSyncCoordinator({ userId, storage: state, exclusiveRunner: { runExclusive: async (_user, task) => task() },
      transport: { getRevision: async () => ({ revision, serverTime: new Date().toISOString() }), loadCanonical: async () => ({ revision, snapshot: server, tombstones: [] }),
        applyOperations: async (operations) => {
          sent.push(...structuredClone(operations));
          const outcomes = operations.map((operation) => {
            const status = applied.has(operation.operationId) ? "already_applied" as const : "applied" as const;
            if (status === "applied") { server = rebaseWorkspaceOperations(server, [], [operation], userId).snapshot; revision++; applied.add(operation.operationId); }
            return { operationId: operation.operationId, status };
          });
          if (lost && operations.some((operation) => operation.action === "restore")) { lost = false; throw new Error("response lost"); }
          return { revision, outcomes, patches: server, tombstones: [], conflicts: [] };
        } }, onRestoreCommitted: async (operationId) => trash.completeRestore(operationId),
    });
    const repository = await LocalFirstWorkspaceRepository.create({ userId, storage: state, onMutation: async (operations) => { for (const operation of operations) await coordinator.submit(operation); } });
    const trash = new LocalTrashRepository(storage, repository, userId);
    const receipt = await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    await expect(trash.restore(receipt.trashId)).rejects.toThrow("response lost");
    const original = (await state.loadOrThrow()).queue[0].operation;
    await trash.restore(receipt.trashId, target.id);
    expect(sent.filter((operation) => operation.action === "restore")).toEqual([original, original]);
    expect(sent.at(-1)).toMatchObject({ action: "update", payload: { collection_id: target.id } });
    expect(sent.at(-1)!.operationId).not.toBe(original.operationId);
    expect((await repository.load()).links[0].collection_id).toBe(target.id);
    expect((await state.loadOrThrow()).queue).toEqual([]);
    // A stale dialog can choose again after canonical completion. This must
    // also be a fresh move, never a no-op hidden behind restore idempotency.
    await trash.restore(receipt.trashId, link.collection_id);
    expect((await repository.load()).links[0].collection_id).toBe(link.collection_id);
  });
  it("invalidates every old confirmation after delete and identical restore, including another repository", async () => {
    const { storage, workspace, trash, link } = await fixture();
    const other = new LocalTrashRepository(storage, workspace, "local");
    const first = await trash.prepareDelete("collection", link.collection_id);
    const stale = await other.prepareDelete("collection", link.collection_id);
    const parent = await other.prepareDelete("space", (await workspace.load()).spaces[0].id);
    const receipt = await trash.deleteEntity("collection", link.collection_id, "extension", crypto.randomUUID(), first.intentId);
    await trash.restore(receipt.trashId);
    for (const [repository, intent] of [[trash, first], [other, stale], [other, parent]] as const) {
      await expect(repository.deleteEntity(intent.targetType, intent.targetId, "extension", crypto.randomUUID(), intent.intentId)).rejects.toMatchObject({ code: "confirmation_required" });
    }
    const fresh = await other.prepareDelete("collection", link.collection_id);
    await expect(other.deleteEntity("collection", link.collection_id, "extension", crypto.randomUUID(), fresh.intentId)).resolves.toBeDefined();
  });

  it("does not resurrect children removed after a pending container restore", async () => {
    const { storage, workspace, link } = await fixture();
    const userId = crypto.randomUUID();
    const initial = await workspace.load();
    for (const item of [...initial.spaces, ...initial.collections, ...initial.links]) item.user_id = userId;
    const moved = { ...initial.links[0], id: crypto.randomUUID(), title: "Move me" };
    const target = { ...initial.collections[0], id: crypto.randomUUID(), name: "Elsewhere", position: 1 };
    initial.links.push(moved);
    initial.collections.push(target);
    const state = new LocalFirstStorage(storage, userId);
    await state.saveCanonical(initial, 1);
    const repository = await LocalFirstWorkspaceRepository.create({ userId, storage: state, onMutation: async () => { throw new Error("offline"); } });
    const trash = new LocalTrashRepository(storage, repository, userId);
    const intent = await trash.prepareDelete("collection", link.collection_id);
    await expect(trash.deleteEntity("collection", link.collection_id, "extension", crypto.randomUUID(), intent.intentId)).rejects.toThrow();
    const entry = (await trash.list())[0];
    await expect(trash.restore(entry.id)).rejects.toThrow();
    await expect(trash.deleteEntity("link", link.id, "extension", crypto.randomUUID())).rejects.toThrow();
    await expect(repository.updateLink(moved.id, { collection_id: target.id, title: "Edited after moving" })).rejects.toThrow();
    await expect(trash.restore(entry.id)).rejects.toThrow();
    expect((await repository.load()).links).toEqual([expect.objectContaining({ id: moved.id, collection_id: target.id, title: "Edited after moving" })]);
  });

  it("keeps an attempted restore byte-identical until its original outcome is resolved", async () => {
    const { storage, workspace, link } = await fixture();
    const userId = crypto.randomUUID();
    const initial = await workspace.load();
    for (const item of [...initial.spaces, ...initial.collections, ...initial.links]) item.user_id = userId;
    const target = { ...initial.collections[0], id: crypto.randomUUID(), name: "Target", position: 1 };
    initial.collections.push(target);
    const state = new LocalFirstStorage(storage, userId);
    await state.saveCanonical(initial, 1);
    const onMutation = vi.fn(async () => { throw new Error("response lost"); });
    const repository = await LocalFirstWorkspaceRepository.create({ userId, storage: state, onMutation });
    const trash = new LocalTrashRepository(storage, repository, userId);
    await expect(trash.deleteEntity("link", link.id, "extension", crypto.randomUUID())).rejects.toThrow();
    const entry = (await trash.list())[0];
    await expect(trash.restore(entry.id)).rejects.toThrow();
    await state.update(async (current) => [{ ...current, queue: current.queue.map((item) => item.operation.action === "restore" ? { ...item, attemptedAt: "2026-09-10T01:00:00.000Z", state: "failed" as const, error: "response lost" } : item) }, undefined]);
    const original = (await state.loadOrThrow()).queue[1];
    // Receipt callbacks can persist before queue acknowledgement storage fails.
    await trash.rejectRestore(original.operation.operationId);
    await expect(trash.restore(entry.id, target.id)).rejects.toThrow();
    expect(onMutation).toHaveBeenLastCalledWith([original.operation]);
    expect(onMutation).toHaveBeenCalledTimes(3);
    const retried = (await state.loadOrThrow()).queue[1];
    expect(retried.operation).toEqual(original.operation);
    expect(retried.attemptedAt).toBe(original.attemptedAt);
    expect((await repository.load()).links[0].collection_id).toBe(link.collection_id);
  });
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
  it("discards the exact local Trash receipt after its delete is definitively rejected", async () => {
    const { trash, link } = await fixture();
    const rejected = await trash.deleteEntity("link", link.id, "extension", crypto.randomUUID());
    await trash.discardRejectedDelete(rejected.operationId);
    expect(await trash.list()).toEqual([]);
    await expect(trash.restore(rejected.trashId)).rejects.toMatchObject({ code: "not_found" });
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
