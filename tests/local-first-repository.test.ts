import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../shared/domain";
import { LocalFirstWorkspaceRepository } from "../extension/local-first-repository";
import { LocalFirstStorage, type StorageArea } from "../extension/local-first-storage";

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
  const onMutation = vi.fn();
  const repository = await LocalFirstWorkspaceRepository.create({ userId: USER_ID, storage, onMutation });
  return { area, storage, onMutation, repository };
}

describe("LocalFirstWorkspaceRepository", () => {
  it("creates a link locally and queues a sanitized durable operation", async () => {
    const { repository, storage, onMutation } = await setup();
    const created = await repository.createLink({ collection_id: COLLECTION_ID, url: "https://example.com", title: "Example", description: "", favicon_url: null });

    expect((await repository.load()).links).toContainEqual(created);
    expect(await storage.load()).toMatchObject({
      revision: 4,
      nextSequence: 2,
      outbox: [expect.objectContaining({ action: "create", entity: "link", entityId: created.id, baseRevision: 4 })],
    });
    expect((await storage.load())?.outbox[0].payload).not.toHaveProperty("user_id");
    expect(onMutation).toHaveBeenCalledOnce();
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
    expect(current.outbox).toEqual(expect.arrayContaining([
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
    expect(current.outbox.filter((item) => item.action === "create" && item.entity === "link")).toHaveLength(2);
    expect(current.nextSequence).toBe(3);
    expect(onMutation).toHaveBeenCalledOnce();
  });

  it("reads mutations made by another repository instance", async () => {
    const { repository, storage } = await setup();
    const second = await LocalFirstWorkspaceRepository.create({ userId: USER_ID, storage, onMutation: vi.fn() });
    await repository.updateSpace(SPACE_ID, { name: "Renamed" });
    expect((await second.load()).spaces[0].name).toBe("Renamed");
  });

  it("does not coalesce a newer mutation into an immutable in-flight operation", async () => {
    const { area } = memoryArea();
    const storage = new LocalFirstStorage(area, USER_ID);
    await storage.saveCanonical(snapshot(), 4);
    const immutable = new Set<string>();
    const repository = await LocalFirstWorkspaceRepository.create({
      userId: USER_ID,
      storage,
      onMutation: vi.fn(),
      immutableOperationIds: () => immutable,
    });
    await repository.updateSpace(SPACE_ID, { name: "First" });
    immutable.add((await storage.loadOrThrow()).outbox[0].operationId);

    await repository.updateSpace(SPACE_ID, { name: "Second" });

    const pending = (await storage.loadOrThrow()).outbox;
    expect(pending).toHaveLength(2);
    expect(pending.map((item) => item.payload)).toEqual([{ name: "First" }, { name: "Second" }]);
  });

  it("rejects unsupported URLs and read-only bookmark mutations before persistence", async () => {
    const { repository, storage, onMutation } = await setup();
    await expect(repository.createLink({ collection_id: COLLECTION_ID, url: "chrome://settings", title: "Settings", description: "", favicon_url: null })).rejects.toThrow(/http and https/i);

    await storage.update(async (current) => [{ ...current, snapshot: {
      ...current.snapshot,
      links: [{ id: "bookmark-link", user_id: USER_ID, collection_id: COLLECTION_ID, url: "https://bookmark.example", title: "Bookmark", description: "", favicon_url: null, position: 0, created_at: NOW, updated_at: NOW, origin: "browser-bookmark", read_only: true, device_label: null }],
    } }, undefined]);
    await expect(repository.deleteLink("bookmark-link")).rejects.toThrow(/read-only/i);
    expect((await storage.loadOrThrow()).outbox).toEqual([]);
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("does not publish a mutation when the atomic storage write fails", async () => {
    const { area } = memoryArea();
    const storage = new LocalFirstStorage(area, USER_ID);
    await storage.saveCanonical(snapshot(), 0);
    const onMutation = vi.fn();
    const repository = await LocalFirstWorkspaceRepository.create({ userId: USER_ID, storage, onMutation });
    vi.mocked(area.set).mockRejectedValueOnce(new Error("quota exceeded"));

    await expect(repository.updateSpace(SPACE_ID, { name: "Lost" })).rejects.toThrow("quota exceeded");
    expect(onMutation).not.toHaveBeenCalled();
  });
});
