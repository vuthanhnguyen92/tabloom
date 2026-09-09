import type { Collection, SavedLink, Space, WorkspaceRecordMeta, WorkspaceSnapshot } from "../domain";
import type { CreateLinkInput } from "../repository";
import type { TrashRootType } from "../trash";
import { previewLinkTransfer } from "./drag-model";

export const rollbackOnFailure = "rollbackOnFailure";
export const preserveLocalOnFailure = "preserveLocalOnFailure";
export type MutationPolicy = typeof rollbackOnFailure | typeof preserveLocalOnFailure;

export function applyMutationFailure(policy: MutationPolicy, before: WorkspaceSnapshot, optimistic: WorkspaceSnapshot) {
  return { snapshot: policy === rollbackOnFailure ? before : optimistic, retryRequired: policy === preserveLocalOnFailure };
}

export type WorkspaceMutation =
  | { type: "create-space"; space: Space }
  | { type: "create-collection"; collection: Collection }
  | { type: "create-link"; link: SavedLink }
  | { type: "update-space"; id: string; input: Partial<Pick<Space, "name" | "color">> }
  | { type: "update-collection"; id: string; input: Partial<Pick<Collection, "name">> }
  | { type: "update-link"; id: string; input: Partial<CreateLinkInput> }
  | { type: "delete"; rootType: TrashRootType; id: string }
  | { type: "move-link"; id: string; collectionId: string; index: number }
  | { type: "reorder-collections"; spaceId: string; ids: string[] }
  | { type: "reorder-links"; collectionId: string; ids: string[] }
  | { type: "restore"; snapshot: WorkspaceSnapshot };

export function isWritable(record: WorkspaceRecordMeta | undefined): boolean {
  return !!record && record.origin === "saved" && !record.read_only;
}

export function assertWritable(snapshot: WorkspaceSnapshot, type: TrashRootType, id: string): void {
  if (type === "link") {
    const link = snapshot.links.find((item) => item.id === id);
    if (!isWritable(link)) throw new Error("Missing or read-only link.");
    assertWritable(snapshot, "collection", link!.collection_id);
  } else if (type === "collection") {
    const collection = snapshot.collections.find((item) => item.id === id);
    if (!isWritable(collection)) throw new Error("Missing or read-only collection.");
    assertWritable(snapshot, "space", collection!.space_id);
  } else if (!isWritable(snapshot.spaces.find((item) => item.id === id))) throw new Error("Missing or read-only space.");
}

function reorder<T extends { id: string; position: number }>(items: T[], ids: string[]): T[] {
  if (items.length !== ids.length || new Set(ids).size !== ids.length || items.some((item) => !ids.includes(item.id))) throw new Error("Order must contain each sibling exactly once.");
  return items.map((item) => ({ ...item, position: ids.indexOf(item.id) }));
}

