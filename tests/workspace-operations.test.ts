import { describe, expect, it } from "vitest";
import type { Collection, SavedLink, Space, WorkspaceSnapshot } from "../shared/domain";
import {
  applyWorkspacePatch,
  coalesceWorkspaceOperations,
  isWorkspaceOperation,
  rebaseWorkspaceOperations,
  replaceSavedWorkspace,
  type WorkspaceOperation,
  type WorkspaceTombstone,
} from "../shared/workspace-operations";

const USER_ID = "00000000-0000-4000-8000-00000000000a";
const DEVICE_ID = "00000000-0000-4000-8000-00000000000d";
const SPACE_ID = "10000000-0000-4000-8000-000000000001";
const COLLECTION_ID = "20000000-0000-4000-8000-000000000001";
const LINK_ID = "30000000-0000-4000-8000-000000000001";
const NOW = "2026-08-31T00:00:00.000Z";

function savedMeta() {
  return { user_id: USER_ID, created_at: NOW, updated_at: NOW, origin: "saved" as const, read_only: false };
}

function workspace(): WorkspaceSnapshot {
  const space: Space = { ...savedMeta(), id: SPACE_ID, name: "My Space", color: "#7357e6", position: 0 };
  const collection: Collection = { ...savedMeta(), id: COLLECTION_ID, space_id: SPACE_ID, name: "Reading", position: 0 };
  const link: SavedLink = { ...savedMeta(), id: LINK_ID, collection_id: COLLECTION_ID, url: "https://example.com/", title: "Example", description: "", favicon_url: null, position: 0, device_label: null };
  return { spaces: [space], collections: [collection], links: [link] };
}

function operation(overrides: Partial<WorkspaceOperation> = {}): WorkspaceOperation {
  return {
    operationId: "40000000-0000-4000-8000-000000000001",
    deviceId: DEVICE_ID,
    sequence: 1,
    entity: "link",
    entityId: LINK_ID,
    action: "update",
    payload: { title: "Updated" },
    createdAt: NOW,
    baseRevision: 4,
    ...overrides,
  } as WorkspaceOperation;
}

