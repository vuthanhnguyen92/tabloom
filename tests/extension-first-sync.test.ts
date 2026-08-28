import { describe, expect, it, vi } from "vitest";
import type { WorkspaceMergePlan } from "../shared/workspace-merge";
import {
  advanceFirstSync,
  type FirstSyncCoordinator,
  type FirstSyncDecision,
} from "../extension/first-sync";

const preview: WorkspaceMergePlan = {
  expectedRevision: 2,
  merged: { spaces: [], collections: [], links: [] },
  identityMap: { spaces: {}, collections: {}, links: {} },
  summary: {
    addedSpaces: 1,
    addedCollections: 1,
    addedLinks: 1,
    matchedSpaces: 0,
    matchedCollections: 0,
    matchedLinksById: 0,
    matchedLinksByUrl: 0,
    remappedIds: 0,
    skippedUnsupportedLinks: 0,
  },
};

function coordinator(decision: FirstSyncDecision) {
  return {
    inspect: vi.fn(async () => decision),
    confirm: vi.fn(async () => ({ revision: 3 })),
    cancel: vi.fn(async () => undefined),
  } as unknown as FirstSyncCoordinator;
}

describe("advanceFirstSync", () => {
  it("automatically executes an empty-cloud import", async () => {
    const instance = coordinator({ kind: "auto-import", preview });

    await expect(advanceFirstSync(instance)).resolves.toEqual({ kind: "synced" });
    expect(instance.confirm).toHaveBeenCalledWith(preview);
  });

  it("keeps local authority while two-sided data awaits confirmation", async () => {
    const instance = coordinator({ kind: "confirm", preview });

    await expect(advanceFirstSync(instance)).resolves.toEqual({
      kind: "confirmation",
      coordinator: instance,
      preview,
    });
    expect(instance.confirm).not.toHaveBeenCalled();
  });

  it("does not merge after automatic cloud adoption", async () => {
    const instance = coordinator({
      kind: "adopt-cloud",
      cloud: { snapshot: { spaces: [], collections: [], links: [] }, revision: 3 },
    });

    await expect(advanceFirstSync(instance)).resolves.toEqual({ kind: "synced" });
    expect(instance.confirm).not.toHaveBeenCalled();
  });
});
