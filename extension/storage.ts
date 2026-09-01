import type { Collection, SavedLink, Space, WorkspaceSnapshot } from "../shared/domain";
import {
  MemoryWorkspaceRepository,
  type CreateCollectionInput,
  type CreateLinkInput,
  type CreateSpaceInput,
  type WorkspaceRepository,
} from "../shared/repository";
import { browserAdapter } from "./browser";
import {
  BrowserWorkspaceCache,
  type StorageArea,
} from "./workspace-cache";

export type { StorageArea, WorkspaceCacheEnvelope } from "./workspace-cache";

export class ChromeSnapshotCache extends BrowserWorkspaceCache {
  constructor(area: StorageArea = browserAdapter.storage) {
    super(area);
  }
}

const fallbackLockTails = new Map<string, Promise<void>>();

async function withFallbackLock<T>(
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = fallbackLockTails.get(name) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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

async function withLocalWorkspaceLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const lockManager =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & {
          locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
        }).locks;
  return lockManager
    ? lockManager.request("tabloom-local-workspace", operation)
    : withFallbackLock("tabloom-local-workspace", operation);
}

function createEmptyLocalSnapshot(): WorkspaceSnapshot {
  const timestamp = new Date().toISOString();
  const spaceId = crypto.randomUUID();
  return {
    spaces: [{
      id: spaceId,
      user_id: "local-user",
      name: "My Space",
      color: "#7c5ce7",
      position: 0,
      created_at: timestamp,
      updated_at: timestamp,
      origin: "saved",
      read_only: false,
    }],
    collections: [createDefaultCollection(spaceId, timestamp)],
    links: [],
  };
}

function createDefaultCollection(spaceId: string, timestamp = new Date().toISOString()) {
  return {
    id: crypto.randomUUID(),
    user_id: "local-user",
    space_id: spaceId,
    name: "My Collection",
    position: 0,
    created_at: timestamp,
    updated_at: timestamp,
    origin: "saved" as const,
    read_only: false,
  };
}

class LocalWorkspaceRepository implements WorkspaceRepository {
  private constructor(
    private memory: MemoryWorkspaceRepository,
    private readonly cache: ChromeSnapshotCache,
  ) {}

  static async openExisting(area: StorageArea): Promise<LocalWorkspaceRepository | null> {
    const cache = new ChromeSnapshotCache(area);
    return withLocalWorkspaceLock(async () => {
      await cache.migrateLegacyOnce();
      const existing = await cache.read();
      return existing
        ? new LocalWorkspaceRepository(
            new MemoryWorkspaceRepository("local-user", existing),
            cache,
          )
        : null;
    });
  }

  static async create(area: StorageArea) {
    const cache = new ChromeSnapshotCache(area);
    return withLocalWorkspaceLock(async () => {
      await cache.migrateLegacyOnce();
      const existing = await cache.read();
      const initial = existing ?? createEmptyLocalSnapshot();
      const editableSpace = initial.spaces.find((space) => space.origin === "saved" && !space.read_only);
      const hasEditableCollection = initial.collections.some((collection) => collection.origin === "saved" && !collection.read_only);
      if (editableSpace && !hasEditableCollection) initial.collections.push(createDefaultCollection(editableSpace.id));
      if (!existing || !hasEditableCollection) await cache.write(initial);
      return new LocalWorkspaceRepository(new MemoryWorkspaceRepository("local-user", initial), cache);
    });
  }

  load() { return this.memory.load(); }
  private async mutate<T>(operation: (memory: MemoryWorkspaceRepository) => Promise<T>): Promise<T> {
    return withLocalWorkspaceLock(async () => {
      const latest = await this.cache.read() ?? await this.memory.load();
      const memory = new MemoryWorkspaceRepository("local-user", latest);
      const result = await operation(memory);
      await this.cache.write(await memory.load());
      this.memory = memory;
      return result;
    });
  }
  createSpace(input: CreateSpaceInput): Promise<Space> { return this.mutate((memory) => memory.createSpace(input)); }
  updateSpace(id: string, input: Partial<Pick<Space, "name" | "color">>): Promise<void> { return this.mutate((memory) => memory.updateSpace(id, input)); }
  deleteSpace(id: string): Promise<void> { return this.mutate((memory) => memory.deleteSpace(id)); }
  createCollection(input: CreateCollectionInput): Promise<Collection> { return this.mutate((memory) => memory.createCollection(input)); }
  updateCollection(id: string, input: Partial<Pick<Collection, "name">>): Promise<void> { return this.mutate((memory) => memory.updateCollection(id, input)); }
  deleteCollection(id: string): Promise<void> { return this.mutate((memory) => memory.deleteCollection(id)); }
  createLink(input: CreateLinkInput): Promise<SavedLink> { return this.mutate((memory) => memory.createLink(input)); }
  createLinks(input: CreateLinkInput[]): Promise<void> { return this.mutate((memory) => memory.createLinks(input)); }
  updateLink(id: string, input: Partial<CreateLinkInput>): Promise<void> { return this.mutate((memory) => memory.updateLink(id, input)); }
  deleteLink(id: string): Promise<void> { return this.mutate((memory) => memory.deleteLink(id)); }
  reorderCollections(spaceId: string, orderedIds: string[]): Promise<void> { return this.mutate((memory) => memory.reorderCollections(spaceId, orderedIds)); }
  reorderLinks(collectionId: string, orderedIds: string[]): Promise<void> { return this.mutate((memory) => memory.reorderLinks(collectionId, orderedIds)); }
}

export function createLocalWorkspaceRepository(area: StorageArea = browserAdapter.storage): Promise<WorkspaceRepository> {
  return LocalWorkspaceRepository.create(area);
}

export function openLocalWorkspaceRepository(
  area: StorageArea = browserAdapter.storage,
): Promise<WorkspaceRepository | null> {
  return LocalWorkspaceRepository.openExisting(area);
}

export const browserAuthStorage = {
  async getItem(key: string) {
    const result = await browserAdapter.storage.get(key);
    return typeof result[key] === "string" ? result[key] : null;
  },
  async setItem(key: string, value: string) { await browserAdapter.storage.set({ [key]: value }); },
  async removeItem(key: string) { await browserAdapter.storage.remove(key); },
};

export const chromeAuthStorage = browserAuthStorage;
