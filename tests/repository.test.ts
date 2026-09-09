import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";
import { SupabaseWorkspaceRepository } from "../shared/repository";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WorkspaceCommandError } from "../shared/trash";

const OPERATION_ID = "40000000-0000-4000-8000-000000000001";
const TRASH_ID = "60000000-0000-4000-8000-000000000001";
const LINK_ID = "30000000-0000-4000-8000-000000000001";
const receipt = { operationId: OPERATION_ID, trashId: TRASH_ID, rootType: "link", rootId: LINK_ID, restoreUntil: "2026-10-10T00:00:00Z" };

async function trashRepository(data: unknown, error: { code: string; message: string } | null = null) {
  const calls: unknown[][] = [];
  const client = { rpc: async (...args: unknown[]) => { calls.push(args); return { data, error }; } } as unknown as SupabaseClient;
  const { SupabaseTrashRepository } = await import("../shared/trash-repository");
  return { repository: new SupabaseTrashRepository(client), calls };
}

describe("SupabaseTrashRepository", () => {
  it("deletes a saved link through the recoverable RPC and returns its explicit receipt", async () => {
    const { repository, calls } = await trashRepository(receipt);
    await expect(repository.deleteEntity("link", LINK_ID, "web", OPERATION_ID)).resolves.toEqual(receipt);
    expect(calls).toEqual([["trash_workspace_entity", { p_root_type: "link", p_root_id: LINK_ID, p_source: "web", p_operation_id: OPERATION_ID, p_intent_id: null }]]);
  });

  it("prepares a container deletion and passes its intent to deletion", async () => {
    const intent = { intentId: TRASH_ID, targetType: "collection", targetId: LINK_ID, targetName: "Read", collectionCount: 1, linkCount: 2, expiresAt: "2099-01-01T00:00:00Z" };
    const prepared = await trashRepository(intent);
    await expect(prepared.repository.prepareDelete("collection", LINK_ID)).resolves.toEqual(intent);
    expect(prepared.calls).toEqual([["prepare_workspace_delete", { p_target_type: "collection", p_target_id: LINK_ID }]]);
    const deleted = await trashRepository({ ...receipt, rootType: "collection" });
    await deleted.repository.deleteEntity("collection", LINK_ID, "web", OPERATION_ID, TRASH_ID);
    expect(deleted.calls[0]).toEqual(["trash_workspace_entity", { p_root_type: "collection", p_root_id: LINK_ID, p_source: "web", p_operation_id: OPERATION_ID, p_intent_id: TRASH_ID }]);
  });

  it("lists active entries through the strict decoder", async () => {
    const { repository, calls } = await trashRepository([]);
    await expect(repository.list()).resolves.toEqual([]);
    expect(calls).toEqual([["list_workspace_trash"]]);
    const malformed = await trashRepository([{ id: TRASH_ID }]);
    await expect(malformed.repository.list()).rejects.toThrow("invalid trash entry");
  });

  it("rejects malformed delete receipts", async () => {
    const { repository } = await trashRepository({ ...receipt, unexpected: true });
    await expect(repository.deleteEntity("link", LINK_ID, "web", OPERATION_ID)).rejects.toThrow("invalid delete receipt");
  });

  it.each([
    ["P0002", "workspace link not found", "not_found"],
    ["P0001", "confirmation_required", "confirmation_required"],
    ["P0001", "confirmation_expired", "confirmation_expired"],
    ["40001", "workspace operation conflict", "conflict"],
    ["42501", "read_only", "read_only"],
    ["22023", "invalid request", "validation_failed"],
  ])("maps %s %s to a workspace command error", async (code, message, expected) => {
    const { repository } = await trashRepository(null, { code, message });
    await expect(repository.deleteEntity("link", LINK_ID, "web", OPERATION_ID)).rejects.toMatchObject({ name: "WorkspaceCommandError", code: expected });
  });

  it("reports a missing restore destination without silently loading a snapshot", async () => {
    const { repository, calls } = await trashRepository({ status: "destination_required", trashId: TRASH_ID, rootType: "link", rootId: LINK_ID, destinationType: "collection" });
    await expect(repository.restore(TRASH_ID)).rejects.toBeInstanceOf(WorkspaceCommandError);
    expect(calls).toEqual([["restore_workspace_trash", { p_trash_id: TRASH_ID, p_destination_id: null }]]);
  });

  it("restores with an explicit destination then loads the canonical snapshot", async () => {
    const calls: unknown[][] = [];
    const client = { rpc: async (...args: unknown[]) => {
      calls.push(args);
      return { error: null, data: args[0] === "restore_workspace_trash"
        ? { status: "restored", trashId: TRASH_ID, rootType: "link", rootId: LINK_ID, revision: 8 }
        : { revision: 8, snapshot: { spaces: [], collections: [], links: [] }, tombstones: [] } };
    } } as unknown as SupabaseClient;
    const { SupabaseTrashRepository } = await import("../shared/trash-repository");
    await expect(new SupabaseTrashRepository(client).restore(TRASH_ID, LINK_ID)).resolves.toEqual({ spaces: [], collections: [], links: [] });
    expect(calls).toEqual([["restore_workspace_trash", { p_trash_id: TRASH_ID, p_destination_id: LINK_ID }], ["load_workspace_snapshot"]]);
  });

  it.each([
    { rootId: "bad" }, { unexpected: true }, { rootType: "unknown" }, { revision: -1 },
  ])("rejects malformed restore responses before loading canonical data", async (override) => {
    const { repository, calls } = await trashRepository({ status: "restored", trashId: TRASH_ID, rootType: "link", rootId: LINK_ID, revision: 8, ...override });
    await expect(repository.restore(TRASH_ID)).rejects.toThrow("invalid trash restore response");
    expect(calls).toHaveLength(1);
  });

  it.each(["deleteSpace", "deleteCollection", "deleteLink"] as const)("fails closed for legacy Supabase %s without issuing a table deletion", async (method) => {
    const calls: unknown[] = [];
    const client = { from: (...args: unknown[]) => { calls.push(args); throw new Error("direct table access"); } } as unknown as SupabaseClient;
    await expect(new SupabaseWorkspaceRepository(client, "owner")[method](LINK_ID)).rejects.toThrow("Use WorkspaceTrashRepository.deleteEntity");
    expect(calls).toEqual([]);
  });
});

