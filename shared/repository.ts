import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isSaveableUrl,
  normalizePositions,
  type Collection,
  type SavedLink,
  type Space,
  type WorkspaceRecordMeta,
  type WorkspaceSnapshot,
} from "./domain";

export type CreateSpaceInput = Pick<Space, "name" | "color">;
export type CreateCollectionInput = Pick<Collection, "space_id" | "name">;
export type CreateLinkInput = Pick<SavedLink, "collection_id" | "url" | "title" | "description" | "favicon_url">;
export type MoveCollectionInput = { id: string; sourceSpaceId: string; destinationSpaceId: string };
export type MoveLinkInput = {
  id: string;
  sourceCollectionId: string;
  destinationCollectionId: string;
  sourceOrderedIds: string[];
  destinationOrderedIds: string[];
  /** Structural revision captured before the optimistic move, excluding content fields. */
  expectedSource: Pick<SavedLink, "id" | "position">[];
  expectedDestination: Pick<SavedLink, "id" | "position">[];
};

/** An atomic write was rejected because its structural precondition changed. */
export class WorkspaceConflictError extends Error {
  constructor() { super("Workspace changed elsewhere."); this.name = "WorkspaceConflictError"; }
}

export interface WorkspaceRepository {
  load(): Promise<WorkspaceSnapshot>;
  createSpace(input: CreateSpaceInput): Promise<Space>;
  updateSpace(id: string, input: Partial<Pick<Space, "name" | "color">>): Promise<void>;
  deleteSpace(id: string): Promise<void>;
  createCollection(input: CreateCollectionInput): Promise<Collection>;
  updateCollection(id: string, input: Partial<Pick<Collection, "name">>): Promise<void>;
  deleteCollection(id: string): Promise<void>;
  createLink(input: CreateLinkInput): Promise<SavedLink>;
  createLinks(input: CreateLinkInput[]): Promise<void>;
  updateLink(id: string, input: Partial<CreateLinkInput>): Promise<void>;
  deleteLink(id: string): Promise<void>;
  reorderCollections(spaceId: string, orderedIds: string[]): Promise<void>;
  reorderLinks(collectionId: string, orderedIds: string[]): Promise<void>;
  /** Commit both collections together. Reject before persistence on invalid/stale input. */
  moveLink(input: MoveLinkInput): Promise<void>;
  /** Optional atomic local capability: change parent and compact both spaces. */
  moveCollection?(input: MoveCollectionInput): Promise<void>;
}

export type WebWorkspaceRepository = Omit<WorkspaceRepository, "deleteSpace" | "deleteCollection" | "deleteLink">;

const stamp = () => new Date().toISOString();
const id = () => globalThis.crypto.randomUUID();
const clone = <T>(value: T): T => structuredClone(value);
const markSaved = <T extends object>(value: T): T & WorkspaceRecordMeta => ({ ...value, origin: "saved", read_only: false });

export function moveWorkspaceCollection(snapshot: WorkspaceSnapshot, input: MoveCollectionInput, timestamp = stamp()): WorkspaceSnapshot {
  const moving = snapshot.collections.find((item) => item.id === input.id);
  if (!moving || input.sourceSpaceId === input.destinationSpaceId) throw new WorkspaceConflictError();
  for (const id of [input.sourceSpaceId, input.destinationSpaceId]) {
    const parent = snapshot.spaces.find((item) => item.id === id);
    if (!parent || parent.origin !== "saved" || parent.read_only) throw new Error("Missing or read-only collection move ancestry.");
  }
  const affected = snapshot.collections.filter((item) => item.space_id === input.sourceSpaceId || item.space_id === input.destinationSpaceId);
  if (affected.some((item) => item.origin !== "saved" || item.read_only)
    || snapshot.links.some((item) => item.collection_id === input.id && (item.origin !== "saved" || item.read_only))) throw new Error("Cannot move read-only collection data.");
  if (moving.space_id === input.destinationSpaceId) return snapshot;
  if (moving.space_id !== input.sourceSpaceId) throw new WorkspaceConflictError();
  const source = normalizePositions(affected.filter((item) => item.space_id === input.sourceSpaceId && item.id !== input.id));
  const target = normalizePositions(affected.filter((item) => item.space_id === input.destinationSpaceId));
  target.push({ ...moving, space_id: input.destinationSpaceId, position: target.length });
  const moved = new Map([...source, ...target].map((item) => [item.id, { ...item, updated_at: timestamp }]));
  return { ...snapshot, collections: snapshot.collections.map((item) => moved.get(item.id) ?? item) };
}

