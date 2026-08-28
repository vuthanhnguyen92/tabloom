import { normalizeBookmarkUrl, UNFILED_BOOKMARKS, type BookmarkUploadEntry } from "../shared/bookmarks";
import { isSaveableUrl } from "../shared/domain";
import { browserAdapter } from "./browser";

export type BookmarkNode = {
  id: string;
  title: string;
  url?: string;
  index?: number;
  syncing?: boolean;
  folderType?: string;
  children?: BookmarkNode[];
};

export type FlattenResult = {
  entries: BookmarkUploadEntry[];
  skipped: number;
  collectionCount: number;
  deviceOnlyCount: number;
};

export type PermissionsApi = {
  request(permission: { permissions: string[] }): Promise<boolean>;
};

export type BookmarksApi = {
  getTree(): Promise<BookmarkNode[]>;
};

export async function requestBookmarksPermission(api?: PermissionsApi): Promise<boolean> {
  return api ? api.request({ permissions: ["bookmarks"] }) : browserAdapter.permissions.request("bookmarks");
}

function isHiddenRoot(folderType: string | undefined, title: string): boolean {
  return folderType === "bookmarks-bar"
    || folderType === "other"
    || folderType === "other-bookmarks"
    || title === "Bookmarks bar"
    || title === "Other bookmarks";
}

function visiblePath(path: string[]): string {
  return path.length ? path.join(" / ") : UNFILED_BOOKMARKS;
}

export async function readBrowserBookmarks(api?: BookmarksApi): Promise<FlattenResult> {
  const roots = await (api ?? browserAdapter.bookmarks).getTree();
  const entries: BookmarkUploadEntry[] = [];
  let skipped = 0;

  function visit(node: BookmarkNode, path: string[], inheritedSyncing: boolean | null, siblingPosition: number) {
    const syncing = typeof node.syncing === "boolean" ? node.syncing : inheritedSyncing;
    if (node.url) {
      if (!isSaveableUrl(node.url)) {
        skipped += 1;
        return;
      }
      entries.push({
        chrome_bookmark_id: node.id,
        url: node.url,
        normalized_url: normalizeBookmarkUrl(node.url),
        title: node.title.trim() || node.url,
        folder_path: visiblePath(path),
        syncing,
        position: node.index ?? siblingPosition,
      });
      return;
    }

    const nextPath = isHiddenRoot(node.folderType, node.title)
      ? path
      : node.title.trim()
        ? [...path, node.title.trim()]
        : path;
    node.children?.forEach((child, index) => visit(child, nextPath, syncing, index));
  }

  roots.forEach((root, index) => visit(root, [], null, index));
  return {
    entries,
    skipped,
    collectionCount: new Set(entries.map((entry) => entry.folder_path)).size,
    deviceOnlyCount: entries.filter((entry) => entry.syncing !== true).length,
  };
}
