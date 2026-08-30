import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../shared/domain";
import {
  SupabaseWorkspaceSyncRepository,
  WorkspaceAuthenticationError,
  WorkspaceRevisionConflictError,
} from "../shared/workspace-sync-repository";

const rawSnapshot = {
  spaces: [
    {
      id: "10000000-0000-4000-8000-000000000001",
      user_id: "00000000-0000-0000-0000-00000000000a",
      name: "Research",
      color: "#7357e6",
      position: 0,
      created_at: "2026-08-29T00:00:00.000Z",
      updated_at: "2026-08-29T00:00:00.000Z",
    },
  ],
  collections: [],
  links: [],
};

function clientWith(
  response: { data: unknown; error: null | { code?: string; message: string } },
) {
  const rpc = vi.fn(async () => response);
  return {
    client: { rpc } as unknown as SupabaseClient,
    rpc,
  };
}

describe("SupabaseWorkspaceSyncRepository", () => {
  it("loads a canonical versioned snapshot and marks cloud rows as editable saved records", async () => {
    const { client, rpc } = clientWith({
      data: { revision: 3, snapshot: rawSnapshot },
      error: null,
    });
    const repository = new SupabaseWorkspaceSyncRepository(client);

    const result = await repository.loadVersioned();

    expect(rpc).toHaveBeenCalledWith("load_workspace_snapshot");
    expect(result.revision).toBe(3);
    expect(result.snapshot.spaces[0]).toMatchObject({
      name: "Research",
      origin: "saved",
      read_only: false,
    });
  });

  it("sends the local snapshot and expected revision to the atomic merge RPC", async () => {
    const summary = {
      addedSpaces: 1,
      addedCollections: 0,
      addedLinks: 0,
      matchedSpaces: 0,
      matchedCollections: 0,
      matchedLinksById: 0,
      matchedLinksByUrl: 0,
      remappedIds: 0,
      skippedUnsupportedLinks: 0,
    };
    const { client, rpc } = clientWith({
      data: {
        revision: 4,
        snapshot: rawSnapshot,
        identityMap: { spaces: {}, collections: {}, links: {} },
        summary,
      },
      error: null,
    });
    const repository = new SupabaseWorkspaceSyncRepository(client);
    const local = rawSnapshot as unknown as WorkspaceSnapshot;

    const result = await repository.mergeLocal(local, 3);

    expect(rpc).toHaveBeenCalledWith("merge_workspace_snapshot", {
      local_snapshot: local,
      expected_revision: 3,
    });
    expect(result).toMatchObject({ revision: 4, summary });
    expect(result.snapshot.spaces[0].origin).toBe("saved");
  });

  it("classifies revision conflicts", async () => {
    const { client } = clientWith({
      data: null,
      error: { code: "40001", message: "workspace revision conflict" },
    });

    await expect(
      new SupabaseWorkspaceSyncRepository(client).loadVersioned(),
    ).rejects.toBeInstanceOf(WorkspaceRevisionConflictError);
  });

  it.each(["28000", "42501", "PGRST301", "401"])(
    "classifies authentication failures with code %s",
    async (code) => {
      const { client } = clientWith({
        data: null,
        error: { code, message: "authentication required" },
      });

      await expect(
        new SupabaseWorkspaceSyncRepository(client).loadVersioned(),
      ).rejects.toBeInstanceOf(WorkspaceAuthenticationError);
    },
  );

  it("rejects malformed canonical responses", async () => {
    const { client } = clientWith({
      data: { revision: "three", snapshot: { spaces: [] } },
      error: null,
    });

    await expect(
      new SupabaseWorkspaceSyncRepository(client).loadVersioned(),
    ).rejects.toThrow("invalid workspace sync response");
  });
});
