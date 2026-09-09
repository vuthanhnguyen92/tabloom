import { z } from "zod";
import type { TabloomRequestContext } from "../auth/request-context";
import type { WorkspaceSnapshot } from "../../../../shared/domain";
import { isWorkspaceOperation, type WorkspaceOperation } from "../../../../shared/workspace-operations";
import { commandError, mapWorkspaceCommandError } from "./errors";
import { versionedWorkspaceSchema } from "./schemas";

export type WorkspaceState = { snapshot: WorkspaceSnapshot; revision: number };

const receiptSchema = z.object({ operation_id: z.string().uuid(), command_name: z.string(), command_hash: z.string().regex(/^[0-9a-f]{64}$/), response: versionedWorkspaceSchema });

/** Every operation uses the caller's authenticated client; RLS is authoritative. */
export class WorkspaceCommandRepository {
  constructor(private readonly context: TabloomRequestContext) {}

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
