import { describe, expect, it, vi } from "vitest";
import { SupabaseCollectionSaveRepository } from "../shared/collection-saving";
const token = "a".repeat(43);
const ids = { collectionId: "11111111-1111-4111-8111-111111111111", spaceId: "22222222-2222-4222-8222-222222222222" };
describe("collection saving adapter", () => {
  it.each(["created", "saved", "owned"])("decodes save %s", async status => {
    const rpc = vi.fn().mockResolvedValue({ data: { status, ...ids }, error: null });
    expect(await new SupabaseCollectionSaveRepository({ rpc }).save(token)).toEqual({ status, ...ids });
    expect(rpc).toHaveBeenCalledWith("save_shared_collection", { share_token: token });
  });
  it.each(["available", "unavailable", "saved", "owned"])("decodes state %s", async status => {
    const data = status === "saved" || status === "owned" ? { status, ...ids } : { status };
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    expect(await new SupabaseCollectionSaveRepository({ rpc }).getState(token)).toEqual(data);
    expect(rpc).toHaveBeenCalledWith("get_shared_collection_save_state", { share_token: token });
  });
  it.each([null, [], { status: "wat" }, { status: "created", collectionId: "bad", spaceId: ids.spaceId }, { status: "available" }])("rejects malformed saves %j", async data => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    await expect(new SupabaseCollectionSaveRepository({ rpc }).save(token)).rejects.toMatchObject({ code: "failed" });
  });
  it.each([["28000", "auth-required"], ["42501", "auth-required"], ["P0002", "unavailable"], ["XX000", "failed"]])("maps %s", async (code, expected) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code, message: "secret SQL" } });
    await expect(new SupabaseCollectionSaveRepository({ rpc }).save(token)).rejects.toMatchObject({ code: expected });
    await expect(new SupabaseCollectionSaveRepository({ rpc }).getState(token)).rejects.not.toHaveProperty("message", "secret SQL");
  });
  it("normalizes network failures", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("network"));
    await expect(new SupabaseCollectionSaveRepository({ rpc }).save(token)).rejects.toMatchObject({ code: "failed" });
  });
  it.each([null, [], { status: "created", ...ids }, { status: "owned", collectionId: ids.collectionId, spaceId: "bad" }, { status: "unknown" }])("rejects malformed states %j", async data => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    await expect(new SupabaseCollectionSaveRepository({ rpc }).getState(token)).rejects.toMatchObject({ code: "failed" });
  });

});
