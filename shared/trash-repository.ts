import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceSnapshot } from "./domain";
import { SupabaseWorkspaceSyncRepository, throwWorkspaceSyncError, type WorkspaceSyncRpcError } from "./workspace-sync-repository";
import {
  decodeDeleteIntent, decodeDeleteReceipt, decodeTrashEntry, WorkspaceCommandError, CommittedRestoreRefreshError,
  type DeleteIntent, type DeleteReceipt, type TrashRootType, type TrashSource, type WorkspaceTrashEntry,
} from "./trash";

export interface WorkspaceTrashRepository {
  list(): Promise<WorkspaceTrashEntry[]>;
  prepareDelete(rootType: "space" | "collection", rootId: string): Promise<DeleteIntent>;
  deleteEntity(rootType: TrashRootType, rootId: string, source: TrashSource, operationId: string, confirmationIntentId?: string): Promise<DeleteReceipt>;
  /** CommittedRestoreRefreshError means restore succeeded but its canonical read failed. */
  restore(trashId: string, destinationId?: string): Promise<WorkspaceSnapshot>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function throwTrashError(error: WorkspaceSyncRpcError | null): void {
  if (!error) return;
  if (error.code === "P0002") throw new WorkspaceCommandError("not_found", error.message);
  if (error.code === "40001") throw new WorkspaceCommandError("conflict", error.message);
  if (error.code === "42501" && error.message === "read_only") throw new WorkspaceCommandError("read_only", error.message);
  if (error.code === "22023") throw new WorkspaceCommandError("validation_failed", error.message);
  if (error.code === "P0001" && (error.message === "confirmation_required" || error.message === "confirmation_expired")) {
    throw new WorkspaceCommandError(error.message, error.message);
  }
  throwWorkspaceSyncError(error);
}

export class SupabaseTrashRepository implements WorkspaceTrashRepository {
  constructor(private readonly client: SupabaseClient) {}

  async list(): Promise<WorkspaceTrashEntry[]> {
    const { data, error } = await this.client.rpc("list_workspace_trash");
    throwTrashError(error);
    if (!Array.isArray(data)) throw new Error("invalid trash list");
    return data.map(decodeTrashEntry);
  }

  async prepareDelete(rootType: "space" | "collection", rootId: string): Promise<DeleteIntent> {
    const { data, error } = await this.client.rpc("prepare_workspace_delete", { p_target_type: rootType, p_target_id: rootId });
    throwTrashError(error);
    return decodeDeleteIntent(data);
  }

  async deleteEntity(rootType: TrashRootType, rootId: string, source: TrashSource, operationId: string, confirmationIntentId?: string): Promise<DeleteReceipt> {
    const { data, error } = await this.client.rpc("trash_workspace_entity", {
      p_root_type: rootType, p_root_id: rootId, p_source: source, p_operation_id: operationId, p_intent_id: confirmationIntentId ?? null,
    });
    throwTrashError(error);
    return decodeDeleteReceipt(data);
  }

  async restore(trashId: string, destinationId?: string): Promise<WorkspaceSnapshot> {
    const { data, error } = await this.client.rpc("restore_workspace_trash", { p_trash_id: trashId, p_destination_id: destinationId ?? null });
    throwTrashError(error);
    if (!data || typeof data !== "object" || Array.isArray(data)
      || data.trashId !== trashId || !["space", "collection", "link"].includes(data.rootType)
      || typeof data.rootId !== "string" || !UUID.test(data.rootId)
      || !UUID.test(data.trashId)
      || Object.keys(data).length !== 5
      || !["status", "trashId", "rootType", "rootId"].every((key) => Object.hasOwn(data, key))) throw new Error("invalid trash restore response");
    if (data.status === "destination_required" && ["space", "collection"].includes(data.destinationType)) {
      throw new WorkspaceCommandError("destination_required", "Choose a destination to restore this item.", { destinationType: data.destinationType });
    }
    if (data.status !== "restored" || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error("invalid trash restore response");
    try { return (await new SupabaseWorkspaceSyncRepository(this.client).loadVersioned()).snapshot; }
    catch (cause) { throw new CommittedRestoreRefreshError(trashId, { cause }); }
  }
}
