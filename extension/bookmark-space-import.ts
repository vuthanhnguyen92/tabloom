import { normalizeBookmarkUrl, UNFILED_BOOKMARKS } from "../shared/bookmarks";
import type { WorkspaceRepository } from "../shared/repository";
import { readBrowserBookmarks, requestBookmarksPermission, type FlattenResult } from "./bookmarks-api";

export type BookmarkSpaceImportResult = {
  imported: number;
  collections: number;
  skipped: number;
  deviceOnly: number;
};

export async function importBrowserBookmarksIntoSpace({
  repository,
  spaceId,
  requestPermission = () => requestBookmarksPermission(),
  readBookmarks = () => readBrowserBookmarks(),
}: {
  repository: WorkspaceRepository;
  spaceId: string;
  requestPermission?: () => Promise<boolean>;
  readBookmarks?: () => Promise<FlattenResult>;
}): Promise<BookmarkSpaceImportResult> {
  if (!(await requestPermission())) throw new Error("Bookmark permission was not granted. Your new space is still available.");
  const flattened = await readBookmarks();
  const snapshot = await repository.load();
  const existingCollections = new Map(snapshot.collections.filter((item) => item.space_id === spaceId).map((item) => [item.name, item]));
  const grouped = new Map<string, FlattenResult["entries"]>();

  for (const entry of flattened.entries) {
    const name = entry.folder_path === UNFILED_BOOKMARKS ? "Imported bookmarks" : entry.folder_path;
    const entries = grouped.get(name) ?? [];
    entries.push(entry);
    grouped.set(name, entries);
  }

  let imported = 0;
  for (const [name, entries] of grouped) {
    const collection = existingCollections.get(name) ?? await repository.createCollection({ space_id: spaceId, name });
    existingCollections.set(name, collection);
    const existingUrls = new Set((await repository.load()).links
      .filter((item) => item.collection_id === collection.id)
      .map((item) => normalizeBookmarkUrl(item.url)));
    const unique = entries
      .sort((left, right) => left.position - right.position)
      .filter((entry) => {
        if (existingUrls.has(entry.normalized_url)) return false;
        existingUrls.add(entry.normalized_url);
        return true;
      });
    await repository.createLinks(unique.map((entry) => ({
      collection_id: collection.id,
      url: entry.url,
      title: entry.title,
      description: entry.syncing === true ? "" : "Imported from this device",
      favicon_url: null,
    })));
    imported += unique.length;
  }

  return { imported, collections: grouped.size, skipped: flattened.skipped, deviceOnly: flattened.deviceOnlyCount };
}