function movedLinks(snapshot: WorkspaceSnapshot, input: MoveLinkInput): SavedLink[] {
  const source = snapshot.links.find((item) => item.id === input.id);
  if (!source || source.collection_id !== input.sourceCollectionId || input.sourceCollectionId === input.destinationCollectionId) throw new WorkspaceConflictError();
  for (const [parent, expected] of [[input.sourceCollectionId, input.expectedSource], [input.destinationCollectionId, input.expectedDestination]] as const) {
    const current = snapshot.links.filter((item) => item.collection_id === parent);
    if (current.length !== expected.length || new Set(expected.map((item) => item.id)).size !== expected.length || current.some((item) => !expected.some((entry) => entry.id === item.id && entry.position === item.position))) throw new WorkspaceConflictError();
  }
  for (const id of [input.sourceCollectionId, input.destinationCollectionId]) {
    const collection = snapshot.collections.find((item) => item.id === id);
    const space = snapshot.spaces.find((item) => item.id === collection?.space_id);
    if (!collection || !space || [collection, space].some((item) => item.origin !== "saved" || item.read_only)) throw new Error("Missing or read-only move destination.");
  }
  const affected = snapshot.links.filter((item) => item.collection_id === input.sourceCollectionId || item.collection_id === input.destinationCollectionId);
  if (affected.some((item) => item.origin !== "saved" || item.read_only)) throw new Error("Cannot reorder read-only links.");
  const sourceIds = affected.filter((item) => item.collection_id === input.sourceCollectionId && item.id !== input.id).map((item) => item.id);
  const targetIds = [...affected.filter((item) => item.collection_id === input.destinationCollectionId).map((item) => item.id), input.id];
  for (const [expected, actual] of [[sourceIds, input.sourceOrderedIds], [targetIds, input.destinationOrderedIds]]) {
    if (expected.length !== actual.length || new Set(actual).size !== actual.length || expected.some((id) => !actual.includes(id))) throw new Error("Move order changed.");
  }
  const timestamp = stamp();
  return affected.map((item) => {
    const destination = input.destinationOrderedIds.includes(item.id);
    return { ...item, collection_id: destination ? input.destinationCollectionId : input.sourceCollectionId, position: (destination ? input.destinationOrderedIds : input.sourceOrderedIds).indexOf(item.id), updated_at: timestamp };
  });
}

export function decodeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  if (!value || typeof value !== "object") throw new Error("invalid workspace snapshot");
  const candidate = value as Partial<WorkspaceSnapshot>;
  if (!Array.isArray(candidate.spaces) || !Array.isArray(candidate.collections) || !Array.isArray(candidate.links)) {
    throw new Error("invalid workspace snapshot");
  }
  return {
    spaces: candidate.spaces.map((item) => markSaved(item) as Space),
    collections: candidate.collections.map((item) => markSaved(item) as Collection),
    links: candidate.links.map((item) => ({ ...markSaved(item), device_label: item.device_label ?? null }) as SavedLink),
  };
}

