import { isSaveableUrl, type WorkspaceSnapshot } from "../shared/domain";
import { isWorkspaceOperation, replaceSavedWorkspace, type WorkspaceOperation } from "../shared/workspace-operations";
import type { StorageArea } from "./workspace-cache";

export type { StorageArea } from "./workspace-cache";

export const accountWorkspaceKey = (userId: string) => `tabloom-cloud-workspace-v2:${userId}`;
export const accountOutboxKey = (userId: string) => `tabloom-sync-outbox-v1:${userId}`;
export const accountQueueKey = (userId: string) => `tabloom-sync-queue-v2:${userId}`;
export const accountSyncStateKey = (userId: string) => `tabloom-sync-state-v2:${userId}`;
export const legacyCloudWorkspaceKey = (userId: string) => `tabloom-cloud-workspace-v1:${userId}`;
export const corruptWorkspaceKey = (userId: string, timestamp: number) => `tabloom-corrupt-workspace:${userId}:${timestamp}`;
export const deviceIdKey = "tabloom-device-id-v1";

export type PersistedSyncState = {
  phase: "synced" | "failed" | "offline";
  lastSyncedAt?: string;
  lastRevisionCheckAt?: string;
  error?: string;
};

export type QueuedWorkspaceOperation = {
  operation: WorkspaceOperation;
  state: "waiting" | "failed";
  attemptedAt?: string;
  error?: string;
};

export type AccountWorkspaceState = {
  snapshot: WorkspaceSnapshot;
  revision: number;
  cachedAt: string;
  queue: QueuedWorkspaceOperation[];
  nextSequence: number;
  sync: PersistedSyncState;
};

type WorkspaceEnvelope = {
  version: 2;
  snapshot: WorkspaceSnapshot;
  revision: number;
  cachedAt: string;
};

type LegacyOutboxEnvelope = {
  version: 1;
  outbox: WorkspaceOperation[];
  nextSequence: number;
};

type QueueEnvelope = {
  version: 2;
  queue: QueuedWorkspaceOperation[];
  nextSequence: number;
};

type SyncEnvelope = PersistedSyncState & {
  version: 3;
  revision: number;
};

type LegacySyncEnvelope = Omit<PersistedSyncState, "phase"> & {
  version: 2;
  revision: number;
  phase: "synced" | "syncing" | "offline";
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function hasValidMeta(value: Record<string, unknown>, userId?: string): boolean {
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.user_id)
    && (!userId || value.user_id === userId)
    && ["saved", "browser-bookmark"].includes(String(value.origin))
    && typeof value.read_only === "boolean"
    && ((value.origin === "saved" && value.read_only === false)
      || (value.origin === "browser-bookmark" && value.read_only === true))
    && isPosition(value.position)
    && isTimestamp(value.created_at)
    && isTimestamp(value.updated_at);
}

