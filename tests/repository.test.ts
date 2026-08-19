import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

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
