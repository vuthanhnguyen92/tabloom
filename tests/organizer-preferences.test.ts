import { describe, expect, it, vi } from "vitest";
import {
  CollectionCollapsePreference,
  SelectedSpacePreference,
  createWebPreferenceStore,
  webOrganizerCapabilities,
  type OrganizerPreferenceStore,
} from "../shared/organizer";

const SPACE_1 = "space-one";
const SPACE_2 = "space-two";

function memoryPreferenceStore(initial: Record<string, string> = {}): OrganizerPreferenceStore {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
}

describe("organizer preferences", () => {
  it("loads selected space before rendering a workspace", async () => {
    const store = memoryPreferenceStore({ "tabloom:selected-space:account": SPACE_2 });
    const preference = new SelectedSpacePreference(store);

    await expect(preference.load("account", [SPACE_1, SPACE_2])).resolves.toBe(SPACE_2);
  });

  it("replaces a deleted selected space with the first available space", async () => {
    const store = memoryPreferenceStore({ "tabloom:selected-space:account": "space-deleted" });
    const preference = new SelectedSpacePreference(store);

    await expect(preference.load("account", [SPACE_1, SPACE_2])).resolves.toBe(SPACE_1);
    await expect(store.get("tabloom:selected-space:account")).resolves.toBe(SPACE_1);
  });

  it("drops collapse state for collections that no longer exist", async () => {
    const store = memoryPreferenceStore({
      "tabloom:collapsed-collections:account": JSON.stringify(["collection-deleted", "collection-kept"]),
    });
    const preference = new CollectionCollapsePreference(store);

    await expect(preference.load("account", ["collection-kept"])).resolves.toEqual(new Set(["collection-kept"]));
    await expect(store.get("tabloom:collapsed-collections:account")).resolves.toBe('["collection-kept"]');
  });

  it("preserves concurrent collapse updates after preferences are reconstructed", async () => {
    const store = memoryPreferenceStore();
    const preference = new CollectionCollapsePreference(store);

    await Promise.all([
      preference.setCollapsed("account", "collection-one", true),
      preference.setCollapsed("account", "collection-two", true),
    ]);

    const restored = new CollectionCollapsePreference(store);
    await expect(restored.load("account", ["collection-one", "collection-two"]))
      .resolves.toEqual(new Set(["collection-one", "collection-two"]));
  });

  it("adapts DOM Storage-compatible persistence without browser globals", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const store = createWebPreferenceStore(storage);

    await store.set("preference", "expanded");
    await expect(store.get("preference")).resolves.toBe("expanded");
    await store.remove("preference");
    await expect(store.get("preference")).resolves.toBeNull();
  });
});

describe("organizer capabilities", () => {
  it("uses explicit capability absence for browser-only features", () => {
    const web = webOrganizerCapabilities({ openUrl: vi.fn() });

    expect(web.currentTabs).toBeUndefined();
    expect("bookmarks" in web).toBe(false);
    expect(web.openCollection).toBeTypeOf("function");
  });

  it("opens web collections as separate new tabs", async () => {
    const openUrl = vi.fn(async () => undefined);
    const web = webOrganizerCapabilities({ openUrl });

    await web.openCollection("Reading", ["https://one.example", "https://two.example"]);

    expect(openUrl.mock.calls).toEqual([
      [{ url: "https://one.example", newTab: true }],
      [{ url: "https://two.example", newTab: true }],
    ]);
  });
});
