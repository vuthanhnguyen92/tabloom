import { isSaveableUrl, type Collection, type SavedLink, type Space, type WorkspaceSnapshot } from "../shared/domain";
import {
  MemoryWorkspaceRepository,
  type CreateCollectionInput,
  type CreateLinkInput,
  type CreateSpaceInput,
  type WorkspaceRepository,
} from "../shared/repository";
import { coalesceWorkspaceOperations, type WorkspaceOperation } from "../shared/workspace-operations";
import { LocalFirstStorage } from "./local-first-storage";

export type LocalMutationListener = (operations: WorkspaceOperation[]) => Promise<void>;

type OperationIntent = Pick<WorkspaceOperation, "entity" | "entityId" | "action" | "payload">;

function requireEditable<T extends { id: string; origin: string; read_only: boolean }>(items: T[], id: string, label: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`${label} was not found.`);
  if (item.origin !== "saved" || item.read_only) throw new Error(`${label} is read-only.`);
  return item;
}

function createIntent(entity: WorkspaceOperation["entity"], record: Space | Collection | SavedLink): OperationIntent {
  if (entity === "space") {
    const space = record as Space;
    return { entity, entityId: space.id, action: "create", payload: { id: space.id, name: space.name, color: space.color, position: space.position, created_at: space.created_at, updated_at: space.updated_at } };
  }
  if (entity === "collection") {
    const collection = record as Collection;
    return { entity, entityId: collection.id, action: "create", payload: { id: collection.id, space_id: collection.space_id, name: collection.name, position: collection.position, created_at: collection.created_at, updated_at: collection.updated_at } };
  }
  const link = record as SavedLink;
  return { entity, entityId: link.id, action: "create", payload: { id: link.id, collection_id: link.collection_id, url: link.url, title: link.title, description: link.description, favicon_url: link.favicon_url, position: link.position, created_at: link.created_at, updated_at: link.updated_at } };
}

export class LocalFirstWorkspaceRepository implements WorkspaceRepository {
  private constructor(
    private readonly userId: string,
    private readonly storage: LocalFirstStorage,
    private readonly deviceId: string,
    private readonly onMutation: LocalMutationListener,
  ) {}

  static async create(input: {
    userId: string;
    storage: LocalFirstStorage;
    onMutation: LocalMutationListener;
  }): Promise<LocalFirstWorkspaceRepository> {
    await input.storage.loadOrThrow();
    const deviceId = await input.storage.getOrCreateDeviceId();
    return new LocalFirstWorkspaceRepository(
      input.userId,
      input.storage,
      deviceId,
      input.onMutation,
    );
  }

  async load(): Promise<WorkspaceSnapshot> {
    return (await this.storage.loadOrThrow()).snapshot;
  }

  private async mutate<T>(
    apply: (memory: MemoryWorkspaceRepository, before: WorkspaceSnapshot) => Promise<T>,
    makeIntents: (before: WorkspaceSnapshot, after: WorkspaceSnapshot, result: T) => OperationIntent[],
  ): Promise<T> {
    const committed = await this.storage.update(async (state) => {
      const before = structuredClone(state.snapshot);
      const memory = new MemoryWorkspaceRepository(this.userId, before);
      const value = await apply(memory, before);
      const after = await memory.load();
      const intents = makeIntents(before, after, value);
      const timestamp = new Date().toISOString();
      const operations = intents.map((intent, index) => ({
        ...intent,
        operationId: crypto.randomUUID(),
        deviceId: this.deviceId,
        sequence: state.nextSequence + index,
        createdAt: timestamp,
        baseRevision: state.revision,
      }) as WorkspaceOperation);
      const immutable = new Set([
        ...state.queue
          .filter((entry) => entry.state === "failed" || Boolean(entry.attemptedAt))
          .map((entry) => entry.operation.operationId),
      ]);
      const pending = operations.reduce(
        (pending, operation) => coalesceWorkspaceOperations(pending, operation, immutable),
        state.queue.map((entry) => entry.operation),
      );
      const previousById = new Map(state.queue.map((entry) => [entry.operation.operationId, entry]));
      const generatedIds = new Set(operations.map((operation) => operation.operationId));
      const queue = pending.map((operation) => {
        const previous = previousById.get(operation.operationId);
        return previous ? { ...previous, operation } : { operation, state: "waiting" as const };
      });
      const submitted = queue
        .filter((entry) => generatedIds.has(entry.operation.operationId))
        .map((entry) => entry.operation);
      const next = {
        ...state,
        snapshot: after,
        queue,
        nextSequence: state.nextSequence + operations.length,
        cachedAt: timestamp,
      };
      return [next, { value, operations: submitted }] as const;
    });
    if (committed.operations.length) await this.onMutation(committed.operations);
    return committed.value;
  }

