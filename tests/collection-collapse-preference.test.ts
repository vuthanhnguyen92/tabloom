import { describe, expect, it } from "vitest";
import { CollectionCollapsePreference } from "../extension/collection-collapse-preference";

function createStorage() {
  const values: Record<string, unknown> = {};
  return {
    async get(keys: string | string[]) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => key in values).map((key) => [key, values[key]]));
    },
    async set(next: Record<string, unknown>) { Object.assign(values, next); },
    async remove(key: string) { delete values[key]; },
  };
}

const COLLAPSED_COLLECTIONS_STORAGE_KEY = "tabloom:collapsed-collections:v1";

describe("CollectionCollapsePreference", () => {
  it("remembers collapsed collections separately for local and signed-in workspaces", async () => {
    const storage = createStorage();
    const preference = new CollectionCollapsePreference(storage);

    await preference.setCollapsed("local", "collection-one", true);
    await preference.setCollapsed("account:user-1", "collection-two", true);

    const restored = new CollectionCollapsePreference(storage);
    expect(await restored.reconcile("local", ["collection-one", "collection-two"])).toEqual(new Set(["collection-one"]));
    expect(await restored.reconcile("account:user-1", ["collection-one", "collection-two"])).toEqual(new Set(["collection-two"]));
  });

  it("forgets stored collapse states after collections are deleted", async () => {
    const storage = createStorage();
    const preference = new CollectionCollapsePreference(storage);
    await preference.setCollapsed("local", "collection-deleted", true);
    await preference.setCollapsed("local", "collection-kept", true);

    expect(await preference.reconcile("local", ["collection-kept"])).toEqual(new Set(["collection-kept"]));

    const restored = new CollectionCollapsePreference(storage);
    expect(await restored.reconcile("local", ["collection-deleted", "collection-kept"])).toEqual(new Set(["collection-kept"]));
  });

  it("keeps the existing extension storage key and value shape", async () => {
    const storage = createStorage();

    await new CollectionCollapsePreference(storage).setCollapsed("local", "collection-one", true);

    await expect(storage.get(COLLAPSED_COLLECTIONS_STORAGE_KEY)).resolves.toEqual({
      [COLLAPSED_COLLECTIONS_STORAGE_KEY]: { local: ["collection-one"] },
    });
  });

  it("persists concurrent updates through the legacy aggregate extension record", async () => {
    const storage = createStorage();
    const preference = new CollectionCollapsePreference(storage);

    await Promise.all([
      preference.setCollapsed("local", "collection-one", true),
      preference.setCollapsed("local", "collection-two", true),
    ]);

    const restored = new CollectionCollapsePreference(storage);
    expect(await restored.reconcile("local", ["collection-one", "collection-two"]))
      .toEqual(new Set(["collection-one", "collection-two"]));
    await expect(storage.get(COLLAPSED_COLLECTIONS_STORAGE_KEY)).resolves.toEqual({
      [COLLAPSED_COLLECTIONS_STORAGE_KEY]: { local: ["collection-one", "collection-two"] },
    });
  });
});
