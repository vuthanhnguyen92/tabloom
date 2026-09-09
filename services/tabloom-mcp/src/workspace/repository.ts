import { z } from "zod";
import type { TabloomRequestContext } from "../auth/request-context";
import type { WorkspaceSnapshot } from "../../../../shared/domain";
import { isWorkspaceOperation, type WorkspaceOperation } from "../../../../shared/workspace-operations";
import { decodeDeleteIntent, decodeDeleteReceipt, decodeTrashEntry, type WorkspaceTrashEntry } from "../../../../shared/trash";
import { commandError, mapWorkspaceCommandError } from "./errors";
import { versionedWorkspaceSchema } from "./schemas";

export type WorkspaceState = { snapshot: WorkspaceSnapshot; revision: number };

const receiptSchema = z.object({ operation_id: z.string().uuid(), command_name: z.string(), command_hash: z.string().regex(/^[0-9a-f]{64}$/), response: versionedWorkspaceSchema });
const intentTargetSchema = z.object({ id: z.string().uuid(), user_id: z.string().uuid(), target_type: z.enum(["space", "collection"]), target_id: z.string().uuid() });
const trashRowSchema = z.object({ id: z.string().uuid(), user_id: z.string().uuid(), root_type: z.enum(["space", "collection", "link"]), root_id: z.string().uuid(),
  root_name: z.string(), source: z.enum(["web", "extension", "mcp"]), deleted_at: z.string(), expires_at: z.string(), restored_at: z.string().nullable(),
  created_operation_id: z.string().uuid().nullable(), snapshot: z.unknown() });
const restoreIdentity = { trashId: z.string().uuid(), rootType: z.enum(["space", "collection", "link"]), rootId: z.string().uuid() };
const restoreResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...restoreIdentity, status: z.literal("restored"), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ ...restoreIdentity, status: z.literal("destination_required"), destinationType: z.enum(["space", "collection"]) }),
]);
const trashColumns = "id,user_id,root_type,root_id,root_name,source,deleted_at,expires_at,restored_at,created_operation_id,snapshot";

/** Every operation uses the caller's authenticated client; RLS is authoritative. */
export class WorkspaceCommandRepository {
  constructor(private readonly context: TabloomRequestContext) {}

  async prepareDelete(type: "space" | "collection", id: string) {
    const { data, error } = await this.context.supabase.rpc("prepare_workspace_delete", { p_target_type: type, p_target_id: id });
    if (error) throw mapWorkspaceCommandError(error);
    const intent = decodeDeleteIntent(data);
    if (intent.targetType !== type || intent.targetId !== id) throw commandError("validation_failed");
    return intent;
  }

  async deleteIntentTarget(intentId: string, type: "space" | "collection"): Promise<string> {
    const { data, error } = await this.context.supabase.from("workspace_delete_intents")
      .select("id,user_id,target_type,target_id").eq("user_id", this.context.userId).eq("id", intentId).maybeSingle();
    if (error) throw mapWorkspaceCommandError(error);
    if (data === null) throw commandError("confirmation_required");
    const intent = intentTargetSchema.parse(data);
    if (intent.id !== intentId || intent.user_id !== this.context.userId || intent.target_type !== type) throw commandError("confirmation_required");
    // Expiry, consumption and fingerprint must be checked by the deleting RPC
    // after it takes locks. A completed operation may still replay its receipt.
    return intent.target_id;
  }

  async delete(type: "space" | "collection", id: string, operationId: string, intentId: string) {
    const { data, error } = await this.context.supabase.rpc("trash_workspace_entity", {
      p_root_type: type, p_root_id: id, p_source: "mcp", p_operation_id: operationId, p_intent_id: intentId,
    });
    if (error) throw mapWorkspaceCommandError(error);
    const receipt = decodeDeleteReceipt(data);
    if (receipt.rootType !== type || receipt.rootId !== id || receipt.operationId !== operationId) throw commandError("validation_failed");
    return receipt;
  }

  async deleteLink(id: string, expectedUpdatedAt: string, operationId: string) {
    const { data, error } = await this.context.supabase.rpc("trash_workspace_link_if_unchanged", {
      p_link_id: id, p_expected_updated_at: expectedUpdatedAt, p_operation_id: operationId,
    });
    if (error) throw mapWorkspaceCommandError(error);
    const receipt = decodeDeleteReceipt(data);
    if (receipt.rootType !== "link" || receipt.rootId !== id || receipt.operationId !== operationId) throw commandError("validation_failed");
    return receipt;
  }

  async replayDelete(operationId: string, itemId: string) {
    const { data, error } = await this.context.supabase.from("workspace_trash").select(trashColumns)
      .eq("user_id", this.context.userId).eq("created_operation_id", operationId).maybeSingle();
    if (error) throw mapWorkspaceCommandError(error);
    if (data === null) return null;
    const row = trashRowSchema.parse(data);
    if (row.user_id !== this.context.userId) throw commandError("not_found");
    if (row.created_operation_id !== operationId || row.root_type !== "link" || row.root_id !== itemId || row.source !== "mcp") throw commandError("conflict");
    return decodeDeleteReceipt({ operationId, trashId: row.id, rootType: row.root_type, rootId: row.root_id, restoreUntil: row.expires_at });
  }

