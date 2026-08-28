import type { BookmarkRepository } from "../shared/bookmark-repository";
import type { BookmarkSyncSummary } from "../shared/bookmarks";
import type { WorkspaceRepository } from "../shared/repository";
import type { FlattenResult } from "./bookmarks-api";
import { ChromeSnapshotCache, type StorageArea } from "./storage";
import { browserAdapter, browserTarget } from "./browser";

const BOOKMARK_DEVICE_KEY = "tabloom-bookmark-device";

export type BookmarkDevice = { key: string; name: string; sourceId?: string };
export type BookmarkSyncResult = BookmarkSyncSummary & { skipped: number; deviceOnlyCount: number };

export type SyncBrowserBookmarksInput = {
  repository: BookmarkRepository;
  workspace: WorkspaceRepository;
  cache: Pick<ChromeSnapshotCache, "writeEnvelope">;
  device: BookmarkDevice;
  read: () => Promise<FlattenResult>;
  batchSize?: number;
};

function suggestedDeviceName(platform: string): string {
  const browserName = browserTarget === "firefox" ? "Firefox" : browserTarget === "safari" ? "Safari" : "Chromium";
  if (/mac/i.test(platform)) return `${browserName} on macOS`;
  if (/win/i.test(platform)) return `${browserName} on Windows`;
  if (/linux/i.test(platform)) return `${browserName} on Linux`;
  return `${browserName} on this device`;
}

function isDevice(value: unknown): value is BookmarkDevice {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BookmarkDevice>;
  return typeof candidate.key === "string" && candidate.key.length >= 16
    && typeof candidate.name === "string" && candidate.name.trim().length > 0
    && (candidate.sourceId === undefined || typeof candidate.sourceId === "string");
}

export async function getOrCreateBookmarkDevice(
  area: StorageArea = browserAdapter.storage,
  platform = navigator.platform,
  createId: () => string = () => crypto.randomUUID(),
): Promise<BookmarkDevice> {
  const stored = (await area.get(BOOKMARK_DEVICE_KEY))[BOOKMARK_DEVICE_KEY];
  if (isDevice(stored)) return stored;
  const device = { key: createId(), name: suggestedDeviceName(platform) };
  await area.set({ [BOOKMARK_DEVICE_KEY]: device });
  return device;
}

export async function saveBookmarkDevice(device: BookmarkDevice, area: StorageArea = browserAdapter.storage): Promise<void> {
  if (!isDevice(device)) throw new Error("A valid bookmark device name and key are required.");
  await area.set({ [BOOKMARK_DEVICE_KEY]: { ...device, name: device.name.trim() } });
}

export async function syncBrowserBookmarks(input: SyncBrowserBookmarksInput): Promise<BookmarkSyncResult> {
  const flattened = await input.read();
  const batchSize = input.batchSize ?? 200;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("Bookmark sync batch size must be a positive integer.");

  const run = await input.repository.beginSync(input.device.key, input.device.name, flattened.entries.length);
  for (let offset = 0; offset < flattened.entries.length; offset += batchSize) {
    await input.repository.appendBatch(run.runId, flattened.entries.slice(offset, offset + batchSize));
  }
  const summary = await input.repository.finalizeSync(run.runId);
  const [snapshot, bookmarkSources] = await Promise.all([
    input.workspace.load(),
    input.repository.listSources(),
  ]);
  await input.cache.writeEnvelope({
    version: 2,
    snapshot,
    bookmarkSources,
    cachedAt: summary.syncedAt,
  });
  return { ...summary, skipped: flattened.skipped, deviceOnlyCount: flattened.deviceOnlyCount };
}
