import { isSaveableUrl, type Collection, type SavedLink, type Space, type WorkspaceSnapshot } from "./domain";

export const BROWSER_BOOKMARKS_SPACE_ID = "system:browser-bookmarks";
export const UNFILED_BOOKMARKS = "Unfiled bookmarks";

export type BookmarkSource = {
  id: string;
  device_name: string;
  last_synced_at: string | null;
};

export type BookmarkEntryRecord = {
  id: string;
  source_id: string;
  chrome_bookmark_id: string;
  url: string;
  normalized_url: string;
  title: string;
  folder_path: string;
  syncing: boolean | null;
  position: number;
};

export type BookmarkUploadEntry = Omit<BookmarkEntryRecord, "id" | "source_id">;

export type BookmarkSyncSummary = {
  sourceId: string;
  generation: number;
  bookmarkCount: number;
  collectionCount: number;
  syncedAt: string;
};

export type MergedBookmark = {
  identity: string;
  url: string;
  normalized_url: string;
  title: string;
  folder_path: string;
  syncing: boolean | null;
  position: number;
  source_ids: string[];
  device_label: string | null;
  latest_synced_at: string | null;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeBookmarkUrl(raw: string): string {
  if (!isSaveableUrl(raw)) throw new Error("Only http and https bookmarks can be normalized.");
  const url = new URL(raw);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
  return url.toString();
}

function sourceTimestamp(source: BookmarkSource | undefined): number {
  if (!source?.last_synced_at) return 0;
  const timestamp = Date.parse(source.last_synced_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function newestEntry(
  left: BookmarkEntryRecord,
  right: BookmarkEntryRecord,
  sourceById: Map<string, BookmarkSource>,
): BookmarkEntryRecord {
  const timestampDifference = sourceTimestamp(sourceById.get(right.source_id)) - sourceTimestamp(sourceById.get(left.source_id));
  if (timestampDifference !== 0) return timestampDifference < 0 ? left : right;
  const sourceDifference = compareText(left.source_id, right.source_id);
  if (sourceDifference !== 0) return sourceDifference < 0 ? left : right;
  return compareText(left.chrome_bookmark_id, right.chrome_bookmark_id) <= 0 ? left : right;
}

export function mergeBookmarkEntries(sources: BookmarkSource[], entries: BookmarkEntryRecord[]): MergedBookmark[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const groups = new Map<string, BookmarkEntryRecord[]>();

  for (const entry of entries) {
    if (!isSaveableUrl(entry.url)) continue;
    const normalized = normalizeBookmarkUrl(entry.url);
    const identity = entry.syncing === true
      ? `synced\u0000${normalized}\u0000${entry.folder_path}`
      : `device\u0000${entry.source_id}\u0000${entry.chrome_bookmark_id}`;
    const group = groups.get(identity) ?? [];
    group.push({ ...entry, normalized_url: normalized });
    groups.set(identity, group);
  }

  return [...groups.entries()].map(([identity, group]) => {
    const winner = group.reduce((current, candidate) => newestEntry(current, candidate, sourceById));
    const source = sourceById.get(winner.source_id);
    const sourceIds = [...new Set(group.map((entry) => entry.source_id))].sort(compareText);
    const deviceLabel = winner.syncing === false
      ? `Only on ${source?.device_name ?? "Unknown device"}`
      : winner.syncing === null
        ? `Sync status unknown · ${source?.device_name ?? "Unknown device"}`
        : null;
    return {
      identity,
      url: winner.url,
      normalized_url: winner.normalized_url,
      title: winner.title,
      folder_path: winner.folder_path,
      syncing: winner.syncing,
      position: winner.position,
      source_ids: sourceIds,
      device_label: deviceLabel,
      latest_synced_at: source?.last_synced_at ?? null,
    };
  }).sort((left, right) => (
    compareText(left.folder_path, right.folder_path)
    || left.position - right.position
    || compareText(left.title, right.title)
    || compareText(left.identity, right.identity)
  ));
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function compareFolder(left: string, right: string): number {
  if (left === UNFILED_BOOKMARKS) return right === UNFILED_BOOKMARKS ? 0 : -1;
  if (right === UNFILED_BOOKMARKS) return 1;
  return compareText(left, right);
}

export function toBookmarkWorkspace(userId: string, merged: MergedBookmark[]): WorkspaceSnapshot {
  const epoch = "1970-01-01T00:00:00.000Z";
  const space: Space = {
    id: BROWSER_BOOKMARKS_SPACE_ID,
    user_id: userId,
    name: "Browser Bookmarks",
    color: "#7157d9",
    position: Number.MAX_SAFE_INTEGER,
    created_at: epoch,
    updated_at: merged.reduce((latest, item) => item.latest_synced_at && item.latest_synced_at > latest ? item.latest_synced_at : latest, epoch),
    origin: "browser-bookmark",
    read_only: true,
  };
  const folderNames = [...new Set(merged.map((item) => item.folder_path))].sort(compareFolder);
  const collectionIdByFolder = new Map(folderNames.map((folder) => [folder, `bookmark:collection:${stableHash(folder)}`]));
  const collections: Collection[] = folderNames.map((name, position) => ({
    id: collectionIdByFolder.get(name)!,
    user_id: userId,
    space_id: BROWSER_BOOKMARKS_SPACE_ID,
    name,
    position,
    created_at: epoch,
    updated_at: space.updated_at,
    origin: "browser-bookmark",
    read_only: true,
  }));
  const links: SavedLink[] = [];
  for (const name of folderNames) {
    const folderEntries = merged.filter((item) => item.folder_path === name);
    folderEntries.forEach((item, position) => links.push({
      id: `bookmark:link:${stableHash(item.identity)}`,
      user_id: userId,
      collection_id: collectionIdByFolder.get(name)!,
      url: item.url,
      title: item.title,
      description: "",
      favicon_url: null,
      position,
      created_at: epoch,
      updated_at: item.latest_synced_at ?? epoch,
      origin: "browser-bookmark",
      read_only: true,
      device_label: item.device_label,
    }));
  }
  return { spaces: [space], collections, links };
}
