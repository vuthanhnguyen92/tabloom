import type { BookmarkSource } from "../shared/bookmarks";
import type { WorkspaceSnapshot } from "../shared/domain";
import type { VersionedWorkspaceSnapshot } from "../shared/workspace-merge";
import {
  LocalFirstStorage,
  accountSyncStateKey,
  accountWorkspaceKey,
} from "./local-first-storage";

export const LOCAL_WORKSPACE_KEY = "tabloom-local-workspace-v2";
export const LEGACY_WORKSPACE_KEY = "tabloom-workspace-snapshot";
export const cloudWorkspaceKey = accountWorkspaceKey;
export const syncStateKey = accountSyncStateKey;

export type StorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  remove?(key: string): Promise<void>;
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

  async saveLocal(snapshot: WorkspaceSnapshot, additionalValues: Record<string, unknown> = {}): Promise<void> {
    const existing = await this.readEnvelope();
    await this.writeEnvelope({
      version: 2,
      snapshot,
      bookmarkSources: existing?.bookmarkSources ?? [],
      cachedAt: new Date().toISOString(),
    }, additionalValues);
  }

  async loadCloud(userId: string): Promise<VersionedWorkspaceSnapshot | null> {
    const storage = new LocalFirstStorage(this.area, userId);
    const value = await storage.load() ?? await storage.migrateV1();
    return value ? { snapshot: value.snapshot, revision: value.revision } : null;
  }

  async saveCloud(
    userId: string,
    value: VersionedWorkspaceSnapshot,
  ): Promise<void> {
    await new LocalFirstStorage(this.area, userId).saveCanonical(value.snapshot, value.revision);
  }

  async loadSyncState(userId: string): Promise<CachedSyncState | null> {
    const value = await new LocalFirstStorage(this.area, userId).load();
    if (!value) return null;
    const status: CachedSyncState["status"] = value.sync.phase === "synced"
      ? "synced"
      : value.sync.phase === "offline" && value.sync.error
        ? "error"
        : "pending";
    return {
      status,
      revision: value.revision,
      ...(value.sync.lastSyncedAt ? { lastSyncedAt: value.sync.lastSyncedAt } : {}),
      ...(value.sync.error ? { error: value.sync.error } : {}),
    };
  }

  async saveSyncState(userId: string, state: CachedSyncState): Promise<void> {
    const storage = new LocalFirstStorage(this.area, userId);
    await storage.update(async (current) => [{
      ...current,
      revision: state.revision,
      sync: {
        phase: state.status === "synced" ? "synced" : state.status === "error" ? "offline" : "failed",
        ...(state.lastSyncedAt ? { lastSyncedAt: state.lastSyncedAt } : {}),
        ...(state.error ? { error: state.error } : state.status === "pending" ? { error: "Workspace sync is pending." } : {}),
      },
    }, undefined]);
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

  async write(snapshot: WorkspaceSnapshot, additionalValues: Record<string, unknown> = {}): Promise<void> {
    await this.saveLocal(snapshot, additionalValues);
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

  async writeEnvelope(envelope: WorkspaceCacheEnvelope, additionalValues: Record<string, unknown> = {}): Promise<void> {
    await this.area.set({ ...additionalValues, [LOCAL_WORKSPACE_KEY]: envelope });
  }
}