  createSpace(input: CreateSpaceInput): Promise<Space> {
    return this.mutate(
      (memory) => memory.createSpace(input),
      (_before, _after, created) => [createIntent("space", created)],
    );
  }

  updateSpace(id: string, input: Partial<Pick<Space, "name" | "color">>): Promise<void> {
    return this.mutate(
      (memory, before) => { requireEditable(before.spaces, id, "Space"); return memory.updateSpace(id, input); },
      () => [{ entity: "space", entityId: id, action: "update", payload: input }],
    );
  }

  deleteSpace(id: string): Promise<void> {
    return this.mutate(
      (memory, before) => { requireEditable(before.spaces, id, "Space"); return memory.deleteSpace(id); },
      () => [{ entity: "space", entityId: id, action: "delete", payload: {} }],
    );
  }

  createCollection(input: CreateCollectionInput): Promise<Collection> {
    return this.mutate(
      (memory, before) => { requireEditable(before.spaces, input.space_id, "Space"); return memory.createCollection(input); },
      (_before, _after, created) => [createIntent("collection", created)],
    );
  }

  updateCollection(id: string, input: Partial<Pick<Collection, "name">>): Promise<void> {
    return this.mutate(
      (memory, before) => { requireEditable(before.collections, id, "Collection"); return memory.updateCollection(id, input); },
      () => [{ entity: "collection", entityId: id, action: "update", payload: input }],
    );
  }

  deleteCollection(id: string): Promise<void> {
    return this.mutate(
      (memory, before) => { requireEditable(before.collections, id, "Collection"); return memory.deleteCollection(id); },
      () => [{ entity: "collection", entityId: id, action: "delete", payload: {} }],
    );
  }

  createLink(input: CreateLinkInput): Promise<SavedLink> {
    if (!isSaveableUrl(input.url)) return Promise.reject(new Error("Only http and https links can be saved."));
    return this.mutate(
      (memory, before) => { requireEditable(before.collections, input.collection_id, "Collection"); return memory.createLink(input); },
      (_before, _after, created) => [createIntent("link", created)],
    );
  }

  createLinks(input: CreateLinkInput[]): Promise<void> {
    if (!input.every((item) => isSaveableUrl(item.url))) return Promise.reject(new Error("Only http and https links can be saved."));
    return this.mutate(
      async (memory, before) => {
        for (const item of input) requireEditable(before.collections, item.collection_id, "Collection");
        await memory.createLinks(input);
      },
      (before, after) => {
        const previousIds = new Set(before.links.map((item) => item.id));
        return after.links.filter((item) => !previousIds.has(item.id)).map((item) => createIntent("link", item));
      },
    );
  }

  updateLink(id: string, input: Partial<CreateLinkInput>): Promise<void> {
    if (input.url && !isSaveableUrl(input.url)) return Promise.reject(new Error("Only http and https links can be saved."));
    return this.mutate(
      (memory, before) => {
        requireEditable(before.links, id, "Link");
        if (input.collection_id) requireEditable(before.collections, input.collection_id, "Collection");
        return memory.updateLink(id, input);
      },
      () => [{ entity: "link", entityId: id, action: "update", payload: input }],
    );
  }

  deleteLink(id: string): Promise<void> {
    return this.mutate(
      (memory, before) => { requireEditable(before.links, id, "Link"); return memory.deleteLink(id); },
      () => [{ entity: "link", entityId: id, action: "delete", payload: {} }],
    );
  }

  reorderCollections(spaceId: string, orderedIds: string[]): Promise<void> {
    return this.mutate(
      (memory, before) => {
        requireEditable(before.spaces, spaceId, "Space");
        for (const id of orderedIds) requireEditable(before.collections, id, "Collection");
        return memory.reorderCollections(spaceId, orderedIds);
      },
      () => [{ entity: "collection", entityId: spaceId, action: "reorder", payload: { parentId: spaceId, orderedIds } }],
    );
  }

  reorderLinks(collectionId: string, orderedIds: string[]): Promise<void> {
    return this.mutate(
      (memory, before) => {
        requireEditable(before.collections, collectionId, "Collection");
        for (const id of orderedIds) requireEditable(before.links, id, "Link");
        return memory.reorderLinks(collectionId, orderedIds);
      },
      () => [{ entity: "link", entityId: collectionId, action: "reorder", payload: { parentId: collectionId, orderedIds } }],
    );
  }
}