function mergeRestored<T extends WorkspaceRecordMeta & { id: string; position: number }>(existing: T[], restored: T[], parent: (item: T) => string): T[] {
  if (!restored.length) return existing;
  if (new Set(restored.map((item) => item.id)).size !== restored.length || restored.some((item) => existing.some((live) => live.id === item.id))) throw new Error("An item with this ID already exists.");
  const affected = new Set(restored.map(parent));
  const groups = new Map<string, T[]>();
  const affectedWritable = (item: T) => affected.has(parent(item)) && isWritable(item);
  for (const item of [...restored, ...existing.filter(affectedWritable)]) {
    const key = parent(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...existing.filter((item) => !affectedWritable(item)), ...[...groups.values()].flatMap((items) => items.sort((a, b) => a.position - b.position).map((item, position) => ({ ...item, position })))];
}

/** Pure reducers only. Persistence, identity reconciliation, and retry belong to the controller. */
export function reduceWorkspaceSnapshot(snapshot: WorkspaceSnapshot, mutation: WorkspaceMutation): WorkspaceSnapshot {
  switch (mutation.type) {
    case "create-space": return { ...snapshot, spaces: [...snapshot.spaces, { ...mutation.space }] };
    case "create-collection":
      assertWritable(snapshot, "space", mutation.collection.space_id);
      return { ...snapshot, collections: [...snapshot.collections, { ...mutation.collection }] };
    case "create-link":
      assertWritable(snapshot, "collection", mutation.link.collection_id);
      return { ...snapshot, links: [...snapshot.links, { ...mutation.link }] };
    case "update-space":
      assertWritable(snapshot, "space", mutation.id);
      return { ...snapshot, spaces: snapshot.spaces.map((item) => item.id === mutation.id ? { ...item, ...mutation.input } : item) };
    case "update-collection":
      assertWritable(snapshot, "collection", mutation.id);
      return { ...snapshot, collections: snapshot.collections.map((item) => item.id === mutation.id ? { ...item, ...mutation.input } : item) };
    case "update-link":
      assertWritable(snapshot, "link", mutation.id);
      if (mutation.input.collection_id) assertWritable(snapshot, "collection", mutation.input.collection_id);
      return { ...snapshot, links: snapshot.links.map((item) => item.id === mutation.id ? { ...item, ...mutation.input } : item) };
    case "move-link": {
      assertWritable(snapshot, "link", mutation.id);
      assertWritable(snapshot, "collection", mutation.collectionId);
      const source = snapshot.links.find((item) => item.id === mutation.id)!;
      snapshot.links.filter((item) => item.collection_id === source.collection_id || item.collection_id === mutation.collectionId).forEach((item) => assertWritable(snapshot, "link", item.id));
      return { ...snapshot, links: previewLinkTransfer(snapshot.links, mutation.id, mutation.collectionId, mutation.index) };
    }
    case "reorder-collections": {
      assertWritable(snapshot, "space", mutation.spaceId);
      const siblings = snapshot.collections.filter((item) => item.space_id === mutation.spaceId);
      siblings.forEach((item) => assertWritable(snapshot, "collection", item.id));
      const ordered = reorder(siblings, mutation.ids);
      return { ...snapshot, collections: snapshot.collections.map((item) => ordered.find((next) => next.id === item.id) ?? item) };
    }
    case "reorder-links": {
      assertWritable(snapshot, "collection", mutation.collectionId);
      const siblings = snapshot.links.filter((item) => item.collection_id === mutation.collectionId);
      siblings.forEach((item) => assertWritable(snapshot, "link", item.id));
      const ordered = reorder(siblings, mutation.ids);
      return { ...snapshot, links: snapshot.links.map((item) => ordered.find((next) => next.id === item.id) ?? item) };
    }
    case "delete": {
      assertWritable(snapshot, mutation.rootType, mutation.id);
      const collectionIds = new Set(snapshot.collections.filter((item) => mutation.rootType === "space" ? item.space_id === mutation.id : mutation.rootType === "collection" && item.id === mutation.id).map((item) => item.id));
      return {
        spaces: snapshot.spaces.filter((item) => mutation.rootType !== "space" || item.id !== mutation.id),
        collections: snapshot.collections.filter((item) => !collectionIds.has(item.id)),
        links: snapshot.links.filter((item) => !collectionIds.has(item.collection_id) && (mutation.rootType !== "link" || item.id !== mutation.id)),
      };
    }
    case "restore": {
      const combined = { spaces: [...snapshot.spaces, ...mutation.snapshot.spaces], collections: [...snapshot.collections, ...mutation.snapshot.collections], links: [...snapshot.links, ...mutation.snapshot.links] };
      mutation.snapshot.spaces.forEach((item) => assertWritable(combined, "space", item.id));
      mutation.snapshot.collections.forEach((item) => assertWritable(combined, "collection", item.id));
      mutation.snapshot.links.forEach((item) => assertWritable(combined, "link", item.id));
      return {
        spaces: mergeRestored(snapshot.spaces, mutation.snapshot.spaces, () => "spaces"),
        collections: mergeRestored(snapshot.collections, mutation.snapshot.collections, (item) => item.space_id),
        links: mergeRestored(snapshot.links, mutation.snapshot.links, (item) => item.collection_id),
      };
    }
  }
}
