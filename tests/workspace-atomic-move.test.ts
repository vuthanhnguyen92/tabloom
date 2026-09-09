import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository, SupabaseWorkspaceRepository } from "../shared/repository";

const initial = createDemoSnapshot();
const move = { id: "link-0", sourceCollectionId: "collection-plan", destinationCollectionId: "collection-design", sourceOrderedIds: ["link-1", "link-2"], destinationOrderedIds: ["link-3", "link-0", "link-4", "link-5"] };

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

  it.each([false, true])("uses one Supabase statement for both collections (reject=%s)", async (reject) => {
    let saved = structuredClone(initial);
    const writes: unknown[] = [];
    const client = { from: () => ({ upsert: async (rows: typeof initial.links) => {
      writes.push(rows);
      if (reject) return { error: { message: "row constraint" } };
      saved = { ...saved, links: saved.links.map((link) => ({ ...link, ...rows.find((row) => row.id === link.id) })) };
      return { error: null };
    } }) } as unknown as SupabaseClient;
    const repository = new SupabaseWorkspaceRepository(client, "demo-user");
    repository.load = async () => structuredClone(saved);
    if (reject) await expect(repository.moveLink(move)).rejects.toThrow("row constraint");
    else await repository.moveLink(move);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "link-0", collection_id: "collection-design", position: 1 }),
      expect.objectContaining({ id: "link-1", collection_id: "collection-plan", position: 0 }),
      expect.objectContaining({ id: "link-2", collection_id: "collection-plan", position: 1 }),
    ]));
    if (reject) expect(saved).toEqual(initial);
    else expect(saved.links.find((item) => item.id === "link-0")?.collection_id).toBe("collection-design");
  });
});
