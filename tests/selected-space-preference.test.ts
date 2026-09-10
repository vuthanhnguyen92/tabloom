import { describe, expect, it } from "vitest";
import type { BrowserAdapter } from "../extension/browser/types";
import { SelectedSpacePreference } from "../extension/selected-space-preference";

function createStorage() {
  const values: Record<string, unknown> = {};
  return {
    async get(keys: string | string[]) {
      const requested = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(requested.map((key) => [key, values[key]]));
    },
    async set(items: Record<string, unknown>) {
      Object.assign(values, items);
    },
  } as BrowserAdapter["storage"];
}

const SELECTED_SPACES_STORAGE_KEY = "tabloom:selected-spaces:v1";

const spaces = [{ id: "space-one" }, { id: "space-two" }];

describe("SelectedSpacePreference", () => {
  it("restores the last selected space after the extension restarts", async () => {
    const storage = createStorage();
    await new SelectedSpacePreference(storage).select("account:user-1", "space-two");

    const restored = await new SelectedSpacePreference(storage).reconcile("account:user-1", spaces);

    expect(restored).toBe("space-two");
  });

  it("keeps local and signed-in space selections independent", async () => {
    const storage = createStorage();
    const preference = new SelectedSpacePreference(storage);
    await preference.select("local", "space-one");
    await preference.select("account:user-1", "space-two");

    const restored = new SelectedSpacePreference(storage);
    expect(await restored.reconcile("local", spaces)).toBe("space-one");
    expect(await restored.reconcile("account:user-1", spaces)).toBe("space-two");
  });

  it("falls back to the first available space and remembers it when the selected space was deleted", async () => {
    const storage = createStorage();
    await new SelectedSpacePreference(storage).select("account:user-1", "space-two");

    const preference = new SelectedSpacePreference(storage);
    expect(await preference.reconcile("account:user-1", [{ id: "space-one" }])).toBe("space-one");
    expect(await new SelectedSpacePreference(storage).reconcile("account:user-1", [...spaces].reverse())).toBe("space-one");
  });

  it("keeps the existing extension storage key and value shape", async () => {
    const storage = createStorage();

    await new SelectedSpacePreference(storage).select("account:user-1", "space-two");

    await expect(storage.get(SELECTED_SPACES_STORAGE_KEY)).resolves.toEqual({
      [SELECTED_SPACES_STORAGE_KEY]: { "account:user-1": "space-two" },
    });
  });
});
