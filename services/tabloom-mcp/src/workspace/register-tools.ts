import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WorkspaceCommandService, destructiveCommandSchemas } from "./command-service";
import * as schemas from "./schemas";
import { requireWorkspaceContext, toolResult, workspaceToolError, type WorkspaceToolLog } from "./tool-result";

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const rootType = z.enum(["space", "collection", "link"]);
// Output schemas describe the canonical values, without input-only UUID transforms.
const space = schemas.workspaceSnapshotSchema.shape.spaces.element.extend({ id, user_id: id });
const collection = schemas.workspaceSnapshotSchema.shape.collections.element.extend({ id, user_id: id, space_id: id });
const item = schemas.workspaceSnapshotSchema.shape.links.element.extend({ id, user_id: id, collection_id: id });
const snapshot = z.object({ spaces: z.array(space), collections: z.array(collection), links: z.array(item) });
const workspace = schemas.versionedWorkspaceSchema.extend({ snapshot });
const intent = z.object({
  intentId: id, targetType: z.enum(["space", "collection"]), targetId: id, targetName: z.string(),
  collectionCount: z.number().int().nonnegative(), linkCount: z.number().int().nonnegative(), expiresAt: timestamp,
});
const receipt = z.object({ operationId: id, trashId: id, rootType, rootId: id, restoreUntil: timestamp });
const trash = z.object({
  id, rootType, rootId: id, rootName: z.string(), source: z.enum(["web", "extension", "mcp"]),
  deletedAt: timestamp, expiresAt: timestamp, restoredAt: timestamp.nullable(),
  snapshot: snapshot.extend({ version: z.literal(1), rootType }),
});
const restoreIdentity = { trashId: id, rootType, rootId: id };
const restore = z.discriminatedUnion("status", [
  z.object({ ...restoreIdentity, status: z.literal("restored"), ...workspace.shape }),
  z.object({ ...restoreIdentity, status: z.literal("destination_required"), destinationType: z.enum(["space", "collection"]) }),
]);

type ToolOptions = {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  targetType: WorkspaceToolLog["targetType"];
  targetKey?: string;
};

