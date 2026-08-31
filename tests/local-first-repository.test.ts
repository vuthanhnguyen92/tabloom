import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../shared/domain";
import { LocalFirstWorkspaceRepository } from "../extension/local-first-repository";
import { LocalFirstStorage, type StorageArea } from "../extension/local-first-storage";
import { WorkspaceWriteFailedError } from "../extension/workspace-sync-errors";
import type { WorkspaceOperation } from "../shared/workspace-operations";

const USER_ID = "00000000-0000-4000-8000-00000000000a";
const SPACE_ID = "10000000-0000-4000-8000-000000000001";
const COLLECTION_ID = "20000000-0000-4000-8000-000000000001";
const NOW = "2026-08-31T00:00:00.000Z";

function memoryArea() {
  const state: Record<string, unknown> = {};
  const area: StorageArea = {
    get: vi.fn(async (key: string) => ({ [key]: state[key] })),
    set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(state, value); }),
  };
  return { area, state };
}

function snapshot(): WorkspaceSnapshot {
  return {
    spaces: [{ id: SPACE_ID, user_id: USER_ID, name: "My Space", color: "#7357e6", position: 0, created_at: NOW, updated_at: NOW, origin: "saved", read_only: false }],
    collections: [{ id: COLLECTION_ID, user_id: USER_ID, space_id: SPACE_ID, name: "Reading", position: 0, created_at: NOW, updated_at: NOW, origin: "saved", read_only: false }],
    links: [],
  };
}

async function setup() {
  const { area } = memoryArea();
  const storage = new LocalFirstStorage(area, USER_ID);
  await storage.saveCanonical(snapshot(), 4);
  const onMutation = vi.fn(async () => undefined);
  const repository = await LocalFirstWorkspaceRepository.create({ userId: USER_ID, storage, onMutation });
  return { area, storage, onMutation, repository };
}

