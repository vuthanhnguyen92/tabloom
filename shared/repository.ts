import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isSaveableUrl,
  normalizePositions,
  type Collection,
  type SavedLink,
  type Space,
  type WorkspaceSnapshot,
} from "./domain";

export type CreateSpaceInput = Pick<Space, "name" | "color">;
export type CreateCollectionInput = Pick<Collection, "space_id" | "name">;
export type CreateLinkInput = Pick<SavedLink, "collection_id" | "url" | "title" | "description" | "favicon_url">;

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
}

const stamp = () => new Date().toISOString();
const id = () => globalThis.crypto.randomUUID();
const clone = <T>(value: T): T => structuredClone(value);

export class MemoryWorkspaceRepository implements WorkspaceRepository {
  private snapshot: WorkspaceSnapshot;
  constructor(private readonly userId: string, initial: WorkspaceSnapshot) {
    this.snapshot = clone(initial);
  }
  async load() { return clone(this.snapshot); }
  async createSpace(input: CreateSpaceInput) {
    const timestamp = stamp();
    const item: Space = { id: id(), user_id: this.userId, ...input, position: this.snapshot.spaces.length, created_at: timestamp, updated_at: timestamp };
    this.snapshot.spaces.push(item); return clone(item);
  }
  async updateSpace(spaceId: string, input: Partial<Pick<Space, "name" | "color">>) { this.snapshot.spaces = this.snapshot.spaces.map((item) => item.id === spaceId ? { ...item, ...input, updated_at: stamp() } : item); }
  async deleteSpace(spaceId: string) { const collectionIds = new Set(this.snapshot.collections.filter((item) => item.space_id === spaceId).map((item) => item.id)); this.snapshot.spaces = this.snapshot.spaces.filter((item) => item.id !== spaceId); this.snapshot.collections = this.snapshot.collections.filter((item) => !collectionIds.has(item.id)); this.snapshot.links = this.snapshot.links.filter((item) => !collectionIds.has(item.collection_id)); }
  async createCollection(input: CreateCollectionInput) { const timestamp = stamp(); const item: Collection = { id: id(), user_id: this.userId, ...input, position: this.snapshot.collections.filter((entry) => entry.space_id === input.space_id).length, created_at: timestamp, updated_at: timestamp }; this.snapshot.collections.push(item); return clone(item); }
  async updateCollection(collectionId: string, input: Partial<Pick<Collection, "name">>) { this.snapshot.collections = this.snapshot.collections.map((item) => item.id === collectionId ? { ...item, ...input, updated_at: stamp() } : item); }
  async deleteCollection(collectionId: string) { this.snapshot.collections = this.snapshot.collections.filter((item) => item.id !== collectionId); this.snapshot.links = this.snapshot.links.filter((item) => item.collection_id !== collectionId); }
  async createLink(input: CreateLinkInput) { if (!isSaveableUrl(input.url)) throw new Error("Only http and https links can be saved."); const timestamp = stamp(); const item: SavedLink = { id: id(), user_id: this.userId, ...input, position: this.snapshot.links.filter((entry) => entry.collection_id === input.collection_id).length, created_at: timestamp, updated_at: timestamp }; this.snapshot.links.push(item); return clone(item); }
  async createLinks(input: CreateLinkInput[]) { for (const item of input) await this.createLink(item); }
  async updateLink(linkId: string, input: Partial<CreateLinkInput>) { if (input.url && !isSaveableUrl(input.url)) throw new Error("Only http and https links can be saved."); this.snapshot.links = this.snapshot.links.map((item) => item.id === linkId ? { ...item, ...input, updated_at: stamp() } : item); }
  async deleteLink(linkId: string) { this.snapshot.links = this.snapshot.links.filter((item) => item.id !== linkId); }
  async reorderCollections(spaceId: string, orderedIds: string[]) { const positions = new Map(orderedIds.map((item, index) => [item, index])); const reordered = normalizePositions(this.snapshot.collections.filter((item) => item.space_id === spaceId).map((item) => positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item)); this.snapshot.collections = this.snapshot.collections.map((item) => reordered.find((candidate) => candidate.id === item.id) ?? item); }
  async reorderLinks(collectionId: string, orderedIds: string[]) { const positions = new Map(orderedIds.map((item, index) => [item, index])); this.snapshot.links = this.snapshot.links.map((item) => positions.has(item.id) ? { ...item, collection_id: collectionId, position: positions.get(item.id)!, updated_at: stamp() } : item); }
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
    return { spaces: spaces.data as Space[], collections: collections.data as Collection[], links: links.data as SavedLink[] };
  }
  private async insert<T>(table: string, value: Record<string, unknown>): Promise<T> { const result = await this.client.from(table).insert({ ...value, user_id: this.userId }).select().single(); throwIfError(result.error); return result.data as T; }
  async createSpace(input: CreateSpaceInput) { const count = await this.client.from("spaces").select("id", { count: "exact", head: true }); throwIfError(count.error); return this.insert<Space>("spaces", { ...input, position: count.count ?? 0 }); }
  async updateSpace(spaceId: string, input: Partial<Pick<Space, "name" | "color">>) { const result = await this.client.from("spaces").update({ ...input, updated_at: stamp() }).eq("id", spaceId); throwIfError(result.error); }
  async deleteSpace(spaceId: string) { const result = await this.client.from("spaces").delete().eq("id", spaceId); throwIfError(result.error); }
  async createCollection(input: CreateCollectionInput) { const count = await this.client.from("collections").select("id", { count: "exact", head: true }).eq("space_id", input.space_id); throwIfError(count.error); return this.insert<Collection>("collections", { ...input, position: count.count ?? 0 }); }
  async updateCollection(collectionId: string, input: Partial<Pick<Collection, "name">>) { const result = await this.client.from("collections").update({ ...input, updated_at: stamp() }).eq("id", collectionId); throwIfError(result.error); }
  async deleteCollection(collectionId: string) { const result = await this.client.from("collections").delete().eq("id", collectionId); throwIfError(result.error); }
  async createLink(input: CreateLinkInput) { if (!isSaveableUrl(input.url)) throw new Error("Only http and https links can be saved."); const count = await this.client.from("links").select("id", { count: "exact", head: true }).eq("collection_id", input.collection_id); throwIfError(count.error); return this.insert<SavedLink>("links", { ...input, position: count.count ?? 0 }); }
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
  async deleteLink(linkId: string) { const result = await this.client.from("links").delete().eq("id", linkId); throwIfError(result.error); }
  async reorderCollections(spaceId: string, orderedIds: string[]) { const snapshot = await this.load(); const rows = snapshot.collections.filter((item) => item.space_id === spaceId && orderedIds.includes(item.id)).map((item) => ({ ...item, position: orderedIds.indexOf(item.id), updated_at: stamp() })); const result = await this.client.from("collections").upsert(rows); throwIfError(result.error); }
  async reorderLinks(collectionId: string, orderedIds: string[]) { const snapshot = await this.load(); const rows = snapshot.links.filter((item) => orderedIds.includes(item.id)).map((item) => ({ ...item, collection_id: collectionId, position: orderedIds.indexOf(item.id), updated_at: stamp() })); const result = await this.client.from("links").upsert(rows); throwIfError(result.error); }
}