  async getTrash(trashId: string): Promise<WorkspaceTrashEntry> {
    const { data, error } = await this.context.supabase.from("workspace_trash").select(trashColumns)
      .eq("user_id", this.context.userId).eq("id", trashId).maybeSingle();
    if (error) throw mapWorkspaceCommandError(error);
    if (data === null) throw commandError("not_found");
    const row = trashRowSchema.parse(data);
    if (row.user_id !== this.context.userId || row.id !== trashId) throw commandError("not_found");
    return this.validateTrash(decodeTrashEntry({ id: row.id, rootType: row.root_type, rootId: row.root_id, rootName: row.root_name,
      source: row.source, deletedAt: row.deleted_at, expiresAt: row.expires_at, restoredAt: row.restored_at, snapshot: row.snapshot }));
  }

  async listTrash(): Promise<WorkspaceTrashEntry[]> {
    const { data, error } = await this.context.supabase.rpc("list_workspace_trash");
    if (error) throw mapWorkspaceCommandError(error);
    if (!Array.isArray(data)) throw commandError("validation_failed");
    return data.map((entry) => this.validateTrash(decodeTrashEntry(entry)))
      .filter((entry) => entry.restoredAt === null && Date.parse(entry.expiresAt) > Date.now());
  }

  async restore(trash: WorkspaceTrashEntry, destinationId?: string) {
    const { data, error } = await this.context.supabase.rpc("restore_workspace_trash", { p_trash_id: trash.id, p_destination_id: destinationId ?? null });
    if (error) throw mapWorkspaceCommandError(error);
    const result = restoreResultSchema.parse(data);
    if (result.trashId !== trash.id || result.rootType !== trash.rootType || result.rootId !== trash.rootId
      || (result.status === "destination_required" && (result.rootType === "space"
        || result.destinationType !== (result.rootType === "collection" ? "space" : "collection")))) throw commandError("validation_failed");
    return result;
  }

  private validateTrash(entry: WorkspaceTrashEntry): WorkspaceTrashEntry {
    if ([...entry.snapshot.spaces, ...entry.snapshot.collections, ...entry.snapshot.links].some((item) => item.user_id !== this.context.userId)) throw commandError("validation_failed");
    return entry;
  }

  async load(): Promise<WorkspaceState> {
    // This RPC returns a transactionally consistent revision and complete saved
    // workspace, avoiding PostgREST row limits and revision/read races.
    const { data, error } = await this.context.supabase.rpc("load_workspace_snapshot");
    if (error) throw mapWorkspaceCommandError(error);
    const state = versionedWorkspaceSchema.parse(data);
    const spaces = state.snapshot.spaces.filter((item) => item.user_id === this.context.userId);
    const spaceIds = new Set(spaces.map((item) => item.id));
    const collections = state.snapshot.collections.filter((item) => item.user_id === this.context.userId && spaceIds.has(item.space_id));
    const collectionIds = new Set(collections.map((item) => item.id));
    const links = state.snapshot.links.filter((item) => item.user_id === this.context.userId && collectionIds.has(item.collection_id));
    return { revision: state.revision, snapshot: { spaces, collections, links } };
  }

  async replay(operationId: string, name: string, fingerprint: string): Promise<WorkspaceState | null> {
    const { data, error } = await this.context.supabase.from("workspace_command_receipts")
      .select("operation_id,command_name,command_hash,response")
      .eq("user_id", this.context.userId).eq("operation_id", operationId).maybeSingle();
    if (error) throw mapWorkspaceCommandError(error);
    if (data === null) return null;
    const receipt = receiptSchema.parse(data);
    if (receipt.operation_id !== operationId || receipt.command_name !== name || receipt.command_hash !== fingerprint) throw commandError("conflict");
    return this.validateReceipt(receipt.response);
  }

  async apply(operations: WorkspaceOperation[], revision: number, name: string, fingerprint: string): Promise<WorkspaceState> {
    if (!operations.length || operations.some((operation) => !isWorkspaceOperation(operation) || operation.action === "delete")) throw commandError("validation_failed");
    const { data, error } = await this.context.supabase.rpc("apply_workspace_command", {
      p_operation_id: operations[0].operationId, p_command_name: name, p_command_hash: fingerprint,
      p_operations: operations, p_expected_revision: revision,
    });
    if (error) throw mapWorkspaceCommandError(error);
    return this.validateReceipt(versionedWorkspaceSchema.parse(data));
  }

  private validateReceipt(state: WorkspaceState): WorkspaceState {
    if ([...state.snapshot.spaces, ...state.snapshot.collections, ...state.snapshot.links].some((item) => item.user_id !== this.context.userId)) throw commandError("validation_failed");
    return state;
  }
}
