import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository, SupabaseWorkspaceRepository } from "../shared/repository";

const initial = createDemoSnapshot();
const move = { id: "link-0", sourceCollectionId: "collection-plan", destinationCollectionId: "collection-design", sourceOrderedIds: ["link-1", "link-2"], destinationOrderedIds: ["link-3", "link-0", "link-4", "link-5"], expectedSource: initial.links.filter((item) => item.collection_id === "collection-plan").map(({ id, position }) => ({ id, position })), expectedDestination: initial.links.filter((item) => item.collection_id === "collection-design").map(({ id, position }) => ({ id, position })) };

describe("atomic workspace moves", () => {
  it("moves and normalizes both collections in memory and rejects stale source orders without changes", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", initial);
    await repository.moveLink(move);
    const snapshot = await repository.load();
    expect(snapshot.links.filter((item) => item.collection_id === "collection-plan").map((item) => item.position)).toEqual([0, 1]);
    expect(snapshot.links.find((item) => item.id === "link-0")).toMatchObject({ collection_id: "collection-design", position: 1 });
    await expect(repository.moveLink(move)).rejects.toThrow();
    expect(await repository.load()).toEqual(snapshot);
  });

  it("rejects a stale structural snapshot without overwriting a concurrent reorder", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", initial);
    await repository.reorderLinks("collection-plan", ["link-2", "link-1", "link-0"]);
    const reordered = await repository.load();
    await expect(repository.moveLink(move)).rejects.toThrow(/changed/i);
    expect(await repository.load()).toEqual(reordered);
  });

  it.each([null, { code: "40001", message: "workspace move structure changed" }, { code: "40P01", message: "deadlock detected" }, { code: "P0002", message: "workspace collection not found" }])("uses only the conflict-aware RPC with captured structural expectations (error=%s)", async (error) => {
    const rpc = vi.fn(async () => ({ data: error ? null : 42, error }));
    const from = vi.fn(() => { throw new Error("Moves must never read/upsert full rows"); });
    const client = { rpc, from } as unknown as SupabaseClient;
    const repository = new SupabaseWorkspaceRepository(client, "demo-user");
    if (error) await expect(repository.moveLink(move)).rejects.toMatchObject({ name: "WorkspaceConflictError" });
    else await repository.moveLink(move);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("move_workspace_link", {
      p_link_id: move.id, p_source_collection_id: move.sourceCollectionId, p_destination_collection_id: move.destinationCollectionId,
      p_expected_source: move.expectedSource, p_expected_destination: move.expectedDestination,
      p_source_ordered_ids: move.sourceOrderedIds, p_destination_ordered_ids: move.destinationOrderedIds,
    });
  });
});