describe("MemoryWorkspaceRepository", () => {
  it("creates spaces, collections, and links with user ownership", async () => {
    const repository = new MemoryWorkspaceRepository("user-2", { spaces: [], collections: [], links: [] });
    const space = await repository.createSpace({ name: "New space", color: "#f56f72" });
    const collection = await repository.createCollection({ space_id: space.id, name: "Read" });
    const link = await repository.createLink({ collection_id: collection.id, title: "Example", url: "https://example.com", description: "", favicon_url: null });
    expect(space.user_id).toBe("user-2");
    expect(collection.space_id).toBe(space.id);
    expect(link.collection_id).toBe(collection.id);
  });

  it("cascades collection deletion to links", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
    await repository.deleteCollection("collection-plan");
    const snapshot = await repository.load();
    expect(snapshot.collections.some((item) => item.id === "collection-plan")).toBe(false);
    expect(snapshot.links.some((item) => item.collection_id === "collection-plan")).toBe(false);
  });

  it("persists cross-collection link ordering", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
    await repository.reorderLinks("collection-design", ["link-0", "link-3"]);
    const snapshot = await repository.load();
    expect(snapshot.links.find((item) => item.id === "link-0")?.collection_id).toBe("collection-design");
    expect(snapshot.links.find((item) => item.id === "link-0")?.position).toBe(0);
    expect(snapshot.links.find((item) => item.id === "link-3")?.position).toBe(1);
  });
});
