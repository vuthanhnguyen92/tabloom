import type { WorkspaceSnapshot } from "../shared/domain";
import { isWorkspaceOperation, replaceSavedWorkspace, type WorkspaceOperation } from "../shared/workspace-operations";
import type { StorageArea } from "./workspace-cache";

export type { StorageArea } from "./workspace-cache";

export const accountWorkspaceKey = (userId: string) => `tabloom-cloud-workspace-v2:${userId}`;
export const accountOutboxKey = (userId: string) => `tabloom-sync-outbox-v1:${userId}`;
export const accountSyncStateKey = (userId: string) => `tabloom-sync-state-v2:${userId}`;
export const legacyCloudWorkspaceKey = (userId: string) => `tabloom-cloud-workspace-v1:${userId}`;
export const corruptWorkspaceKey = (userId: string, timestamp: number) => `tabloom-corrupt-workspace:${userId}:${timestamp}`;
export const deviceIdKey = "tabloom-device-id-v1";

export type PersistedSyncState = {
  phase: "synced" | "syncing" | "offline";
  lastSyncedAt?: string;
  lastRevisionCheckAt?: string;
  error?: string;
};

export type AccountWorkspaceState = {
  snapshot: WorkspaceSnapshot;
  revision: number;
  cachedAt: string;
  outbox: WorkspaceOperation[];
  nextSequence: number;
  sync: PersistedSyncState;
};

type WorkspaceEnvelope = {
  version: 2;
  snapshot: WorkspaceSnapshot;
  revision: number;
  cachedAt: string;
};

type OutboxEnvelope = {
  version: 1;
  outbox: WorkspaceOperation[];
  nextSequence: number;
};

type SyncEnvelope = PersistedSyncState & {
  version: 2;
  revision: number;
};

type LegacyCloudEnvelope = {
  snapshot: WorkspaceSnapshot;
  revision: number;
};

const fallbackLockTails = new Map<string, Promise<void>>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!isRecord(value) || !Array.isArray(value.spaces) || !Array.isArray(value.collections) || !Array.isArray(value.links)) return false;
  return [...value.spaces, ...value.collections, ...value.links].every((item) => isRecord(item) && typeof item.id === "string");
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isWorkspaceEnvelope(value: unknown): value is WorkspaceEnvelope {
  return isRecord(value)
    && value.version === 2
    && isWorkspaceSnapshot(value.snapshot)
    && isRevision(value.revision)
    && typeof value.cachedAt === "string";
}

function isLegacyEnvelope(value: unknown): value is LegacyCloudEnvelope {
  return isRecord(value) && isWorkspaceSnapshot(value.snapshot) && isRevision(value.revision);
}

function isOutboxEnvelope(value: unknown): value is OutboxEnvelope {
  return isRecord(value)
    && value.version === 1
    && Array.isArray(value.outbox)
    && value.outbox.every(isWorkspaceOperation)
    && Number.isSafeInteger(value.nextSequence)
    && Number(value.nextSequence) >= 1;
}

function isSyncEnvelope(value: unknown): value is SyncEnvelope {
  return isRecord(value)
    && value.version === 2
    && ["synced", "syncing", "offline"].includes(String(value.phase))
    && isRevision(value.revision)
    && (value.lastSyncedAt === undefined || typeof value.lastSyncedAt === "string")
    && (value.lastRevisionCheckAt === undefined || typeof value.lastRevisionCheckAt === "string")
    && (value.error === undefined || typeof value.error === "string");
}

async function withFallbackLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const previous = fallbackLockTails.get(name) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  fallbackLockTails.set(name, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fallbackLockTails.get(name) === tail) fallbackLockTails.delete(name);
  }
}

async function withWorkspaceLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const manager = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { locks?: { request<R>(lockName: string, callback: () => Promise<R>): Promise<R> } }).locks;
  return manager ? manager.request(name, operation) : withFallbackLock(name, operation);
}

export class LocalFirstStorage {
  private readonly now: () => number;

