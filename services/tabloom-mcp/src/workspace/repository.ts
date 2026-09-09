import { z } from "zod";
import type { TabloomRequestContext } from "../auth/request-context";
import type { WorkspaceSnapshot } from "../../../../shared/domain";
import { isWorkspaceOperation, type WorkspaceOperation } from "../../../../shared/workspace-operations";
import { commandError, mapWorkspaceCommandError } from "./errors";
import { versionedWorkspaceSchema } from "./schemas";

export type WorkspaceState = { snapshot: WorkspaceSnapshot; revision: number };

const ledgerSchema = z.object({ operation_id: z.string().uuid(), device_id: z.string().uuid(), applied_revision: z.number().int().nonnegative() });
const applySchema = z.object({
  revision: z.number().int().nonnegative(),
  outcomes: z.array(z.object({ operationId: z.string().uuid(), status: z.enum(["applied", "already_applied", "deleted", "rejected"]) })),
  conflicts: z.array(z.unknown()),
});

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

  async wasApplied(operationId: string, fingerprint: string): Promise<boolean> {
    const { data, error } = await this.context.supabase.from("workspace_operations")
      .select("operation_id,device_id,applied_revision")
      .eq("user_id", this.context.userId).eq("operation_id", operationId).maybeSingle();
    if (error) throw mapWorkspaceCommandError(error);
    if (data === null) return false;
    const applied = ledgerSchema.parse(data);
    if (applied.operation_id !== operationId || applied.device_id !== fingerprint) throw commandError("conflict");
    return true;
  }

  async apply(operation: WorkspaceOperation, revision: number): Promise<void> {
    if (!isWorkspaceOperation(operation) || operation.action === "delete") throw commandError("validation_failed");
    const { data, error } = await this.context.supabase.rpc("apply_workspace_operations", {
      operations: [operation], expected_revision: revision,
    });
    if (error) throw mapWorkspaceCommandError(error);
    const result = applySchema.parse(data);
    if (result.outcomes.length !== 1 || result.outcomes[0].operationId !== operation.operationId) throw commandError("validation_failed");
    if (result.conflicts.length || result.outcomes[0].status === "rejected") throw commandError("conflict");
    if (result.outcomes[0].status === "deleted") throw commandError("not_found");
    // Always reread the ledger after a possible concurrent replay, checking the
    // persisted command fingerprint before returning any success.
    if (!await this.wasApplied(operation.operationId, operation.deviceId)) throw commandError("validation_failed");
  }
}
