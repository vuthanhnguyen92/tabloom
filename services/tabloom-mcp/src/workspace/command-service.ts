import { createHash } from "node:crypto";
import { z } from "zod";
import { searchWorkspace, type Collection, type SavedLink, type Space, type WorkspaceRecordMeta, type WorkspaceSnapshot } from "../../../../shared/domain";
import type { WorkspaceOperation } from "../../../../shared/workspace-operations";
import type { TabloomRequestContext } from "../auth/request-context";
import { commandError, WorkspaceCommandError, workspaceCommand } from "./errors";
import { WorkspaceCommandRepository, type WorkspaceState } from "./repository";
import * as schemas from "./schemas";

type RecordType = Space | Collection | SavedLink;
type OperationBody = WorkspaceOperation extends infer O ? O extends WorkspaceOperation ? Pick<O, "entity" | "entityId" | "action" | "payload"> : never : never;
const editable = (item: WorkspaceRecordMeta) => item.origin === "saved" && !item.read_only;
const ordered = <T extends { position: number; id: string }>(items: T[]): T[] => [...items].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
const fields = <T extends Record<string, unknown>>(value: T, keys: string[]) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
const commandId = z.string().uuid().transform((value) => value.toLowerCase());
export const destructiveCommandSchemas = {
  prepareDeleteSpace: z.strictObject({ spaceId: commandId }),
  prepareDeleteCollection: z.strictObject({ collectionId: commandId }),
  confirmDelete: z.strictObject({ intentId: commandId }),
  deleteCollectionItem: z.strictObject({ itemId: commandId, expectedUpdatedAt: z.string().datetime({ offset: true }), idempotencyKey: commandId }),
  listTrash: z.strictObject({}),
  restoreTrashItem: z.strictObject({ trashId: commandId, destinationId: commandId.optional() }),
};

