import type { WorkspaceSnapshot } from "../shared/domain";
import type { BookmarkSource } from "../shared/bookmarks";

const SNAPSHOT_KEY = "tabloom-workspace-snapshot";

export type StorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
};

export type WorkspaceCacheEnvelope = {
  version: 2;
  snapshot: WorkspaceSnapshot;
  bookmarkSources: BookmarkSource[];
  cachedAt: string;
};

function isSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkspaceSnapshot>;
  return Array.isArray(candidate.spaces) && Array.isArray(candidate.collections) && Array.isArray(candidate.links);
}

function isEnvelope(value: unknown): value is WorkspaceCacheEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkspaceCacheEnvelope>;
  return candidate.version === 2 && isSnapshot(candidate.snapshot) && Array.isArray(candidate.bookmarkSources);
}

export class ChromeSnapshotCache {
  constructor(private readonly area: StorageArea = chrome.storage.local) {}
  async read(): Promise<WorkspaceSnapshot | null> {
    return (await this.readEnvelope())?.snapshot ?? null;
  }
  async readEnvelope(): Promise<WorkspaceCacheEnvelope | null> {
    const result = await this.area.get(SNAPSHOT_KEY);
    const value = result[SNAPSHOT_KEY];
    if (isEnvelope(value)) return value;
    if (isSnapshot(value)) return { version: 2, snapshot: value, bookmarkSources: [], cachedAt: "" };
    return null;
  }
  async write(snapshot: WorkspaceSnapshot): Promise<void> {
    const existing = await this.readEnvelope();
    await this.writeEnvelope({
      version: 2,
      snapshot,
      bookmarkSources: existing?.bookmarkSources ?? [],
      cachedAt: new Date().toISOString(),
    });
  }
  async writeEnvelope(envelope: WorkspaceCacheEnvelope): Promise<void> {
    await this.area.set({ [SNAPSHOT_KEY]: envelope });
  }
}

export const chromeAuthStorage = {
  async getItem(key: string) {
    const result = await chrome.storage.local.get(key);
    return typeof result[key] === "string" ? result[key] : null;
  },
  async setItem(key: string, value: string) { await chrome.storage.local.set({ [key]: value }); },
  async removeItem(key: string) { await chrome.storage.local.remove(key); },
};