describe("LocalFirstWorkspaceRepository", () => {
  it("keeps the optimistic snapshot and queue when submission rejects", async () => {
    const { area } = memoryArea();
    const storage = new LocalFirstStorage(area, USER_ID);
    await storage.saveCanonical(snapshot(), 4);
    const onMutation = vi.fn(async (operations: WorkspaceOperation[]) => {
      expect((await storage.loadOrThrow()).snapshot.spaces[0].name).toBe("Research");
      expect(operations).toHaveLength(1);
      throw new WorkspaceWriteFailedError("Could not sync", operations[0].operationId);
    });
    const repository = await LocalFirstWorkspaceRepository.create({ userId: USER_ID, storage, onMutation });

    await expect(repository.updateSpace(SPACE_ID, { name: "Research" }))
      .rejects.toBeInstanceOf(WorkspaceWriteFailedError);

    const local = await storage.loadOrThrow();
    expect(local.snapshot.spaces[0].name).toBe("Research");
    expect(local.queue).toEqual([expect.objectContaining({ state: "waiting", operation: expect.objectContaining({ entityId: SPACE_ID }) })]);
  });

  it("creates a link locally and queues a sanitized durable operation", async () => {
    const { repository, storage, onMutation } = await setup();
    const created = await repository.createLink({ collection_id: COLLECTION_ID, url: "https://example.com", title: "Example", description: "", favicon_url: null });

    expect((await repository.load()).links).toContainEqual(created);
    expect(await storage.load()).toMatchObject({
      revision: 4,
      nextSequence: 2,
      queue: [expect.objectContaining({ state: "waiting", operation: expect.objectContaining({ action: "create", entity: "link", entityId: created.id, baseRevision: 4 }) })],
    });
    expect((await storage.load())?.queue[0].operation.payload).not.toHaveProperty("user_id");
    expect(onMutation).toHaveBeenCalledWith([expect.objectContaining({ entityId: created.id })]);
  });

  it("records update, reorder, move, and delete intent", async () => {
    const { repository, storage } = await setup();
    const second = await repository.createCollection({ space_id: SPACE_ID, name: "Later" });
    const link = await repository.createLink({ collection_id: COLLECTION_ID, url: "https://example.com", title: "Example", description: "", favicon_url: null });
    await repository.updateLink(link.id, { title: "Updated" });
    await repository.reorderLinks(second.id, [link.id]);
    await repository.deleteCollection(COLLECTION_ID);

    const current = await storage.loadOrThrow();
    expect(current.snapshot.links).toContainEqual(expect.objectContaining({ id: link.id, collection_id: second.id, title: "Updated" }));
    expect(current.queue.map((entry) => entry.operation)).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: "collection", entityId: second.id, action: "create" }),
      expect.objectContaining({ entity: "link", entityId: link.id, action: "create", payload: expect.objectContaining({ title: "Example" }) }),
      expect.objectContaining({ entity: "link", entityId: link.id, action: "update", payload: { title: "Updated" } }),
      expect.objectContaining({ entity: "link", entityId: second.id, action: "reorder", payload: { parentId: second.id, orderedIds: [link.id] } }),
      expect.objectContaining({ entity: "collection", entityId: COLLECTION_ID, action: "delete" }),
    ]));
  });

  it("creates one operation for each item in a multi-link capture", async () => {
    const { repository, storage, onMutation } = await setup();
    await repository.createLinks([
      { collection_id: COLLECTION_ID, url: "https://one.example", title: "One", description: "", favicon_url: null },
      { collection_id: COLLECTION_ID, url: "https://two.example", title: "Two", description: "", favicon_url: null },
    ]);
    const current = await storage.loadOrThrow();
    expect(current.snapshot.links).toHaveLength(2);
    expect(current.queue.filter((entry) => entry.operation.action === "create" && entry.operation.entity === "link")).toHaveLength(2);
    expect(current.nextSequence).toBe(3);
    expect(onMutation).toHaveBeenCalledWith([
      expect.objectContaining({ entity: "link", action: "create" }),
      expect.objectContaining({ entity: "link", action: "create" }),
    ]);
  });

  it("reads mutations made by another repository instance", async () => {
    const { repository, storage } = await setup();
    const second = await LocalFirstWorkspaceRepository.create({ userId: USER_ID, storage, onMutation: vi.fn(async () => undefined) });
    await repository.updateSpace(SPACE_ID, { name: "Renamed" });
    expect((await second.load()).spaces[0].name).toBe("Renamed");
  });

  it("does not coalesce a newer mutation into an immutable in-flight operation", async () => {
    const { area } = memoryArea();
    const storage = new LocalFirstStorage(area, USER_ID);
    await storage.saveCanonical(snapshot(), 4);
    const repository = await LocalFirstWorkspaceRepository.create({
      userId: USER_ID,
      storage,
      onMutation: vi.fn(async () => undefined),
    });
    await repository.updateSpace(SPACE_ID, { name: "First" });
    await storage.update(async (current) => [{
      ...current,
      queue: current.queue.map((entry) => ({ ...entry, attemptedAt: NOW })),
    }, undefined]);

    await repository.updateSpace(SPACE_ID, { name: "Second" });

    const pending = (await storage.loadOrThrow()).queue.map((entry) => entry.operation);
    expect(pending).toHaveLength(2);
    expect(pending.map((item) => item.payload)).toEqual([{ name: "First" }, { name: "Second" }]);
  });

  it("merges different fields from consecutive partial updates under the newer operation id", async () => {
    const { repository, storage } = await setup();
    const link = await repository.createLink({ collection_id: COLLECTION_ID, url: "https://example.com", title: "Example", description: "", favicon_url: null });
    await repository.updateLink(link.id, { title: "Renamed" });
    const firstUpdateId = (await storage.loadOrThrow()).queue.at(-1)!.operation.operationId;
    await repository.updateLink(link.id, { description: "Details" });

    const pending = (await storage.loadOrThrow()).queue.map((entry) => entry.operation);
    expect(pending).toHaveLength(2);
    expect(pending[1].operationId).not.toBe(firstUpdateId);
    expect(pending[1]).toMatchObject({ action: "update", payload: { title: "Renamed", description: "Details" } });
  });

  it("rejects unsupported URLs and read-only bookmark mutations before persistence", async () => {
    const { repository, storage, onMutation } = await setup();
    await expect(repository.createLink({ collection_id: COLLECTION_ID, url: "chrome://settings", title: "Settings", description: "", favicon_url: null })).rejects.toThrow(/http and https/i);

    await storage.update(async (current) => [{ ...current, snapshot: {
      ...current.snapshot,
      links: [{ id: "bookmark-link", user_id: USER_ID, collection_id: COLLECTION_ID, url: "https://bookmark.example", title: "Bookmark", description: "", favicon_url: null, position: 0, created_at: NOW, updated_at: NOW, origin: "browser-bookmark", read_only: true, device_label: null }],
    } }, undefined]);
    await expect(repository.deleteLink("bookmark-link")).rejects.toThrow(/read-only/i);
    expect((await storage.loadOrThrow()).queue).toEqual([]);
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("does not publish a mutation when the atomic storage write fails", async () => {
    const { area } = memoryArea();
    const storage = new LocalFirstStorage(area, USER_ID);
    await storage.saveCanonical(snapshot(), 0);
    const onMutation = vi.fn(async () => undefined);
    const repository = await LocalFirstWorkspaceRepository.create({ userId: USER_ID, storage, onMutation });
    vi.mocked(area.set).mockRejectedValueOnce(new Error("quota exceeded"));

    await expect(repository.updateSpace(SPACE_ID, { name: "Lost" })).rejects.toThrow("quota exceeded");
    expect(onMutation).not.toHaveBeenCalled();
  });
});