  constructor(
    private readonly area: StorageArea,
    private readonly userId: string,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  private async readKey(key: string): Promise<unknown> {
    return (await this.area.get(key))[key];
  }

  private async readRaw() {
    const [workspace, outbox, sync] = await Promise.all([
      this.readKey(accountWorkspaceKey(this.userId)),
      this.readKey(accountOutboxKey(this.userId)),
      this.readKey(accountSyncStateKey(this.userId)),
    ]);
    return { workspace, outbox, sync };
  }

  async load(): Promise<AccountWorkspaceState | null> {
    const raw = await this.readRaw();
    if (!isWorkspaceEnvelope(raw.workspace)) return null;
    let outbox: OutboxEnvelope;
    if (raw.outbox === undefined) outbox = { version: 1, outbox: [], nextSequence: 1 };
    else if (isOutboxEnvelope(raw.outbox)) outbox = raw.outbox;
    else return null;
    let sync: SyncEnvelope;
    if (raw.sync === undefined) sync = { version: 2, phase: "synced", revision: raw.workspace.revision };
    else if (isSyncEnvelope(raw.sync)) sync = raw.sync;
    else return null;
    return {
      snapshot: structuredClone(raw.workspace.snapshot),
      revision: raw.workspace.revision,
      cachedAt: raw.workspace.cachedAt,
      outbox: structuredClone(outbox.outbox),
      nextSequence: outbox.nextSequence,
      sync: {
        phase: sync.phase,
        ...(sync.lastSyncedAt ? { lastSyncedAt: sync.lastSyncedAt } : {}),
        ...(sync.lastRevisionCheckAt ? { lastRevisionCheckAt: sync.lastRevisionCheckAt } : {}),
        ...(sync.error ? { error: sync.error } : {}),
      },
    };
  }

  async loadOrThrow(): Promise<AccountWorkspaceState> {
    const value = await this.load();
    if (!value) throw new Error("Account workspace cache is unavailable.");
    return value;
  }

  async save(state: AccountWorkspaceState): Promise<void> {
    await this.area.set({
      [accountWorkspaceKey(this.userId)]: {
        version: 2,
        snapshot: state.snapshot,
        revision: state.revision,
        cachedAt: state.cachedAt,
      } satisfies WorkspaceEnvelope,
      [accountOutboxKey(this.userId)]: {
        version: 1,
        outbox: state.outbox,
        nextSequence: state.nextSequence,
      } satisfies OutboxEnvelope,
      [accountSyncStateKey(this.userId)]: {
        version: 2,
        revision: state.revision,
        ...state.sync,
      } satisfies SyncEnvelope,
    });
  }

  async update<T>(mutator: (state: AccountWorkspaceState) => Promise<[AccountWorkspaceState, T]>): Promise<T> {
    return withWorkspaceLock(`tabloom-workspace-lock:${this.userId}`, async () => {
      const current = await this.loadOrThrow();
      const [next, result] = await mutator(structuredClone(current));
      await this.save(next);
      return result;
    });
  }

  async saveCanonical(snapshot: WorkspaceSnapshot, revision: number): Promise<void> {
    await withWorkspaceLock(`tabloom-workspace-lock:${this.userId}`, async () => {
      const current = await this.load();
      await this.save({
        snapshot: current ? replaceSavedWorkspace(current.snapshot, snapshot) : structuredClone(snapshot),
        revision,
        cachedAt: new Date(this.now()).toISOString(),
        outbox: current?.outbox ?? [],
        nextSequence: current?.nextSequence ?? 1,
        sync: current?.sync ?? { phase: "synced" },
      });
    });
  }

  async migrateV1(): Promise<AccountWorkspaceState | null> {
    const current = await this.load();
    if (current) return current;
    const rawWorkspace = await this.readKey(accountWorkspaceKey(this.userId));
    if (rawWorkspace !== undefined && !isWorkspaceEnvelope(rawWorkspace)) {
      await this.area.set({ [corruptWorkspaceKey(this.userId, this.now())]: rawWorkspace });
    }
    const legacy = await this.readKey(legacyCloudWorkspaceKey(this.userId));
    if (!isLegacyEnvelope(legacy)) return null;
    const migrated: AccountWorkspaceState = {
      snapshot: structuredClone(legacy.snapshot),
      revision: legacy.revision,
      cachedAt: new Date(this.now()).toISOString(),
      outbox: [],
      nextSequence: 1,
      sync: { phase: "synced" },
    };
    await this.save(migrated);
    return migrated;
  }

  async getOrCreateDeviceId(): Promise<string> {
    return withWorkspaceLock(deviceIdKey, async () => {
      const current = await this.readKey(deviceIdKey);
      if (typeof current === "string" && UUID_PATTERN.test(current)) return current;
      const created = crypto.randomUUID();
      await this.area.set({ [deviceIdKey]: created });
      return created;
    });
  }
}
