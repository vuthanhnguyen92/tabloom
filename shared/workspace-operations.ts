import { normalizePositions, type Collection, type SavedLink, type Space, type WorkspaceSnapshot } from "./domain";

export type WorkspaceEntity = "space" | "collection" | "link";

type OperationMeta<E extends WorkspaceEntity = WorkspaceEntity> = {
  operationId: string;
  deviceId: string;
  sequence: number;
  entity: E;
  entityId: string;
  createdAt: string;
  baseRevision: number;
};

export type SpaceCreatePayload = Pick<Space, "id" | "name" | "color" | "position" | "created_at" | "updated_at">;
export type CollectionCreatePayload = Pick<Collection, "id" | "space_id" | "name" | "position" | "created_at" | "updated_at">;
export type LinkCreatePayload = Pick<SavedLink, "id" | "collection_id" | "url" | "title" | "description" | "favicon_url" | "position" | "created_at" | "updated_at">;

export type WorkspaceCreateOperation =
  | (OperationMeta<"space"> & { action: "create"; payload: SpaceCreatePayload })
  | (OperationMeta<"collection"> & { action: "create"; payload: CollectionCreatePayload })
  | (OperationMeta<"link"> & { action: "create"; payload: LinkCreatePayload });

export type WorkspaceUpdateOperation =
  | (OperationMeta<"space"> & { action: "update"; payload: Partial<Pick<Space, "name" | "color">> })
  | (OperationMeta<"collection"> & { action: "update"; payload: Partial<Pick<Collection, "name">> })
  | (OperationMeta<"link"> & { action: "update"; payload: Partial<Pick<SavedLink, "collection_id" | "url" | "title" | "description" | "favicon_url">> });

export type WorkspaceDeleteOperation = OperationMeta & {
  action: "delete";
  payload: Record<string, never>;
};

export type WorkspaceReorderOperation = OperationMeta<"collection" | "link"> & {
  action: "reorder";
  payload: { parentId: string; orderedIds: string[] };
};

export type WorkspaceOperation = WorkspaceCreateOperation | WorkspaceUpdateOperation | WorkspaceDeleteOperation | WorkspaceReorderOperation;

export type WorkspaceTombstone = {
  entity: WorkspaceEntity;
  entityId: string;
  deletedRevision: number;
  deletedAt: string;
};

export type WorkspacePatchSet = {
  spaces: Space[];
  collections: Collection[];
  links: SavedLink[];
  tombstones: WorkspaceTombstone[];
};

