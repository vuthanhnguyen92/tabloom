import { describe, expect, it } from "vitest";
import {
  SupabaseCollectionShareRepository,
  collectionShareUrl,
} from "../shared/collection-sharing";

const collectionId = "20000000-0000-4000-8000-000000000001";
const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
const row = {
  collection_id: collectionId,
  token,
  created_at: "2026-09-04T00:00:00.000Z",
  updated_at: "2026-09-04T00:01:00.000Z",
};

type Result = { data: unknown; error: { message: string } | null };

class FakeShareClient {
  readonly calls: Array<{ operation: string; value: unknown }> = [];

  constructor(
    private readonly selectResult: Result = { data: row, error: null },
    private readonly rpcResults: Record<string, Result> = {},
  ) {}

  from(table: string) {
    this.calls.push({ operation: "from", value: table });
    return {
      select: (columns: string) => {
        this.calls.push({ operation: "select", value: columns });
        return {
          eq: (column: string, value: string) => {
            this.calls.push({ operation: "eq", value: { column, value } });
            return { maybeSingle: async () => this.selectResult };
          },
        };
      },
    };
  }

  async rpc(name: string, args: Record<string, unknown>) {
    this.calls.push({ operation: "rpc", value: { name, args } });
    return this.rpcResults[name] ?? { data: [row], error: null };
  }
}

describe("collection sharing", () => {
  it("derives the canonical public URL without retaining another path", () => {
    expect(collectionShareUrl("https://tabloom.nickvu.dev/app", token)).toBe(
      `https://tabloom.nickvu.dev/s/${token}`,
    );
  });

  it("maps the owner's active share and scopes the read to its collection", async () => {
    const client = new FakeShareClient();
    const repository = new SupabaseCollectionShareRepository(client);

    await expect(repository.get(collectionId)).resolves.toEqual({
      collectionId,
      token,
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:01:00.000Z",
    });
    expect(client.calls).toContainEqual({
      operation: "eq",
      value: { column: "collection_id", value: collectionId },
    });
  });

  it("returns null when the owner has not shared the collection", async () => {
    const repository = new SupabaseCollectionShareRepository(
      new FakeShareClient({ data: null, error: null }),
    );

    await expect(repository.get(collectionId)).resolves.toBeNull();
  });

  it("uses collection-scoped RPCs for enable, regenerate, and disable", async () => {
    const client = new FakeShareClient();
    const repository = new SupabaseCollectionShareRepository(client);

    await expect(repository.enable(collectionId)).resolves.toMatchObject({ token });
    await expect(repository.regenerate(collectionId)).resolves.toMatchObject({ token });
    await expect(repository.disable(collectionId)).resolves.toBeUndefined();

    expect(client.calls.filter((call) => call.operation === "rpc")).toEqual([
      { operation: "rpc", value: { name: "enable_collection_share", args: { target_collection_id: collectionId } } },
      { operation: "rpc", value: { name: "regenerate_collection_share", args: { target_collection_id: collectionId } } },
      { operation: "rpc", value: { name: "disable_collection_share", args: { target_collection_id: collectionId } } },
    ]);
  });

  it("surfaces remote and malformed-response failures", async () => {
    const remoteFailure = new SupabaseCollectionShareRepository(
      new FakeShareClient(undefined, {
        enable_collection_share: { data: null, error: { message: "network unavailable" } },
      }),
    );
    await expect(remoteFailure.enable(collectionId)).rejects.toThrow("network unavailable");

    const malformed = new SupabaseCollectionShareRepository(
      new FakeShareClient({ data: { ...row, token: "short" }, error: null }),
    );
    await expect(malformed.get(collectionId)).rejects.toThrow("invalid collection share");
  });
});
