import type { BookmarkSource } from "../shared/bookmarks";
import type { WorkspaceSnapshot } from "../shared/domain";
import type { VersionedWorkspaceSnapshot } from "../shared/workspace-merge";

export const LOCAL_WORKSPACE_KEY = "tabloom-local-workspace-v2";
export const LEGACY_WORKSPACE_KEY = "tabloom-workspace-snapshot";
export const cloudWorkspaceKey = (userId: string) =>
  `tabloom-cloud-workspace-v1:${userId}`;
export const syncStateKey = (userId: string) =>
  `tabloom-sync-state-v1:${userId}`;

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

export type CachedSyncState = {
  status: "local" | "pending" | "synced" | "error";
  revision: number;
  lastSyncedAt?: string;
  error?: string;
};

export interface WorkspaceCache {
  loadLocal(): Promise<WorkspaceSnapshot | null>;
  saveLocal(snapshot: WorkspaceSnapshot): Promise<void>;
  loadCloud(userId: string): Promise<VersionedWorkspaceSnapshot | null>;
  saveCloud(userId: string, value: VersionedWorkspaceSnapshot): Promise<void>;
  loadSyncState(userId: string): Promise<CachedSyncState | null>;
  saveSyncState(userId: string, state: CachedSyncState): Promise<void>;
  migrateLegacyOnce(): Promise<void>;
}

function isSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkspaceSnapshot>;
  return (
    Array.isArray(candidate.spaces) &&
    Array.isArray(candidate.collections) &&
    Array.isArray(candidate.links)
  );
}

function isEnvelope(value: unknown): value is WorkspaceCacheEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkspaceCacheEnvelope>;
  return (
    candidate.version === 2 &&
    isSnapshot(candidate.snapshot) &&
    Array.isArray(candidate.bookmarkSources)
  );
}

function isVersionedSnapshot(
  value: unknown,
): value is VersionedWorkspaceSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VersionedWorkspaceSnapshot>;
  return (
    Number.isSafeInteger(candidate.revision) &&
    (candidate.revision ?? -1) >= 0 &&
    isSnapshot(candidate.snapshot)
  );
}

function isCachedSyncState(value: unknown): value is CachedSyncState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CachedSyncState>;
  return (
    ["local", "pending", "synced", "error"].includes(candidate.status ?? "") &&
    Number.isSafeInteger(candidate.revision) &&
    (candidate.revision ?? -1) >= 0
  );
}

function isHistoricalDemo(snapshot: WorkspaceSnapshot): boolean {
  return (
    snapshot.spaces.length === 3 &&
    snapshot.spaces.some((row) => row.id === "space-launch") &&
    snapshot.spaces.some((row) => row.id === "space-research") &&
    snapshot.spaces.some((row) => row.id === "space-personal") &&
    snapshot.collections.some((row) => row.id === "collection-plan") &&
    snapshot.links.some((row) => row.id === "link-0")
  );
}

export class BrowserWorkspaceCache implements WorkspaceCache {
  constructor(private readonly area: StorageArea) {}

  async loadLocal(): Promise<WorkspaceSnapshot | null> {
    return (await this.readEnvelope())?.snapshot ?? null;
  }

  async saveLocal(snapshot: WorkspaceSnapshot): Promise<void> {
    const existing = await this.readEnvelope();
    await this.writeEnvelope({
      version: 2,
      snapshot,
      bookmarkSources: existing?.bookmarkSources ?? [],
      cachedAt: new Date().toISOString(),
    });
  }

  async loadCloud(userId: string): Promise<VersionedWorkspaceSnapshot | null> {
    const key = cloudWorkspaceKey(userId);
    const value = (await this.area.get(key))[key];
    return isVersionedSnapshot(value) ? value : null;
  }

  async saveCloud(
    userId: string,
    value: VersionedWorkspaceSnapshot,
  ): Promise<void> {
    await this.area.set({ [cloudWorkspaceKey(userId)]: value });
  }

  async loadSyncState(userId: string): Promise<CachedSyncState | null> {
    const key = syncStateKey(userId);
    const value = (await this.area.get(key))[key];
    return isCachedSyncState(value) ? value : null;
  }

  async saveSyncState(userId: string, state: CachedSyncState): Promise<void> {
    await this.area.set({ [syncStateKey(userId)]: state });
  }

  async migrateLegacyOnce(): Promise<void> {
    if (await this.loadLocal()) return;
    const legacy = (await this.area.get(LEGACY_WORKSPACE_KEY))[
      LEGACY_WORKSPACE_KEY
    ];
    const snapshot = isEnvelope(legacy)
      ? legacy.snapshot
      : isSnapshot(legacy)
        ? legacy
        : null;
    if (!snapshot || isHistoricalDemo(snapshot)) return;
    await this.saveLocal(snapshot);
  }

  async read(): Promise<WorkspaceSnapshot | null> {
    return this.loadLocal();
  }

  async write(snapshot: WorkspaceSnapshot): Promise<void> {
    await this.saveLocal(snapshot);
  }

  async readEnvelope(): Promise<WorkspaceCacheEnvelope | null> {
    const value = (await this.area.get(LOCAL_WORKSPACE_KEY))[
      LOCAL_WORKSPACE_KEY
    ];
    if (isEnvelope(value)) return value;
    if (isSnapshot(value)) {
      return {
        version: 2,
        snapshot: value,
        bookmarkSources: [],
        cachedAt: "",
      };
    }
    return null;
  }

  async writeEnvelope(envelope: WorkspaceCacheEnvelope): Promise<void> {
    await this.area.set({ [LOCAL_WORKSPACE_KEY]: envelope });
  }
}
