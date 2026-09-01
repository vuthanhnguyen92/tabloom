import { describe, expect, it, vi } from "vitest";
import {
  createLocalWorkspaceRepository,
  openLocalWorkspaceRepository,
} from "../extension/storage";

function memoryArea(initial: Record<string, unknown> = {}) {
  const state = { ...initial };
  return {
    state,
    area: {
      get: vi.fn(async (key: string) => ({ [key]: state[key] })),
      set: vi.fn(async (value: Record<string, unknown>) => {
        Object.assign(state, value);
      }),
      remove: vi.fn(async (key: string) => {
        delete state[key];
      }),
    },
  };
}

describe("local workspace bootstrap", () => {
  it("does not create defaults while probing empty storage", async () => {
    const storage = memoryArea();

    await expect(openLocalWorkspaceRepository(storage.area)).resolves.toBeNull();
    expect(storage.area.set).not.toHaveBeenCalled();
  });

  it("creates My Space and My Collection only when explicitly requested", async () => {
    const storage = memoryArea();

    const repository = await createLocalWorkspaceRepository(storage.area);
    const snapshot = await repository.load();

    expect(snapshot.spaces.map((space) => space.name)).toEqual(["My Space"]);
    expect(snapshot.collections.map((collection) => collection.name)).toEqual(["My Collection"]);
  });
});