/** Registration is shared; authenticated clients and command services are never cached. */
export function registerWorkspaceTools(server: McpServer, config: { mutationsEnabled: boolean }) {
  function register(
    name: string, method: keyof WorkspaceCommandService, inputSchema: z.ZodType, resultSchema: z.ZodType,
    summary: string, options: ToolOptions,
  ) {
    if (!options.readOnly && !config.mutationsEnabled) return;
    const outputSchema = z.object({ data: resultSchema });
    server.registerTool(name, {
      title: name.replaceAll("_", " "), description: summary, inputSchema, outputSchema,
      annotations: {
        readOnlyHint: options.readOnly ?? false, destructiveHint: options.destructive ?? false,
        idempotentHint: options.idempotent ?? true, openWorldHint: false,
      },
    }, async (input, ctx) => {
      const metadata: WorkspaceToolLog = { action: name, targetType: options.targetType, targetId: null, userId: null, clientId: null };
      try {
        const context = requireWorkspaceContext(ctx.http?.authInfo);
        metadata.userId = context.userId;
        metadata.clientId = context.clientId;
        // Inputs are validated by the SDK and again by the command service.
        if (options.targetKey && input && typeof input === "object") {
          const target = Reflect.get(input, options.targetKey);
          metadata.targetId = id.safeParse(target).success ? String(target) : null;
        }
        const service = new WorkspaceCommandService(context);
        const value = await service[method](input);
        // Re-parse the public result to strip undeclared fields at the MCP boundary.
        return toolResult(summary, outputSchema.parse({ data: value }));
      } catch (error) {
        return workspaceToolError(error, metadata);
      }
    });
  }

  register("get_workspace", "getWorkspace", schemas.getWorkspaceSchema, workspace,
    "Read the saved workspace and its current revision.", { readOnly: true, targetType: "workspace" });
  register("list_spaces", "listSpaces", schemas.listSpacesSchema, z.array(space),
    "List saved workspace spaces.", { readOnly: true, targetType: "space" });
  register("list_collections", "listCollections", schemas.listCollectionsSchema, z.array(collection),
    "List collections in a saved space.", { readOnly: true, targetType: "space", targetKey: "spaceId" });
  register("list_collection_items", "listCollectionItems", schemas.listCollectionItemsSchema, z.array(item),
    "List saved links in a collection.", { readOnly: true, targetType: "collection", targetKey: "collectionId" });
  register("search_workspace", "searchWorkspace", schemas.searchWorkspaceSchema,
    z.array(z.object({ link: item, collection, space, score: z.number() })),
    "Search the saved workspace for links.", { readOnly: true, targetType: "workspace" });
  register("list_trash", "listTrash", destructiveCommandSchemas.listTrash, z.array(trash),
    "List recoverable workspace Trash entries and their expiry times.", { readOnly: true, targetType: "trash" });

  register("create_space", "createSpace", schemas.createSpaceSchema, space,
    "Create a saved space. Reuse the same idempotencyKey when retrying.", { targetType: "space" });
  register("update_space", "updateSpace", schemas.updateSpaceSchema, space,
    "Update a saved space using its current updated_at as expectedUpdatedAt. Reuse the same idempotencyKey when retrying.", { targetType: "space", targetKey: "spaceId" });
  register("create_collection", "createCollection", schemas.createCollectionSchema, collection,
    "Create a collection in a saved space. Reuse the same idempotencyKey when retrying.", { targetType: "space", targetKey: "spaceId" });
  register("update_collection", "updateCollection", schemas.updateCollectionSchema, collection,
    "Rename a collection using its current updated_at as expectedUpdatedAt. Reuse the same idempotencyKey when retrying.", { targetType: "collection", targetKey: "collectionId" });
  register("create_collection_item", "createCollectionItem", schemas.createCollectionItemSchema, item,
    "Create a saved link. Reuse the same idempotencyKey when retrying.", { targetType: "collection", targetKey: "collectionId" });
  register("update_collection_item", "updateCollectionItem", schemas.updateCollectionItemSchema, item,
    "Update a saved link using its current updated_at as expectedUpdatedAt. Reuse the same idempotencyKey when retrying.", { targetType: "link", targetKey: "itemId" });
  register("move_collection_item", "moveCollectionItem", schemas.moveCollectionItemSchema, item,
    "Move a saved link to another collection using its current updated_at as expectedUpdatedAt. Reuse the same idempotencyKey when retrying.", { targetType: "link", targetKey: "itemId" });
  register("reorder_collection_items", "reorderCollectionItems", schemas.reorderCollectionItemsSchema, z.array(item),
    "Reorder all links in a collection using the current workspace revision. Reuse the same idempotencyKey when retrying.", { targetType: "collection", targetKey: "collectionId" });
  register("prepare_delete_space", "prepareDeleteSpace", destructiveCommandSchemas.prepareDeleteSpace, intent,
    "Prepare deletion and return affected counts. Ask the user to confirm this deletion before calling confirm_delete_space with the returned intentId.",
    { targetType: "space", targetKey: "spaceId", idempotent: false });
  register("prepare_delete_collection", "prepareDeleteCollection", destructiveCommandSchemas.prepareDeleteCollection, intent,
    "Prepare deletion and return affected counts. Ask the user to confirm this deletion before calling confirm_delete_collection with the returned intentId.",
    { targetType: "collection", targetKey: "collectionId", idempotent: false });
  register("confirm_delete_space", "confirmDeleteSpace", destructiveCommandSchemas.confirmDelete, receipt,
    "After user confirmation, move the prepared space and its contents to Trash. Returns trashId and restoreUntil; retry with the same intentId.",
    { targetType: "space", destructive: true });
  register("confirm_delete_collection", "confirmDeleteCollection", destructiveCommandSchemas.confirmDelete, receipt,
    "After user confirmation, move the prepared collection and its links to Trash. Returns trashId and restoreUntil; retry with the same intentId.",
    { targetType: "collection", destructive: true });
  register("delete_collection_item", "deleteCollectionItem", destructiveCommandSchemas.deleteCollectionItem, receipt,
    "Move a saved link to Trash using its current updated_at as expectedUpdatedAt. Returns trashId and restoreUntil for restore_trash_item. Reuse the same idempotencyKey when retrying.",
    { targetType: "link", targetKey: "itemId", destructive: true });
  register("restore_trash_item", "restoreTrashItem", destructiveCommandSchemas.restoreTrashItem, restore,
    "Restore an unexpired Trash entry. If destination_required is returned, supply destinationId for an existing space (collection root) or collection (link root).",
    { targetType: "trash", targetKey: "trashId" });
}
