import { describe, expect, it, vi } from "vitest";
import * as storageModule from "../extension/storage";

type LocalRepositoryFactory = (area: {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}) => Promise<import("../shared/repository").WorkspaceRepository>;

function memoryArea() {
  const state: Record<string, unknown> = {};
  return {
    area: {
      get: vi.fn(async (key: string) => ({ [key]: state[key] })),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(state, value); }),
    },
  };
}

function localFactory() {
  return (storageModule as typeof storageModule & { createLocalWorkspaceRepository?: LocalRepositoryFactory }).createLocalWorkspaceRepository;
}

describe("local extension workspace", () => {
  it("starts with My Space and an editable My Collection when browser storage is empty", async () => {
    const createRepository = localFactory();
    expect(createRepository).toBeTypeOf("function");
    const { area } = memoryArea();

    const snapshot = await (await createRepository!(area)).load();

    expect(snapshot.spaces).toHaveLength(1);
    expect(snapshot.spaces[0]).toMatchObject({ name: "My Space", origin: "saved", read_only: false });
    expect(snapshot.collections).toHaveLength(1);
    expect(snapshot.collections[0]).toMatchObject({
      space_id: snapshot.spaces[0].id,
      name: "My Collection",
      position: 0,
      origin: "saved",
      read_only: false,
    });
    expect(snapshot.links).toEqual([]);
  });

  it("persists every local mutation for the next new-tab session", async () => {
    const createRepository = localFactory();
    expect(createRepository).toBeTypeOf("function");
    const { area } = memoryArea();
    const first = await createRepository!(area);
    const space = (await first.load()).spaces[0];
    const collection = await first.createCollection({ space_id: space.id, name: "Read later" });
    await first.createLink({ collection_id: collection.id, url: "https://example.com/article", title: "Article", description: "", favicon_url: null });

    const restored = await (await createRepository!(area)).load();

    expect(restored.collections.map((item) => item.name)).toEqual(["My Collection", "Read later"]);
    expect(restored.links).toHaveLength(1);
    expect(restored.links[0]).toMatchObject({ title: "Article", url: "https://example.com/article" });
  });

  it("repairs an existing local space that has no collections", async () => {
    const createRepository = localFactory();
    expect(createRepository).toBeTypeOf("function");
    const { area } = memoryArea();
    const previousVersion = await createRepository!(area);
    const previousSnapshot = await previousVersion.load();
    await previousVersion.deleteCollection(previousSnapshot.collections[0].id);
    expect((await previousVersion.load()).collections).toEqual([]);

    const upgraded = await (await createRepository!(area)).load();

    expect(upgraded.collections).toHaveLength(1);
    expect(upgraded.collections[0]).toMatchObject({
      space_id: previousSnapshot.spaces[0].id,
      name: "My Collection",
      origin: "saved",
      read_only: false,
    });
  });

  it("serializes mutations from two open new-tab repositories against the latest snapshot", async () => {
    const createRepository = localFactory();
    expect(createRepository).toBeTypeOf("function");
    const { area } = memoryArea();
    const first = await createRepository!(area);
    const second = await createRepository!(area);
    const spaceId = (await first.load()).spaces[0].id;

    await Promise.all([
      first.createCollection({ space_id: spaceId, name: "From first tab" }),
      second.createCollection({ space_id: spaceId, name: "From second tab" }),
    ]);

    const restored = await (await createRepository!(area)).load();
    expect(restored.collections.map((item) => item.name)).toEqual([
      "My Collection",
      "From first tab",
      "From second tab",
    ]);
  });
});