export type WorkspaceRebaseResult = {
  snapshot: WorkspaceSnapshot;
  pending: WorkspaceOperation[];
  rejected: Array<{ operationId: string; code: "deleted" | "deleted_parent" }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isWorkspaceOperation(value: unknown): value is WorkspaceOperation {
  if (!isRecord(value) || !UUID_PATTERN.test(String(value.operationId)) || !UUID_PATTERN.test(String(value.deviceId))) return false;
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) return false;
  if (!Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 0) return false;
  if (!["space", "collection", "link"].includes(String(value.entity)) || !UUID_PATTERN.test(String(value.entityId))) return false;
  if (!["create", "update", "delete", "reorder"].includes(String(value.action)) || typeof value.createdAt !== "string" || !isRecord(value.payload)) return false;
  if ("user_id" in value.payload || "access_token" in value.payload || "refresh_token" in value.payload) return false;
  if (value.action === "delete") return Object.keys(value.payload).length === 0;
  if (value.action === "reorder") {
    return ["collection", "link"].includes(String(value.entity))
      && UUID_PATTERN.test(String(value.payload.parentId))
      && Array.isArray(value.payload.orderedIds)
      && value.payload.orderedIds.every((id) => typeof id === "string" && UUID_PATTERN.test(id));
  }
  if (value.action === "create") return value.payload.id === value.entityId;
  return true;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function operationKey(operation: WorkspaceOperation): string {
  return operation.action === "reorder"
    ? `${operation.entity}:reorder:${operation.payload.parentId}`
    : `${operation.entity}:${operation.entityId}`;
}

export function coalesceWorkspaceOperations(
  existing: WorkspaceOperation[],
  incoming: WorkspaceOperation,
  immutableOperationIds: ReadonlySet<string> = new Set(),
): WorkspaceOperation[] {
  const key = operationKey(incoming);
  const index = existing.findLastIndex((candidate) => (
    !immutableOperationIds.has(candidate.operationId)
    && operationKey(candidate) === key
  ));
  if (index < 0) return [...existing, incoming];

  const previous = existing[index];
  if (previous.action === "create" && incoming.action === "update") {
    const merged = {
      ...previous,
      payload: { ...previous.payload, ...incoming.payload, id: previous.entityId },
    } as WorkspaceOperation;
    return existing.map((candidate, candidateIndex) => candidateIndex === index ? merged : candidate);
  }
  if (previous.action === "create" && incoming.action === "delete") {
    return existing.filter((_, candidateIndex) => candidateIndex !== index);
  }
  if (
    (previous.action === "update" && incoming.action === "update")
    || (previous.action === "reorder" && incoming.action === "reorder")
    || (previous.action === "update" && incoming.action === "delete")
    || (previous.action === "delete" && incoming.action === "delete")
  ) {
    return existing.map((candidate, candidateIndex) => candidateIndex === index ? incoming : candidate);
  }
  return [...existing, incoming];
}

function upsert<T extends { id: string }>(items: T[], patches: T[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const patch of patches) byId.set(patch.id, clone(patch));
  return [...byId.values()];
}

function normalizeSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const spaces = normalizePositions(snapshot.spaces);
  const collections = snapshot.collections.map((item) => ({ ...item }));
  for (const space of spaces) {
    const normalized = normalizePositions(collections.filter((item) => item.space_id === space.id));
    const positions = new Map(normalized.map((item) => [item.id, item.position]));
    for (const collection of collections) if (positions.has(collection.id)) collection.position = positions.get(collection.id)!;
  }
  const links = snapshot.links.map((item) => ({ ...item }));
  for (const collection of collections) {
    const normalized = normalizePositions(links.filter((item) => item.collection_id === collection.id));
    const positions = new Map(normalized.map((item) => [item.id, item.position]));
    for (const link of links) if (positions.has(link.id)) link.position = positions.get(link.id)!;
  }
  return { spaces, collections, links };
}

export function applyWorkspacePatch(cached: WorkspaceSnapshot, patch: WorkspacePatchSet): WorkspaceSnapshot {
  const next = clone(cached);
  for (const tombstone of patch.tombstones) {
    if (tombstone.entity === "space") {
      const collectionIds = new Set(next.collections.filter((item) => item.space_id === tombstone.entityId).map((item) => item.id));
      next.spaces = next.spaces.filter((item) => item.id !== tombstone.entityId);
      next.collections = next.collections.filter((item) => !collectionIds.has(item.id));
      next.links = next.links.filter((item) => !collectionIds.has(item.collection_id));
    } else if (tombstone.entity === "collection") {
      next.collections = next.collections.filter((item) => item.id !== tombstone.entityId);
      next.links = next.links.filter((item) => item.collection_id !== tombstone.entityId);
    } else {
      next.links = next.links.filter((item) => item.id !== tombstone.entityId);
    }
  }
  next.spaces = upsert(next.spaces, patch.spaces);
  next.collections = upsert(next.collections, patch.collections);
  next.links = upsert(next.links, patch.links);
  return normalizeSnapshot(next);
}

export function replaceSavedWorkspace(cached: WorkspaceSnapshot, canonicalSaved: WorkspaceSnapshot): WorkspaceSnapshot {
  return normalizeSnapshot({
    spaces: [...canonicalSaved.spaces.filter((item) => item.origin === "saved"), ...cached.spaces.filter((item) => item.origin === "browser-bookmark")],
    collections: [...canonicalSaved.collections.filter((item) => item.origin === "saved"), ...cached.collections.filter((item) => item.origin === "browser-bookmark")],
    links: [...canonicalSaved.links.filter((item) => item.origin === "saved"), ...cached.links.filter((item) => item.origin === "browser-bookmark")],
  });
}

function isTombstoned(tombstones: WorkspaceTombstone[], entity: WorkspaceEntity, entityId: string): boolean {
  return tombstones.some((item) => item.entity === entity && item.entityId === entityId);
}