export class MemoryWorkspaceRepository implements WorkspaceRepository {
  private snapshot: WorkspaceSnapshot;
  constructor(private readonly userId: string, initial: WorkspaceSnapshot) {
    this.snapshot = clone(initial);
  }
  async load() { return clone(this.snapshot); }
  async createSpace(input: CreateSpaceInput) {
    const timestamp = stamp();
    const item: Space = { id: id(), user_id: this.userId, ...input, position: this.snapshot.spaces.length, created_at: timestamp, updated_at: timestamp, origin: "saved", read_only: false };
    this.snapshot.spaces.push(item); return clone(item);
  }
  async updateSpace(spaceId: string, input: Partial<Pick<Space, "name" | "color">>) { this.snapshot.spaces = this.snapshot.spaces.map((item) => item.id === spaceId ? { ...item, ...input, updated_at: stamp() } : item); }
  async deleteSpace(spaceId: string) { const collectionIds = new Set(this.snapshot.collections.filter((item) => item.space_id === spaceId).map((item) => item.id)); this.snapshot.spaces = this.snapshot.spaces.filter((item) => item.id !== spaceId); this.snapshot.collections = this.snapshot.collections.filter((item) => !collectionIds.has(item.id)); this.snapshot.links = this.snapshot.links.filter((item) => !collectionIds.has(item.collection_id)); }
  async createCollection(input: CreateCollectionInput) { const timestamp = stamp(); const item: Collection = { id: id(), user_id: this.userId, ...input, position: this.snapshot.collections.filter((entry) => entry.space_id === input.space_id).length, created_at: timestamp, updated_at: timestamp, origin: "saved", read_only: false }; this.snapshot.collections.push(item); return clone(item); }
  async updateCollection(collectionId: string, input: Partial<Pick<Collection, "name">>) { this.snapshot.collections = this.snapshot.collections.map((item) => item.id === collectionId ? { ...item, ...input, updated_at: stamp() } : item); }
  async deleteCollection(collectionId: string) { this.snapshot.collections = this.snapshot.collections.filter((item) => item.id !== collectionId); this.snapshot.links = this.snapshot.links.filter((item) => item.collection_id !== collectionId); }
  async createLink(input: CreateLinkInput) { if (!isSaveableUrl(input.url)) throw new Error("Only http and https links can be saved."); const timestamp = stamp(); const item: SavedLink = { id: id(), user_id: this.userId, ...input, position: this.snapshot.links.filter((entry) => entry.collection_id === input.collection_id).length, created_at: timestamp, updated_at: timestamp, origin: "saved", read_only: false, device_label: null }; this.snapshot.links.push(item); return clone(item); }
  async createLinks(input: CreateLinkInput[]) { for (const item of input) await this.createLink(item); }
  async updateLink(linkId: string, input: Partial<CreateLinkInput>) { if (input.url && !isSaveableUrl(input.url)) throw new Error("Only http and https links can be saved."); this.snapshot.links = this.snapshot.links.map((item) => item.id === linkId ? { ...item, ...input, updated_at: stamp() } : item); }
  async deleteLink(linkId: string) { this.snapshot.links = this.snapshot.links.filter((item) => item.id !== linkId); }
  async reorderCollections(spaceId: string, orderedIds: string[]) { const positions = new Map(orderedIds.map((item, index) => [item, index])); const reordered = normalizePositions(this.snapshot.collections.filter((item) => item.space_id === spaceId).map((item) => positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item)); this.snapshot.collections = this.snapshot.collections.map((item) => reordered.find((candidate) => candidate.id === item.id) ?? item); }
  async reorderLinks(collectionId: string, orderedIds: string[]) { const positions = new Map(orderedIds.map((item, index) => [item, index])); this.snapshot.links = this.snapshot.links.map((item) => positions.has(item.id) ? { ...item, collection_id: collectionId, position: positions.get(item.id)!, updated_at: stamp() } : item); }
  async moveLink(input: MoveLinkInput) {
    const moved = new Map(movedLinks(this.snapshot, input).map((link) => [link.id, link]));
    this.snapshot = { ...this.snapshot, links: this.snapshot.links.map((link) => moved.get(link.id) ?? link) };
  }
  async moveCollection(input: MoveCollectionInput) { this.snapshot = moveWorkspaceCollection(this.snapshot, input); }
}

function throwIfError(error: { message: string } | null) { if (error) throw new Error(error.message); }