function isWorkspaceSnapshot(value: unknown, userId?: string): value is WorkspaceSnapshot {
  if (!isRecord(value) || !Array.isArray(value.spaces) || !Array.isArray(value.collections) || !Array.isArray(value.links)) return false;
  const spaces = value.spaces;
  const collections = value.collections;
  const links = value.links;
  if (new Set(spaces.map((item) => isRecord(item) ? item.id : undefined)).size !== spaces.length
    || new Set(collections.map((item) => isRecord(item) ? item.id : undefined)).size !== collections.length
    || new Set(links.map((item) => isRecord(item) ? item.id : undefined)).size !== links.length) return false;
  if (!spaces.every((item) => isRecord(item)
    && hasValidMeta(item, userId)
    && isNonEmptyString(item.name)
    && isNonEmptyString(item.color))) return false;
  const spaceIds = new Set(spaces.map((item) => item.id));
  if (!collections.every((item) => isRecord(item)
    && hasValidMeta(item, userId)
    && isNonEmptyString(item.name)
    && isNonEmptyString(item.space_id)
    && spaceIds.has(item.space_id))) return false;
  const collectionIds = new Set(collections.map((item) => item.id));
  return links.every((item) => isRecord(item)
    && hasValidMeta(item, userId)
    && isNonEmptyString(item.collection_id)
    && collectionIds.has(item.collection_id)
    && isSaveableUrl(typeof item.url === "string" ? item.url : undefined)
    && typeof item.title === "string"
    && typeof item.description === "string"
    && (item.favicon_url === null || typeof item.favicon_url === "string")
    && (item.device_label === undefined || item.device_label === null || typeof item.device_label === "string"));
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isWorkspaceEnvelope(value: unknown, userId?: string): value is WorkspaceEnvelope {
  return isRecord(value)
    && value.version === 2
    && isWorkspaceSnapshot(value.snapshot, userId)
    && isRevision(value.revision)
    && isTimestamp(value.cachedAt);
}

function isLegacyEnvelope(value: unknown, userId?: string): value is LegacyCloudEnvelope {
  return isRecord(value) && isWorkspaceSnapshot(value.snapshot, userId) && isRevision(value.revision);
}

function isOutboxEnvelope(value: unknown): value is LegacyOutboxEnvelope {
  return isRecord(value)
    && value.version === 1
    && Array.isArray(value.outbox)
    && value.outbox.every(isWorkspaceOperation)
    && Number.isSafeInteger(value.nextSequence)
    && Number(value.nextSequence) >= 1
    && value.outbox.every((operation) => operation.sequence < Number(value.nextSequence));
}

function isQueuedOperation(value: unknown): value is QueuedWorkspaceOperation {
  if (!isRecord(value) || !isWorkspaceOperation(value.operation)) return false;
  if (value.state !== "waiting" && value.state !== "failed") return false;
  if (value.attemptedAt !== undefined && !isTimestamp(value.attemptedAt)) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  return value.state !== "failed" || isNonEmptyString(value.error);
}

function isQueueEnvelope(value: unknown): value is QueueEnvelope {
  if (!isRecord(value)
    || value.version !== 2
    || !Array.isArray(value.queue)
    || !value.queue.every(isQueuedOperation)
    || !Number.isSafeInteger(value.nextSequence)
    || Number(value.nextSequence) < 1) return false;
  const sequences = value.queue.map((entry) => entry.operation.sequence);
  return sequences.every((sequence, index) => sequence < Number(value.nextSequence)
    && (index === 0 || sequence > sequences[index - 1]));
}

function isSyncEnvelope(value: unknown): value is SyncEnvelope {
  return isRecord(value)
    && value.version === 3
    && ["synced", "failed", "offline"].includes(String(value.phase))
    && isRevision(value.revision)
    && (value.lastSyncedAt === undefined || isTimestamp(value.lastSyncedAt))
    && (value.lastRevisionCheckAt === undefined || isTimestamp(value.lastRevisionCheckAt))
    && (value.error === undefined || typeof value.error === "string");
}

function isLegacySyncEnvelope(value: unknown): value is LegacySyncEnvelope {
  return isRecord(value)
    && value.version === 2
    && ["synced", "syncing", "offline"].includes(String(value.phase))
    && isRevision(value.revision)
    && (value.lastSyncedAt === undefined || isTimestamp(value.lastSyncedAt))
    && (value.lastRevisionCheckAt === undefined || isTimestamp(value.lastRevisionCheckAt))
    && (value.error === undefined || typeof value.error === "string");
}

const LEGACY_RETRY_MESSAGE = "Pending changes need your confirmation. Retry to continue.";
const INTERRUPTED_RETRY_MESSAGE = "The previous sync was interrupted. Retry to continue.";

function normalizeQueue(queue: QueuedWorkspaceOperation[]): { queue: QueuedWorkspaceOperation[]; interrupted: boolean } {
  let interrupted = false;
  const normalized = queue.map((entry) => {
    if (entry.state !== "waiting" || !entry.attemptedAt) return entry;
    interrupted = true;
    return { ...entry, state: "failed" as const, error: INTERRUPTED_RETRY_MESSAGE };
  });
  return { queue: normalized, interrupted };
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
  private readonly subscribeToChanges?: (listener: (changedKeys: string[]) => void) => () => void;
  private readonly accountKeys: ReadonlySet<string>;

  constructor(
    private readonly area: StorageArea,
    private readonly userId: string,
    options: {
      now?: () => number;
      subscribeToChanges?: (listener: (changedKeys: string[]) => void) => () => void;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.subscribeToChanges = options.subscribeToChanges;
    this.accountKeys = new Set([
      accountWorkspaceKey(userId),
      accountQueueKey(userId),
      accountSyncStateKey(userId),
    ]);
  }

  subscribe(listener: (state: AccountWorkspaceState) => void): () => void {
    if (!this.subscribeToChanges) return () => undefined;
    let active = true;
    const unsubscribe = this.subscribeToChanges((changedKeys) => {
      if (!changedKeys.some((key) => this.accountKeys.has(key))) return;
      void this.load().then((state) => {
        if (active && state) listener(state);
      }).catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }

  private async readKey(key: string): Promise<unknown> {
    return (await this.area.get(key))[key];
  }

  private async readRaw() {
    const [workspace, queue, outbox, sync] = await Promise.all([
      this.readKey(accountWorkspaceKey(this.userId)),
      this.readKey(accountQueueKey(this.userId)),
      this.readKey(accountOutboxKey(this.userId)),
      this.readKey(accountSyncStateKey(this.userId)),
    ]);
    return { workspace, queue, outbox, sync };
  }

  async load(): Promise<AccountWorkspaceState | null> {
    const raw = await this.readRaw();
    if (!isWorkspaceEnvelope(raw.workspace, this.userId)) return null;
    let queueEnvelope: QueueEnvelope;
    let migratedLegacyQueue = false;
    if (isQueueEnvelope(raw.queue)) queueEnvelope = raw.queue;
    else if (raw.queue !== undefined) return null;
    else if (isOutboxEnvelope(raw.outbox)) {
      migratedLegacyQueue = true;
      queueEnvelope = {
        version: 2,
        queue: raw.outbox.outbox.map((operation, index) => index === 0
          ? { operation, state: "failed", error: LEGACY_RETRY_MESSAGE }
          : { operation, state: "waiting" }),
        nextSequence: raw.outbox.nextSequence,
      };
    } else if (raw.outbox === undefined) queueEnvelope = { version: 2, queue: [], nextSequence: 1 };
    else return null;

    const normalized = { queue: queueEnvelope.queue, interrupted: false };
    let sync: SyncEnvelope;
    let migratedLegacySync = false;
    if (isSyncEnvelope(raw.sync)) sync = raw.sync;
    else if (isLegacySyncEnvelope(raw.sync)) {
      migratedLegacySync = true;
      const hasFailed = normalized.queue.some((entry) => entry.state === "failed");
      const phase = hasFailed ? "failed" : raw.sync.phase === "syncing" ? "offline" : raw.sync.phase;
      sync = {
        version: 3,
        revision: raw.workspace.revision,
        phase,
        ...(raw.sync.lastSyncedAt ? { lastSyncedAt: raw.sync.lastSyncedAt } : {}),
        ...(raw.sync.lastRevisionCheckAt ? { lastRevisionCheckAt: raw.sync.lastRevisionCheckAt } : {}),
        ...((hasFailed || raw.sync.phase === "syncing")
          ? { error: hasFailed ? normalized.queue.find((entry) => entry.state === "failed")?.error ?? LEGACY_RETRY_MESSAGE : raw.sync.error ?? INTERRUPTED_RETRY_MESSAGE }
          : raw.sync.error ? { error: raw.sync.error } : {}),
      };
    } else if (raw.sync === undefined) {
      const failed = normalized.queue.find((entry) => entry.state === "failed");
      sync = failed
        ? { version: 3, phase: "failed", revision: raw.workspace.revision, error: failed.error }
        : { version: 3, phase: "synced", revision: raw.workspace.revision };
    } else return null;
    if (normalized.interrupted) {
      sync = { ...sync, phase: "failed", error: INTERRUPTED_RETRY_MESSAGE };
    }

    const state: AccountWorkspaceState = {
      snapshot: structuredClone(raw.workspace.snapshot),
      revision: raw.workspace.revision,
      cachedAt: raw.workspace.cachedAt,
      queue: structuredClone(normalized.queue),
      nextSequence: queueEnvelope.nextSequence,
      sync: {
        phase: sync.phase,
        ...(sync.lastSyncedAt ? { lastSyncedAt: sync.lastSyncedAt } : {}),
        ...(sync.lastRevisionCheckAt ? { lastRevisionCheckAt: sync.lastRevisionCheckAt } : {}),
        ...(sync.error ? { error: sync.error } : {}),
      },
    };
    if (migratedLegacyQueue || migratedLegacySync || normalized.interrupted) {
      await this.save(state);
      if (migratedLegacyQueue) await this.area.remove?.(accountOutboxKey(this.userId));
    }
    return state;
  }

  async loadOrThrow(): Promise<AccountWorkspaceState> {
    const value = await this.load();
    if (!value) throw new Error("Account workspace cache is unavailable.");
    return value;
  }

  async normalizeInterruptedAttempts(): Promise<AccountWorkspaceState> {
    return this.update(async (current) => {
      const normalized = normalizeQueue(current.queue);
      if (!normalized.interrupted) return [current, current] as const;
      const next: AccountWorkspaceState = {
        ...current,
        queue: normalized.queue,
        sync: { ...current.sync, phase: "failed", error: INTERRUPTED_RETRY_MESSAGE },
      };
      return [next, next] as const;
    });
  }

  async save(state: AccountWorkspaceState, additionalValues: Record<string, unknown> = {}): Promise<void> {
    await this.area.set({
      ...additionalValues,
      [accountWorkspaceKey(this.userId)]: {
        version: 2,
        snapshot: state.snapshot,
        revision: state.revision,
        cachedAt: state.cachedAt,
      } satisfies WorkspaceEnvelope,
      [accountQueueKey(this.userId)]: {
        version: 2,
        queue: state.queue,
        nextSequence: state.nextSequence,
      } satisfies QueueEnvelope,
      [accountSyncStateKey(this.userId)]: {
        version: 3,
        revision: state.revision,
        ...state.sync,
      } satisfies SyncEnvelope,
    });
  }

  async update<T>(mutator: (state: AccountWorkspaceState) => Promise<[AccountWorkspaceState, T, Record<string, unknown>?]>): Promise<T> {
    return withWorkspaceLock(`tabloom-workspace-lock:${this.userId}`, async () => {
      const current = await this.loadOrThrow();
      const [next, result, additionalValues] = await mutator(structuredClone(current));
      await this.save(next, additionalValues);
      return result;
    });
  }

  async saveCanonical(snapshot: WorkspaceSnapshot, revision: number): Promise<void> {
    if (!isWorkspaceSnapshot(snapshot, this.userId) || !isRevision(revision)) {
      throw new Error("Invalid canonical workspace snapshot.");
    }
    await withWorkspaceLock(`tabloom-workspace-lock:${this.userId}`, async () => {
      const raw = await this.readRaw();
      const workspace = isWorkspaceEnvelope(raw.workspace, this.userId) ? raw.workspace : undefined;
      const queue = isQueueEnvelope(raw.queue)
        ? raw.queue
        : isOutboxEnvelope(raw.outbox)
          ? { version: 2 as const, queue: raw.outbox.outbox.map((operation, index) => index === 0
            ? { operation, state: "failed" as const, error: LEGACY_RETRY_MESSAGE }
            : { operation, state: "waiting" as const }), nextSequence: raw.outbox.nextSequence }
          : { version: 2 as const, queue: [], nextSequence: 1 };
      const sync = isSyncEnvelope(raw.sync) ? raw.sync : undefined;
      const failed = queue.queue.find((entry) => entry.state === "failed");
      await this.save({
        snapshot: workspace ? replaceSavedWorkspace(workspace.snapshot, snapshot) : structuredClone(snapshot),
        revision,
        cachedAt: new Date(this.now()).toISOString(),
        queue: structuredClone(queue.queue),
        nextSequence: queue.nextSequence,
        sync: sync ? {
          phase: sync.phase,
          ...(sync.lastSyncedAt ? { lastSyncedAt: sync.lastSyncedAt } : {}),
          ...(sync.lastRevisionCheckAt ? { lastRevisionCheckAt: sync.lastRevisionCheckAt } : {}),
          ...(sync.error ? { error: sync.error } : {}),
        } : failed ? { phase: "failed", error: failed.error } : { phase: "synced" },
      });
    });
  }

  async migrateV1(): Promise<AccountWorkspaceState | null> {
    return withWorkspaceLock(`tabloom-workspace-lock:${this.userId}`, async () => {
      const current = await this.load();
      if (current) return current;
      const raw = await this.readRaw();
      if (raw.workspace !== undefined && !isWorkspaceEnvelope(raw.workspace, this.userId)) {
        await this.area.set({ [corruptWorkspaceKey(this.userId, this.now())]: raw.workspace });
      }
      const legacy = await this.readKey(legacyCloudWorkspaceKey(this.userId));
      if (!isLegacyEnvelope(legacy, this.userId)) return null;
      const queue = isQueueEnvelope(raw.queue)
        ? raw.queue
        : isOutboxEnvelope(raw.outbox)
          ? { version: 2 as const, queue: raw.outbox.outbox.map((operation, index) => index === 0
            ? { operation, state: "failed" as const, error: LEGACY_RETRY_MESSAGE }
            : { operation, state: "waiting" as const }), nextSequence: raw.outbox.nextSequence }
          : { version: 2 as const, queue: [], nextSequence: 1 };
      const sync = isSyncEnvelope(raw.sync) ? raw.sync : undefined;
      const failed = queue.queue.find((entry) => entry.state === "failed");
      const migrated: AccountWorkspaceState = {
        snapshot: structuredClone(legacy.snapshot),
        revision: legacy.revision,
        cachedAt: new Date(this.now()).toISOString(),
        queue: structuredClone(queue.queue),
        nextSequence: queue.nextSequence,
        sync: sync ? {
          phase: sync.phase,
          ...(sync.lastSyncedAt ? { lastSyncedAt: sync.lastSyncedAt } : {}),
          ...(sync.lastRevisionCheckAt ? { lastRevisionCheckAt: sync.lastRevisionCheckAt } : {}),
          ...(sync.error ? { error: sync.error } : {}),
        } : failed ? { phase: "failed", error: failed.error } : { phase: "synced" },
      };
      await this.save(migrated);
      return migrated;
    });
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