describe("workspace operations", () => {
  it("validates and rebases an explicit collection move without recreating its content", () => {
    const initial = workspace();
    const target = { ...initial.spaces[0], id: crypto.randomUUID(), name: "Target", position: 1 };
    initial.spaces.push(target);
    const move = operation({ action: "move", entity: "collection", entityId: COLLECTION_ID, payload: { sourceSpaceId: SPACE_ID, destinationSpaceId: target.id } });
    expect(isWorkspaceOperation(move)).toBe(true);
    const result = rebaseWorkspaceOperations(initial, [], [move], USER_ID);
    expect(result.snapshot.collections[0]).toMatchObject({ id: COLLECTION_ID, space_id: target.id, name: "Reading" });
    expect(result.snapshot.links).toEqual(initial.links);
    expect(isWorkspaceOperation({ ...move, payload: { ...move.payload, destinationSpaceId: SPACE_ID } })).toBe(false);
  });
  it("retains an absent delete receipt dependency before offline Undo and later edits", () => {
    const tree = workspace();
    const deletion = operation({ action: "delete", payload: {} });
    const restoration = operation({ operationId: crypto.randomUUID(), sequence: 2, action: "restore", payload: { deleteOperationId: deletion.operationId, snapshot: { spaces: [], collections: [], links: tree.links } } });
    const later = operation({ operationId: crypto.randomUUID(), sequence: 3, payload: { title: "Later" } });
    const result = rebaseWorkspaceOperations({ ...tree, links: [] }, [{ entity: "link", entityId: LINK_ID, deletedRevision: 5, deletedAt: NOW }], [deletion, restoration, later], USER_ID);
    expect(result.pending).toEqual([deletion, restoration, later]);
    expect(result.snapshot.links[0].title).toBe("Later");
  });
  it("retains explicit restore intents through tombstones without treating their snapshots as creates", () => {
    const tree = workspace();
    const restore = operation({ action: "restore", payload: { deleteOperationId: "50000000-0000-4000-8000-000000000001", snapshot: { spaces: [], collections: [], links: tree.links } } });
    expect(isWorkspaceOperation(restore)).toBe(true);
    const result = rebaseWorkspaceOperations({ ...tree, links: [] }, [{ entity: "link", entityId: LINK_ID, deletedRevision: 5, deletedAt: NOW }], [restore], USER_ID);
    expect(result.pending).toEqual([restore]);
    expect(result.snapshot.links).toEqual(tree.links);
    expect(result.rejected).toEqual([]);
    expect(isWorkspaceOperation({ ...restore, payload: { ...restore.payload, deleteOperationId: "invalid" } })).toBe(false);
    const edit = operation({ operationId: crypto.randomUUID(), sequence: 2, payload: { title: "Edited after restore" } });
    const edited = rebaseWorkspaceOperations({ ...tree, links: [] }, [{ entity: "link", entityId: LINK_ID, deletedRevision: 5, deletedAt: NOW }], [restore, edit], USER_ID);
    expect(edited.snapshot.links[0].title).toBe("Edited after restore");
    expect(edited.pending).toHaveLength(2);
    const missingParent = rebaseWorkspaceOperations({ ...tree, links: [], collections: [] }, [], [restore], USER_ID);
    expect(missingParent.pending).toEqual([restore]);
    expect(missingParent.snapshot.links).toEqual([]);
  });
  it("keeps create and update as separate identities so cross-page acknowledgements cannot erase the update", () => {
    const create = operation({
      action: "create",
      payload: {
        id: LINK_ID,
        collection_id: COLLECTION_ID,
        url: "https://example.com/",
        title: "Example",
        description: "",
        favicon_url: null,
        position: 0,
        created_at: NOW,
        updated_at: NOW,
      },
    });
    const update = operation({
      operationId: "40000000-0000-4000-8000-000000000002",
      sequence: 2,
      action: "update",
      payload: { title: "Final" },
    });

    const result = coalesceWorkspaceOperations([create], update);

    expect(result).toEqual([create, update]);
  });

  it("keeps create and delete so another page cannot cancel an in-flight create", () => {
    const create = operation({ action: "create", payload: {
      id: LINK_ID, collection_id: COLLECTION_ID, url: "https://example.com/", title: "Example", description: "", favicon_url: null, position: 0, created_at: NOW, updated_at: NOW,
    } });
    const remove = operation({ operationId: "40000000-0000-4000-8000-000000000002", sequence: 2, action: "delete", payload: {} });
    expect(coalesceWorkspaceOperations([create], remove)).toEqual([create, remove]);
  });

  it("strictly validates persisted operation payloads", () => {
    const valid = operation();
    expect(isWorkspaceOperation(valid)).toBe(true);
    expect(isWorkspaceOperation({ ...valid, createdAt: "not-a-date" })).toBe(false);
    expect(isWorkspaceOperation({ ...valid, payload: { title: 42 } })).toBe(false);
    expect(isWorkspaceOperation({ ...valid, payload: { title: "Updated", provider_token: "secret" } })).toBe(false);
    expect(isWorkspaceOperation({ ...valid, payload: { url: "chrome://settings" } })).toBe(false);
    expect(isWorkspaceOperation({ ...valid, entity: "space", payload: { title: "Wrong entity" } })).toBe(false);
    expect(isWorkspaceOperation({ ...valid, payload: { title: undefined } })).toBe(false);
    expect(isWorkspaceOperation({ ...valid, provider_token: "secret" })).toBe(false);
  });

  it("replaces only unsent updates and reorders", () => {
    const firstUpdate = operation();
    const secondUpdate = operation({ operationId: "40000000-0000-4000-8000-000000000002", sequence: 2, payload: { description: "Later" } });
    expect(coalesceWorkspaceOperations([firstUpdate], secondUpdate)).toEqual([{ ...secondUpdate, payload: { title: "Updated", description: "Later" } }]);
    expect(coalesceWorkspaceOperations([firstUpdate], secondUpdate, new Set([firstUpdate.operationId]))).toEqual([firstUpdate, secondUpdate]);

    const firstReorder = operation({ entityId: COLLECTION_ID, action: "reorder", payload: { parentId: COLLECTION_ID, orderedIds: [LINK_ID] } });
    const secondReorder = operation({ operationId: "40000000-0000-4000-8000-000000000003", sequence: 3, entityId: COLLECTION_ID, action: "reorder", payload: { parentId: COLLECTION_ID, orderedIds: ["other", LINK_ID] } });
    expect(coalesceWorkspaceOperations([firstReorder], secondReorder)).toEqual([secondReorder]);
  });

  it("applies canonical patches and tombstones while normalizing positions", () => {
    const snapshot = workspace();
    snapshot.links.push({ ...snapshot.links[0], id: "30000000-0000-4000-8000-000000000002", title: "Delete me", position: 3 });
    const patched = applyWorkspacePatch(snapshot, {
      spaces: [],
      collections: [],
      links: [{ ...snapshot.links[0], title: "Canonical", position: 8 }],
      tombstones: [{ entity: "link", entityId: "30000000-0000-4000-8000-000000000002", deletedRevision: 5, deletedAt: NOW }],
    });
    expect(patched.links).toEqual([expect.objectContaining({ id: LINK_ID, title: "Canonical", position: 0 })]);
  });

  it("replaces saved records without removing browser bookmark records", () => {
    const cached = workspace();
    cached.spaces.push({ ...cached.spaces[0], id: "browser-space", origin: "browser-bookmark", read_only: true, name: "Browser bookmarks" });
    cached.collections.push({ ...cached.collections[0], id: "browser-collection", space_id: "browser-space", origin: "browser-bookmark", read_only: true });
    cached.links.push({ ...cached.links[0], id: "browser-link", collection_id: "browser-collection", origin: "browser-bookmark", read_only: true });
    const canonical = workspace();
    canonical.links[0] = { ...canonical.links[0], title: "Remote" };

    const replaced = replaceSavedWorkspace(cached, canonical);

    expect(replaced.links).toContainEqual(expect.objectContaining({ id: LINK_ID, title: "Remote" }));
    expect(replaced.links).toContainEqual(expect.objectContaining({ id: "browser-link", origin: "browser-bookmark" }));
  });

  it("rebases surviving offline operations and rejects tombstoned targets", () => {
    const canonical = workspace();
    const offlineCreate = operation({
      operationId: "40000000-0000-4000-8000-000000000004",
      sequence: 4,
      entityId: "30000000-0000-4000-8000-000000000004",
      action: "create",
      payload: {
        id: "30000000-0000-4000-8000-000000000004",
        collection_id: COLLECTION_ID,
        url: "https://offline.example/",
        title: "Offline link",
        description: "",
        favicon_url: null,
        position: 1,
        created_at: NOW,
        updated_at: NOW,
      },
    });
    const staleUpdate = operation({ operationId: "40000000-0000-4000-8000-000000000005", sequence: 5 });
    const tombstones: WorkspaceTombstone[] = [{ entity: "link", entityId: LINK_ID, deletedRevision: 6, deletedAt: NOW }];

    const result = rebaseWorkspaceOperations(canonical, tombstones, [offlineCreate, staleUpdate], USER_ID);

    expect(result.snapshot.links).toContainEqual(expect.objectContaining({ id: offlineCreate.entityId, user_id: USER_ID, title: "Offline link" }));
    expect(result.pending).toEqual([offlineCreate]);
    expect(result.rejected).toEqual([{ operationId: staleUpdate.operationId, code: "deleted" }]);
  });

  it("rejects a child create whose parent was deleted", () => {
    const create = operation({
      operationId: "40000000-0000-4000-8000-000000000006",
      entityId: "30000000-0000-4000-8000-000000000006",
      action: "create",
      payload: { id: "30000000-0000-4000-8000-000000000006", collection_id: COLLECTION_ID, url: "https://orphan.example/", title: "Orphan", description: "", favicon_url: null, position: 0, created_at: NOW, updated_at: NOW },
    });
    const canonical: WorkspaceSnapshot = { spaces: workspace().spaces, collections: [], links: [] };
    const tombstones: WorkspaceTombstone[] = [{ entity: "collection", entityId: COLLECTION_ID, deletedRevision: 8, deletedAt: NOW }];

    const result = rebaseWorkspaceOperations(canonical, tombstones, [create], USER_ID);

    expect(result.pending).toEqual([]);
    expect(result.rejected).toEqual([{ operationId: create.operationId, code: "deleted_parent" }]);
  });

  it("completes a stale delete when the canonical entity is already absent", () => {
    const canonical: WorkspaceSnapshot = { spaces: workspace().spaces, collections: [], links: [] };
    const remove = operation({
      entity: "collection",
      entityId: COLLECTION_ID,
      action: "delete",
      payload: {},
    });
    const rename = operation({
      operationId: "40000000-0000-4000-8000-000000000002",
      sequence: 2,
      entity: "space",
      entityId: SPACE_ID,
      action: "update",
      payload: { name: "Still pending" },
    });

    const result = rebaseWorkspaceOperations(canonical, [], [remove, rename], USER_ID);

    expect(result.pending).toEqual([rename]);
    expect(result.rejected).toEqual([]);
    expect(result.snapshot.spaces[0].name).toBe("Still pending");
  });
});