export class SupabaseWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly client: SupabaseClient, private readonly userId: string) {}
  async load(): Promise<WorkspaceSnapshot> {
    const [spaces, collections, links] = await Promise.all([
      this.client.from("spaces").select("*").order("position"),
      this.client.from("collections").select("*").order("position"),
      this.client.from("links").select("*").order("position"),
    ]);
    throwIfError(spaces.error); throwIfError(collections.error); throwIfError(links.error);
    return decodeWorkspaceSnapshot({ spaces: spaces.data ?? [], collections: collections.data ?? [], links: links.data ?? [] });
  }
  private async insert<T>(table: string, value: Record<string, unknown>): Promise<T> { const result = await this.client.from(table).insert({ ...value, user_id: this.userId }).select().single(); throwIfError(result.error); return result.data as T; }
  async createSpace(input: CreateSpaceInput) { const count = await this.client.from("spaces").select("id", { count: "exact", head: true }); throwIfError(count.error); return markSaved(await this.insert<Omit<Space, keyof WorkspaceRecordMeta>>("spaces", { ...input, position: count.count ?? 0 })); }
  async updateSpace(spaceId: string, input: Partial<Pick<Space, "name" | "color">>) { const result = await this.client.from("spaces").update({ ...input, updated_at: stamp() }).eq("id", spaceId); throwIfError(result.error); }
  async deleteSpace(spaceId: string): Promise<void> { throw new Error(`Use WorkspaceTrashRepository.deleteEntity to delete space ${spaceId} with a recoverable receipt.`); }
  async createCollection(input: CreateCollectionInput) { const count = await this.client.from("collections").select("id", { count: "exact", head: true }).eq("space_id", input.space_id); throwIfError(count.error); return markSaved(await this.insert<Omit<Collection, keyof WorkspaceRecordMeta>>("collections", { ...input, position: count.count ?? 0 })); }
  async updateCollection(collectionId: string, input: Partial<Pick<Collection, "name">>) { const result = await this.client.from("collections").update({ ...input, updated_at: stamp() }).eq("id", collectionId); throwIfError(result.error); }
  async deleteCollection(collectionId: string): Promise<void> { throw new Error(`Use WorkspaceTrashRepository.deleteEntity to delete collection ${collectionId} with a recoverable receipt.`); }
  async createLink(input: CreateLinkInput) { if (!isSaveableUrl(input.url)) throw new Error("Only http and https links can be saved."); const count = await this.client.from("links").select("id", { count: "exact", head: true }).eq("collection_id", input.collection_id); throwIfError(count.error); return { ...markSaved(await this.insert<Omit<SavedLink, keyof WorkspaceRecordMeta | "device_label">>("links", { ...input, position: count.count ?? 0 })), device_label: null }; }
  async createLinks(input: CreateLinkInput[]) {
    if (!input.every((item) => isSaveableUrl(item.url))) throw new Error("Only http and https links can be saved.");
    if (!input.length) return;
    const collectionIds = [...new Set(input.map((item) => item.collection_id))];
    const existing = await this.client.from("links").select("collection_id,position").in("collection_id", collectionIds);
    throwIfError(existing.error);
    const nextPosition = new Map<string, number>();
    for (const item of existing.data ?? []) nextPosition.set(item.collection_id, Math.max(nextPosition.get(item.collection_id) ?? 0, item.position + 1));
    const rows = input.map((item) => {
      const position = nextPosition.get(item.collection_id) ?? 0;
      nextPosition.set(item.collection_id, position + 1);
      return { ...item, user_id: this.userId, position };
    });
    const result = await this.client.from("links").insert(rows);
    throwIfError(result.error);
  }
  async updateLink(linkId: string, input: Partial<CreateLinkInput>) { if (input.url && !isSaveableUrl(input.url)) throw new Error("Only http and https links can be saved."); const result = await this.client.from("links").update({ ...input, updated_at: stamp() }).eq("id", linkId); throwIfError(result.error); }
  async deleteLink(linkId: string): Promise<void> { throw new Error(`Use WorkspaceTrashRepository.deleteEntity to delete link ${linkId} with a recoverable receipt.`); }
  async reorderCollections(spaceId: string, orderedIds: string[]) { const snapshot = await this.load(); const rows = snapshot.collections.filter((item) => item.origin === "saved" && item.space_id === spaceId && orderedIds.includes(item.id)).map((item) => ({ id: item.id, user_id: item.user_id, space_id: item.space_id, name: item.name, position: orderedIds.indexOf(item.id), created_at: item.created_at, updated_at: stamp() })); const result = await this.client.from("collections").upsert(rows); throwIfError(result.error); }
  async reorderLinks(collectionId: string, orderedIds: string[]) { const snapshot = await this.load(); const rows = snapshot.links.filter((item) => item.origin === "saved" && orderedIds.includes(item.id)).map((item) => ({ id: item.id, user_id: item.user_id, collection_id: collectionId, url: item.url, title: item.title, description: item.description, favicon_url: item.favicon_url, position: orderedIds.indexOf(item.id), created_at: item.created_at, updated_at: stamp() })); const result = await this.client.from("links").upsert(rows); throwIfError(result.error); }
  async moveLink(input: MoveLinkInput) {
    const result = await this.client.rpc("move_workspace_link", {
      p_link_id: input.id, p_source_collection_id: input.sourceCollectionId, p_destination_collection_id: input.destinationCollectionId,
      p_expected_source: input.expectedSource, p_expected_destination: input.expectedDestination,
      p_source_ordered_ids: input.sourceOrderedIds, p_destination_ordered_ids: input.destinationOrderedIds,
    });
    if (result.error && ["40001", "40P01", "P0002"].includes(result.error.code)) throw new WorkspaceConflictError();
    throwIfError(result.error);
  }
}