function uuidFor(value: unknown): string {
  const hex = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function visible(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const spaces = ordered(snapshot.spaces.filter(editable));
  const spaceIds = new Set(spaces.map((item) => item.id));
  const collections = ordered(snapshot.collections.filter((item) => editable(item) && spaceIds.has(item.space_id)));
  const collectionIds = new Set(collections.map((item) => item.id));
  const links = ordered(snapshot.links.filter((item) => editable(item) && collectionIds.has(item.collection_id)));
  return { spaces, collections, links };
}

function requireRecord<T extends RecordType>(items: T[], id: string, expectedUpdatedAt?: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw commandError("not_found");
  if (!editable(item)) throw commandError("read_only");
  // Compare exact server timestamps, preserving PostgreSQL submillisecond precision.
  if (expectedUpdatedAt !== undefined && item.updated_at !== expectedUpdatedAt) {
    throw commandError("conflict", { id: item.id, updatedAt: item.updated_at });
  }
  return item;
}

function requireSpace(snapshot: WorkspaceSnapshot, id: string, timestamp?: string): Space {
  return requireRecord(snapshot.spaces, id, timestamp);
}
function requireCollection(snapshot: WorkspaceSnapshot, id: string, timestamp?: string): Collection {
  const item = requireRecord(snapshot.collections, id, timestamp);
  requireSpace(snapshot, item.space_id);
  return item;
}
function requireItem(snapshot: WorkspaceSnapshot, id: string, timestamp?: string): SavedLink {
  const item = requireRecord(snapshot.links, id, timestamp);
  requireCollection(snapshot, item.collection_id);
  return item;
}

function requireTree(snapshot: WorkspaceSnapshot, type: "space" | "collection", id: string): void {
  if (type === "space") requireSpace(snapshot, id);
  else requireCollection(snapshot, id);
  const collections = snapshot.collections.filter((item) => type === "space" ? item.space_id === id : item.id === id);
  const ids = new Set(collections.map((item) => item.id));
  if ([...collections, ...snapshot.links.filter((item) => ids.has(item.collection_id))].some((item) => !editable(item))) throw commandError("read_only");
}

export class WorkspaceCommandService {
  private readonly repository: WorkspaceCommandRepository;

  constructor(private readonly context: TabloomRequestContext) {
    this.repository = new WorkspaceCommandRepository(context);
  }

  private read<I, O>(schema: z.ZodType<I>, input: unknown, select: (state: WorkspaceState, input: I) => O): Promise<O> {
    return workspaceCommand(async () => {
      const parsed = schemas.parseCommand(schema, input);
      return select(await this.repository.load(), parsed);
    });
  }

  getWorkspace(input: unknown = {}) {
    return this.read(schemas.getWorkspaceSchema, input, (state) => ({ revision: state.revision, snapshot: visible(state.snapshot) }));
  }
  listSpaces(input: unknown = {}) {
    return this.read(schemas.listSpacesSchema, input, (state) => visible(state.snapshot).spaces);
  }
  listCollections(input: unknown) {
    return this.read(schemas.listCollectionsSchema, input, ({ snapshot }, value) => {
      requireSpace(snapshot, value.spaceId);
      return visible(snapshot).collections.filter((item) => item.space_id === value.spaceId);
    });
  }
  listCollectionItems(input: unknown) {
    return this.read(schemas.listCollectionItemsSchema, input, ({ snapshot }, value) => {
      requireCollection(snapshot, value.collectionId);
      return visible(snapshot).links.filter((item) => item.collection_id === value.collectionId);
    });
  }
  searchWorkspace(input: unknown) {
    return this.read(schemas.searchWorkspaceSchema, input, ({ snapshot }, value) => searchWorkspace(visible(snapshot), value.query));
  }

  prepareDeleteSpace(input: unknown) {
    return workspaceCommand(async () => {
      const value = schemas.parseCommand(destructiveCommandSchemas.prepareDeleteSpace, input);
      requireTree((await this.repository.load()).snapshot, "space", value.spaceId);
      return this.repository.prepareDelete("space", value.spaceId);
    });
  }

  prepareDeleteCollection(input: unknown) {
    return workspaceCommand(async () => {
      const value = schemas.parseCommand(destructiveCommandSchemas.prepareDeleteCollection, input);
      requireTree((await this.repository.load()).snapshot, "collection", value.collectionId);
      return this.repository.prepareDelete("collection", value.collectionId);
    });
  }

  confirmDeleteSpace(input: unknown) { return this.confirmDelete("space", input); }
  confirmDeleteCollection(input: unknown) { return this.confirmDelete("collection", input); }

  private confirmDelete(type: "space" | "collection", input: unknown) {
    return workspaceCommand(async () => {
      const { intentId } = schemas.parseCommand(destructiveCommandSchemas.confirmDelete, input);
      const id = await this.repository.deleteIntentTarget(intentId, type);
      const operationId = uuidFor(["tabloom-mcp-delete", this.context.userId, type, intentId]);
      // The database resolves absent targets and completed retries. Only validate
      // live metadata here; never replace its locked intent/fingerprint checks.
      const { snapshot } = await this.repository.load();
      if ((type === "space" ? snapshot.spaces : snapshot.collections).some((item) => item.id === id)) requireTree(snapshot, type, id);
      return this.repository.delete(type, id, operationId, intentId);
    });
  }

  deleteCollectionItem(input: unknown) {
    return workspaceCommand(async () => {
      const value = schemas.parseCommand(destructiveCommandSchemas.deleteCollectionItem, input);
      const previous = await this.repository.replayDelete(value.idempotencyKey, value.itemId);
      if (previous) return previous;
      try {
        requireItem((await this.repository.load()).snapshot, value.itemId, value.expectedUpdatedAt);
        return await this.repository.deleteLink(value.itemId, value.expectedUpdatedAt, value.idempotencyKey);
      } catch (error) {
        // Receipt and mutation commit atomically in the Trash RPC. Recover a
        // lost response or a concurrent identical deletion before reporting failure.
        const completed = await this.repository.replayDelete(value.idempotencyKey, value.itemId);
        if (completed) return completed;
        throw error;
      }
    });
  }

  listTrash(input: unknown = {}) {
    return workspaceCommand(async () => {
      schemas.parseCommand(destructiveCommandSchemas.listTrash, input);
      return this.repository.listTrash();
    });
  }

  restoreTrashItem(input: unknown) {
    return workspaceCommand(async () => {
      const value = schemas.parseCommand(destructiveCommandSchemas.restoreTrashItem, input);
      const trash = await this.repository.getTrash(value.trashId);
      if (trash.restoredAt === null) {
        if (trash.rootType === "space") {
          if (value.destinationId) throw commandError("validation_failed");
        } else {
          const { snapshot } = await this.repository.load();
          if (trash.rootType === "collection") {
            const root = trash.snapshot.collections.find((item) => item.id === trash.rootId)!;
            const parentId = value.destinationId ?? root.space_id;
            if (value.destinationId || snapshot.spaces.some((item) => item.id === parentId)) requireSpace(snapshot, parentId);
          } else {
            const root = trash.snapshot.links.find((item) => item.id === trash.rootId)!;
            const parentId = value.destinationId ?? root.collection_id;
            if (value.destinationId || snapshot.collections.some((item) => item.id === parentId)) requireCollection(snapshot, parentId);
          }
        }
      }
      const result = await this.repository.restore(trash, value.destinationId);
      if (result.status === "destination_required") return result;
      const current = await this.repository.load();
      return { ...result, revision: current.revision, snapshot: visible(current.snapshot) };
    });
  }

  private mutate<I extends { idempotencyKey: string }, O>(
    name: string, schema: z.ZodType<I>, input: unknown,
    prepare: (state: WorkspaceState, input: I, newId: string) => OperationBody | OperationBody[],
    result: (snapshot: WorkspaceSnapshot, input: I, newId: string) => O,
  ): Promise<O> {
    return workspaceCommand(async () => {
      const parsed = schemas.parseCommand(schema, input);
      const operationId = parsed.idempotencyKey;
      const entityId = uuidFor(["tabloom-mcp-entity", this.context.userId, operationId]);
      const fingerprint = createHash("sha256").update(JSON.stringify([name, parsed])).digest("hex");
      const deviceId = uuidFor(["tabloom-mcp-client", this.context.userId, this.context.clientId]);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const receipt = await this.repository.replay(operationId, name, fingerprint);
        if (receipt) return result(receipt.snapshot, parsed, entityId);
        const state = await this.repository.load();
        try {
          const body = prepare(state, parsed, entityId);
          const operations = (Array.isArray(body) ? body : [body]).map((part, index) => ({ ...part,
            operationId: index === 0 ? operationId : uuidFor(["tabloom-mcp-batch", this.context.userId, operationId, index]),
            deviceId, sequence: index + 1, baseRevision: state.revision, createdAt: new Date().toISOString(),
          } as WorkspaceOperation));
          const response = await this.repository.apply(operations, state.revision, name, fingerprint);
          return result(response.snapshot, parsed, entityId);
        }
        catch (error) {
          // Another request may have committed after our receipt lookup, or the
          // RPC response may have been lost after commit. Recover its exact result.
          const completed = await this.repository.replay(operationId, name, fingerprint);
          if (completed) return result(completed.snapshot, parsed, entityId);
          if (attempt === 0 && error instanceof WorkspaceCommandError && error.code === "conflict") continue;
          throw error;
        }
      }
      throw commandError("conflict");
    });
  }

  createSpace(input: unknown) {
    return this.mutate("createSpace", schemas.createSpaceSchema, input, ({ snapshot }, value, id) => {
      if (snapshot.spaces.some((item) => item.id === id)) throw commandError("conflict");
      const timestamp = new Date().toISOString();
      return { entity: "space", entityId: id, action: "create", payload: { id, name: value.name, color: value.color, position: Math.max(-1, ...snapshot.spaces.map((item) => item.position)) + 1, created_at: timestamp, updated_at: timestamp } };
    }, (snapshot, _value, id) => requireSpace(snapshot, id));
  }
  updateSpace(input: unknown) {
    return this.mutate("updateSpace", schemas.updateSpaceSchema, input, ({ snapshot }, value) => {
      requireSpace(snapshot, value.spaceId, value.expectedUpdatedAt);
      return { entity: "space", entityId: value.spaceId, action: "update", payload: fields(value, ["name", "color"]) };
    }, (snapshot, value) => requireSpace(snapshot, value.spaceId));
  }
  createCollection(input: unknown) {
    return this.mutate("createCollection", schemas.createCollectionSchema, input, ({ snapshot }, value, id) => {
      requireSpace(snapshot, value.spaceId);
      if (snapshot.collections.some((item) => item.id === id)) throw commandError("conflict");
      const timestamp = new Date().toISOString();
      return { entity: "collection", entityId: id, action: "create", payload: { id, space_id: value.spaceId, name: value.name, position: Math.max(-1, ...snapshot.collections.filter((item) => item.space_id === value.spaceId).map((item) => item.position)) + 1, created_at: timestamp, updated_at: timestamp } };
    }, (snapshot, _value, id) => requireCollection(snapshot, id));
  }
  updateCollection(input: unknown) {
    return this.mutate("updateCollection", schemas.updateCollectionSchema, input, ({ snapshot }, value) => {
      requireCollection(snapshot, value.collectionId, value.expectedUpdatedAt);
      return { entity: "collection", entityId: value.collectionId, action: "update", payload: { name: value.name } };
    }, (snapshot, value) => requireCollection(snapshot, value.collectionId));
  }
  createCollectionItem(input: unknown) {
    return this.mutate("createCollectionItem", schemas.createCollectionItemSchema, input, ({ snapshot }, value, id) => {
      requireCollection(snapshot, value.collectionId);
      if (snapshot.links.some((item) => item.id === id)) throw commandError("conflict");
      const timestamp = new Date().toISOString();
      return { entity: "link", entityId: id, action: "create", payload: { id, collection_id: value.collectionId, title: value.title, url: value.url, description: value.description, favicon_url: null, position: Math.max(-1, ...snapshot.links.filter((item) => item.collection_id === value.collectionId).map((item) => item.position)) + 1, created_at: timestamp, updated_at: timestamp } };
    }, (snapshot, _value, id) => requireItem(snapshot, id));
  }
  updateCollectionItem(input: unknown) {
    return this.mutate("updateCollectionItem", schemas.updateCollectionItemSchema, input, ({ snapshot }, value) => {
      requireItem(snapshot, value.itemId, value.expectedUpdatedAt);
      return { entity: "link", entityId: value.itemId, action: "update", payload: fields(value, ["title", "description", "url"]) };
    }, (snapshot, value) => requireItem(snapshot, value.itemId));
  }
  moveCollectionItem(input: unknown) {
    return this.mutate("moveCollectionItem", schemas.moveCollectionItemSchema, input, ({ snapshot }, value) => {
      const item = requireItem(snapshot, value.itemId, value.expectedUpdatedAt);
      requireCollection(snapshot, value.destinationCollectionId);
      const parentIds = [...new Set([item.collection_id, value.destinationCollectionId])];
      const members = snapshot.links.filter((link) => parentIds.includes(link.collection_id));
      if (members.some((link) => !editable(link))) throw commandError("read_only");
      const reorders: OperationBody[] = parentIds.map((parentId) => ({
        entity: "link", entityId: parentId, action: "reorder", payload: {
          parentId,
          orderedIds: [
            ...ordered(members.filter((link) => link.collection_id === parentId && link.id !== item.id)).map((link) => link.id),
            ...(parentId === value.destinationCollectionId ? [item.id] : []),
          ],
        },
      }));
      return [{ entity: "link", entityId: value.itemId, action: "update", payload: { collection_id: value.destinationCollectionId } }, ...reorders];
    }, (snapshot, value) => requireItem(snapshot, value.itemId));
  }
  reorderCollectionItems(input: unknown) {
    return this.mutate("reorderCollectionItems", schemas.reorderCollectionItemsSchema, input, ({ snapshot, revision }, value) => {
      requireCollection(snapshot, value.collectionId);
      if (value.expectedRevision !== revision) throw commandError("conflict", { revision });
      const members = snapshot.links.filter((item) => item.collection_id === value.collectionId);
      if (members.some((item) => !editable(item))) throw commandError("read_only");
      const ids = new Set(members.map((item) => item.id));
      if (ids.size !== value.orderedIds.length || value.orderedIds.some((id) => !ids.has(id))) throw commandError("validation_failed");
      return { entity: "link", entityId: value.collectionId, action: "reorder", payload: { parentId: value.collectionId, orderedIds: value.orderedIds } };
    }, (snapshot, value) => {
      requireCollection(snapshot, value.collectionId);
      return ordered(snapshot.links.filter((item) => item.collection_id === value.collectionId && editable(item)));
    });
  }
}
