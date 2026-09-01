import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceOperation } from "../shared/workspace-operations";
import {
  SupabaseWorkspaceSyncTransport,
} from "../extension/workspace-sync-transport";
import {
  WorkspaceAuthenticationError,
  WorkspaceRevisionConflictError,
} from "../shared/workspace-sync-repository";

const SPACE_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-0000-0000-00000000000a";
const OPERATION_ID = "40000000-0000-4000-8000-000000000001";
const DEVICE_ID = "50000000-0000-4000-8000-000000000001";
const timestamp = "2026-08-31T00:00:00.000Z";

const rawSpace = {
  id: SPACE_ID,
  user_id: USER_ID,
  name: "Research",
  color: "#7357e6",
  position: 0,
  created_at: timestamp,
  updated_at: timestamp,
};

const operation: WorkspaceOperation = {
  operationId: OPERATION_ID,
  deviceId: DEVICE_ID,
  sequence: 1,
  entity: "space",
  entityId: SPACE_ID,
  action: "create",
  payload: rawSpace,
  createdAt: timestamp,
  baseRevision: 7,
};

function clientWith(response: {
  data: unknown;
  error: null | { code?: string; message: string };
}) {
  const rpc = vi.fn(async () => response);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("SupabaseWorkspaceSyncTransport", () => {
  it("times out a stalled workspace request", async () => {
    vi.useFakeTimers();
    const rpc = vi.fn(() => new Promise<never>(() => undefined));
    const client = { rpc } as unknown as SupabaseClient;
    const result = expect(new SupabaseWorkspaceSyncTransport(client, { timeoutMs: 1_000 }).getRevision())
      .rejects.toThrow("Workspace sync timed out");

    await vi.advanceTimersByTimeAsync(1_000);

    await result;
  });

  it("uses the exact revision RPC contract", async () => {
    const { client, rpc } = clientWith({
      data: { revision: 7, serverTime: timestamp },
      error: null,
    });

    await expect(new SupabaseWorkspaceSyncTransport(client).getRevision())
      .resolves.toEqual({ revision: 7, serverTime: timestamp });
    expect(rpc).toHaveBeenCalledWith("get_workspace_revision");
  });

  it("uses the exact operation RPC contract and parses patches", async () => {
    const { client, rpc } = clientWith({
      data: {
        revision: 8,
        outcomes: [{ operationId: OPERATION_ID, status: "applied" }],
        patches: { spaces: [rawSpace], collections: [], links: [] },
        tombstones: [],
        conflicts: [],
      },
      error: null,
    });

    const result = await new SupabaseWorkspaceSyncTransport(client)
      .applyOperations([operation], 7);

    expect(rpc).toHaveBeenCalledWith("apply_workspace_operations", {
      operations: [operation],
      expected_revision: 7,
    });
    expect(result.patches.spaces[0]).toMatchObject({
      name: "Research",
      origin: "saved",
      read_only: false,
    });
  });

  it("loads a strict canonical snapshot with tombstones", async () => {
    const tombstone = {
      entity: "space",
      entityId: SPACE_ID,
      deletedRevision: 9,
      deletedAt: timestamp,
    };
    const { client, rpc } = clientWith({
      data: {
        revision: 9,
        snapshot: { spaces: [rawSpace], collections: [], links: [] },
        tombstones: [tombstone],
      },
      error: null,
    });

    const result = await new SupabaseWorkspaceSyncTransport(client).loadCanonical();

    expect(rpc).toHaveBeenCalledWith("load_workspace_snapshot");
    expect(result.tombstones).toEqual([tombstone]);
    expect(result.snapshot.spaces[0]).toMatchObject({ origin: "saved", read_only: false });
  });

  it.each([
    { revision: -1, serverTime: timestamp },
    { revision: 1.5, serverTime: timestamp },
    { revision: 1, serverTime: 42 },
  ])("rejects malformed revision responses", async (data) => {
    const { client } = clientWith({ data, error: null });
    await expect(new SupabaseWorkspaceSyncTransport(client).getRevision())
      .rejects.toThrow("invalid workspace sync response");
  });

  it.each([
    { outcomes: [{ operationId: "bad", status: "applied" }] },
    { outcomes: [{ operationId: OPERATION_ID, status: "unknown" }] },
    { patches: { spaces: [{ ...rawSpace, position: "zero" }], collections: [], links: [] } },
    { tombstones: [{ entity: "space", entityId: "bad", deletedRevision: 1, deletedAt: timestamp }] },
  ])("rejects malformed operation responses", async (override) => {
    const { client } = clientWith({
      data: {
        revision: 8,
        outcomes: [{ operationId: OPERATION_ID, status: "applied" }],
        patches: { spaces: [], collections: [], links: [] },
        tombstones: [],
        conflicts: [],
        ...override,
      },
      error: null,
    });
    await expect(new SupabaseWorkspaceSyncTransport(client).applyOperations([operation], 7))
      .rejects.toThrow("invalid workspace sync response");
  });

  it("requires tombstones in canonical responses", async () => {
    const { client } = clientWith({
      data: { revision: 0, snapshot: { spaces: [], collections: [], links: [] } },
      error: null,
    });
    await expect(new SupabaseWorkspaceSyncTransport(client).loadCanonical())
      .rejects.toThrow("invalid workspace sync response");
  });

  it("classifies revision conflicts", async () => {
    const { client } = clientWith({ data: null, error: { code: "40001", message: "conflict" } });
    await expect(new SupabaseWorkspaceSyncTransport(client).getRevision())
      .rejects.toBeInstanceOf(WorkspaceRevisionConflictError);
  });

  it.each(["28000", "42501", "PGRST301", "401"])(
    "classifies authentication error %s",
    async (code) => {
      const { client } = clientWith({ data: null, error: { code, message: "sign in" } });
      await expect(new SupabaseWorkspaceSyncTransport(client).getRevision())
        .rejects.toBeInstanceOf(WorkspaceAuthenticationError);
    },
  );

  it("preserves other server messages", async () => {
    const { client } = clientWith({ data: null, error: { code: "XX000", message: "server exploded" } });
    await expect(new SupabaseWorkspaceSyncTransport(client).getRevision())
      .rejects.toThrow("server exploded");
  });
});
