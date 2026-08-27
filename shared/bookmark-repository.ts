import type { SupabaseClient } from "@supabase/supabase-js";
import {
  mergeBookmarkEntries,
  toBookmarkWorkspace,
  type BookmarkEntryRecord,
  type BookmarkSource,
  type BookmarkSyncSummary,
  type BookmarkUploadEntry,
} from "./bookmarks";
import type { Collection, SavedLink, Space, WorkspaceSnapshot } from "./domain";
import type { CreateCollectionInput, CreateLinkInput, CreateSpaceInput, WorkspaceRepository } from "./repository";

export interface BookmarkRepository {
  beginSync(deviceKey: string, deviceName: string, expectedEntryCount: number): Promise<{ runId: string; sourceId: string; generation: number }>;
  appendBatch(runId: string, entries: BookmarkUploadEntry[]): Promise<void>;
  finalizeSync(runId: string): Promise<BookmarkSyncSummary>;
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  listSources(): Promise<BookmarkSource[]>;
  renameSource(sourceId: string, deviceName: string): Promise<void>;
  forgetSource(sourceId: string): Promise<void>;
}

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

function firstRow<T>(data: T[] | T | null, operation: string): T {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error(`${operation} returned no data.`);
  return row;
}

type SourceRow = BookmarkSource & { active_run_id: string | null };

export class SupabaseBookmarkRepository implements BookmarkRepository {
  constructor(private readonly client: SupabaseClient, private readonly userId: string) {}

  async beginSync(deviceKey: string, deviceName: string, expectedEntryCount: number) {
    const result = await this.client.rpc("begin_bookmark_sync", {
      p_device_key: deviceKey,
      p_device_name: deviceName,
      p_expected_entry_count: expectedEntryCount,
    });
    throwIfError(result.error);
    const row = firstRow<{ run_id: string; source_id: string; generation: number }>(result.data, "Begin bookmark sync");
    return { runId: row.run_id, sourceId: row.source_id, generation: row.generation };
  }

  async appendBatch(runId: string, entries: BookmarkUploadEntry[]) {
    const result = await this.client.rpc("append_bookmark_sync_batch", { p_run_id: runId, p_entries: entries });
    throwIfError(result.error);
  }

  async finalizeSync(runId: string): Promise<BookmarkSyncSummary> {
    const result = await this.client.rpc("finalize_bookmark_sync", { p_run_id: runId });
    throwIfError(result.error);
    const row = firstRow<{ source_id: string; generation: number; bookmark_count: number; collection_count: number; synced_at: string }>(result.data, "Finalize bookmark sync");
    return {
      sourceId: row.source_id,
      generation: row.generation,
      bookmarkCount: row.bookmark_count,
      collectionCount: row.collection_count,
      syncedAt: row.synced_at,
    };
  }

  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    const sourceResult = await this.client
      .from("bookmark_sources")
      .select("id,device_name,last_synced_at,active_run_id");
    throwIfError(sourceResult.error);
    const sourceRows = (sourceResult.data ?? []) as SourceRow[];
    const activeRunIds = sourceRows.flatMap((source) => source.active_run_id ? [source.active_run_id] : []);
    let entries: BookmarkEntryRecord[] = [];
    if (activeRunIds.length) {
      const entryResult = await this.client
        .from("bookmark_entries")
        .select("id,source_id,chrome_bookmark_id,url,normalized_url,title,folder_path,syncing,position")
        .in("run_id", activeRunIds);
      throwIfError(entryResult.error);
      entries = (entryResult.data ?? []) as BookmarkEntryRecord[];
    }
    const sources = sourceRows.map(({ id, device_name, last_synced_at }) => ({ id, device_name, last_synced_at }));
    return toBookmarkWorkspace(this.userId, mergeBookmarkEntries(sources, entries));
  }

  async listSources(): Promise<BookmarkSource[]> {
    const result = await this.client
      .from("bookmark_sources")
      .select("id,device_name,last_synced_at")
      .order("last_synced_at", { ascending: false, nullsFirst: false });
    throwIfError(result.error);
    return (result.data ?? []) as BookmarkSource[];
  }

  async renameSource(sourceId: string, deviceName: string) {
    const result = await this.client.rpc("rename_bookmark_source", { p_source_id: sourceId, p_device_name: deviceName });
    throwIfError(result.error);
  }

  async forgetSource(sourceId: string) {
    const result = await this.client.rpc("forget_bookmark_source", { p_source_id: sourceId });
    throwIfError(result.error);
  }
}

export class CombinedWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly normal: WorkspaceRepository, private readonly bookmarks: BookmarkRepository) {}

  async load(): Promise<WorkspaceSnapshot> {
    const [normal, bookmark] = await Promise.all([this.normal.load(), this.bookmarks.loadWorkspace()]);
    return {
      spaces: [...normal.spaces, ...bookmark.spaces],
      collections: [...normal.collections, ...bookmark.collections],
      links: [...normal.links, ...bookmark.links],
    };
  }

  createSpace(input: CreateSpaceInput) { return this.normal.createSpace(input); }
  updateSpace(id: string, input: Partial<Pick<Space, "name" | "color">>) { return this.normal.updateSpace(id, input); }
  deleteSpace(id: string) { return this.normal.deleteSpace(id); }
  createCollection(input: CreateCollectionInput) { return this.normal.createCollection(input); }
  updateCollection(id: string, input: Partial<Pick<Collection, "name">>) { return this.normal.updateCollection(id, input); }
  deleteCollection(id: string) { return this.normal.deleteCollection(id); }
  createLink(input: CreateLinkInput) { return this.normal.createLink(input); }
  createLinks(input: CreateLinkInput[]) { return this.normal.createLinks(input); }
  updateLink(id: string, input: Partial<CreateLinkInput>) { return this.normal.updateLink(id, input); }
  deleteLink(id: string) { return this.normal.deleteLink(id); }
  reorderCollections(spaceId: string, orderedIds: string[]) { return this.normal.reorderCollections(spaceId, orderedIds); }
  reorderLinks(collectionId: string, orderedIds: string[]) { return this.normal.reorderLinks(collectionId, orderedIds); }
}

export function copyBookmarkToCollection(repository: WorkspaceRepository, link: SavedLink, collectionId: string) {
  if (link.origin !== "browser-bookmark") return Promise.reject(new Error("Only browser bookmarks can be copied with this action."));
  return repository.createLink({
    collection_id: collectionId,
    title: link.title,
    url: link.url,
    description: "",
    favicon_url: link.favicon_url,
  });
}