function parentDeleted(snapshot: WorkspaceSnapshot, tombstones: WorkspaceTombstone[], operation: WorkspaceOperation): boolean {
  if (operation.entity === "collection" && operation.action === "create") {
    return isTombstoned(tombstones, "space", operation.payload.space_id)
      || !snapshot.spaces.some((item) => item.id === operation.payload.space_id);
  }
  if (operation.entity === "link" && operation.action === "create") {
    return isTombstoned(tombstones, "collection", operation.payload.collection_id)
      || !snapshot.collections.some((item) => item.id === operation.payload.collection_id);
  }
  if (operation.action === "reorder") {
    const parentEntity: WorkspaceEntity = operation.entity === "collection" ? "space" : "collection";
    const parentExists = operation.entity === "collection"
      ? snapshot.spaces.some((item) => item.id === operation.payload.parentId)
      : snapshot.collections.some((item) => item.id === operation.payload.parentId);
    return isTombstoned(tombstones, parentEntity, operation.payload.parentId) || !parentExists;
  }
  return false;
}

function applyOperation(snapshot: WorkspaceSnapshot, operation: WorkspaceOperation, userId: string): WorkspaceSnapshot {
  const next = clone(snapshot);
  if (operation.action === "create") {
    if (operation.entity === "space") next.spaces = upsert(next.spaces, [{ ...operation.payload, user_id: userId, origin: "saved", read_only: false }]);
    if (operation.entity === "collection") next.collections = upsert(next.collections, [{ ...operation.payload, user_id: userId, origin: "saved", read_only: false }]);
    if (operation.entity === "link") next.links = upsert(next.links, [{ ...operation.payload, user_id: userId, origin: "saved", read_only: false, device_label: null }]);
  } else if (operation.action === "update") {
    if (operation.entity === "space") next.spaces = next.spaces.map((item) => item.id === operation.entityId ? { ...item, ...operation.payload } : item);
    if (operation.entity === "collection") next.collections = next.collections.map((item) => item.id === operation.entityId ? { ...item, ...operation.payload } : item);
    if (operation.entity === "link") next.links = next.links.map((item) => item.id === operation.entityId ? { ...item, ...operation.payload } : item);
  } else if (operation.action === "delete") {
    if (operation.entity === "space") {
      const collectionIds = new Set(next.collections.filter((item) => item.space_id === operation.entityId).map((item) => item.id));
      next.spaces = next.spaces.filter((item) => item.id !== operation.entityId);
      next.collections = next.collections.filter((item) => !collectionIds.has(item.id));
      next.links = next.links.filter((item) => !collectionIds.has(item.collection_id));
    }
    if (operation.entity === "collection") {
      next.collections = next.collections.filter((item) => item.id !== operation.entityId);
      next.links = next.links.filter((item) => item.collection_id !== operation.entityId);
    }
    if (operation.entity === "link") next.links = next.links.filter((item) => item.id !== operation.entityId);
  } else if (operation.entity === "collection") {
    const positions = new Map(operation.payload.orderedIds.map((id, index) => [id, index]));
    next.collections = next.collections.map((item) => positions.has(item.id) ? { ...item, space_id: operation.payload.parentId, position: positions.get(item.id)! } : item);
  } else {
    const positions = new Map(operation.payload.orderedIds.map((id, index) => [id, index]));
    next.links = next.links.map((item) => positions.has(item.id) ? { ...item, collection_id: operation.payload.parentId, position: positions.get(item.id)! } : item);
  }
  return normalizeSnapshot(next);
}

export function rebaseWorkspaceOperations(
  canonical: WorkspaceSnapshot,
  tombstones: WorkspaceTombstone[],
  pending: WorkspaceOperation[],
  userId: string,
): WorkspaceRebaseResult {
  let snapshot = clone(canonical);
  const surviving: WorkspaceOperation[] = [];
  const rejected: WorkspaceRebaseResult["rejected"] = [];
  for (const operation of [...pending].sort((left, right) => left.sequence - right.sequence)) {
    if (isTombstoned(tombstones, operation.entity, operation.entityId)) {
      rejected.push({ operationId: operation.operationId, code: "deleted" });
      continue;
    }
    if (parentDeleted(snapshot, tombstones, operation)) {
      rejected.push({ operationId: operation.operationId, code: "deleted_parent" });
      continue;
    }
    snapshot = applyOperation(snapshot, operation, userId);
    surviving.push(operation);
  }
  return { snapshot, pending: surviving, rejected };
}
