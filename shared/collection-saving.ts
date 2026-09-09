import type { CollectionShareClient } from "./collection-sharing";

export type SharedCollectionSaveState =
  | { status: "available" }
  | { status: "unavailable" }
  | { status: "owned" | "saved"; collectionId: string; spaceId: string };
export type SharedCollectionSaveResult = {
  status: "created" | "saved" | "owned";
  collectionId: string;
  spaceId: string;
};
export interface CollectionSaveRepository {
  getState(token: string): Promise<SharedCollectionSaveState>;
  save(token: string): Promise<SharedCollectionSaveResult>;
}
export class CollectionSaveError extends Error {
  constructor(public readonly code: "auth-required" | "unavailable" | "failed") {
    super(code === "unavailable" ? "This shared collection is no longer available." : code === "auth-required" ? "Sign in to save this collection." : "Couldn’t save this collection. Try again.");
    this.name = "CollectionSaveError";
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function decode(value: unknown, mutation: boolean): SharedCollectionSaveState | SharedCollectionSaveResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CollectionSaveError("failed");
  const row = value as Record<string, unknown>;
  if (!mutation && (row.status === "available" || row.status === "unavailable")) return { status: row.status };
  if ((row.status === "saved" || row.status === "owned" || (mutation && row.status === "created")) && typeof row.collectionId === "string" && UUID.test(row.collectionId) && typeof row.spaceId === "string" && UUID.test(row.spaceId)) {
    return { status: row.status, collectionId: row.collectionId, spaceId: row.spaceId } as SharedCollectionSaveResult;
  }
  throw new CollectionSaveError("failed");
}
export class SupabaseCollectionSaveRepository implements CollectionSaveRepository {
  constructor(private readonly client: Pick<CollectionShareClient, "rpc">) {}
  async getState(token: string): Promise<SharedCollectionSaveState> {
    return decode(await this.request("get_shared_collection_save_state", token), false) as SharedCollectionSaveState;
  }
  async save(token: string): Promise<SharedCollectionSaveResult> {
    return decode(await this.request("save_shared_collection", token), true) as SharedCollectionSaveResult;
  }
  private async request(name: string, token: string): Promise<unknown> {
    try {
      const { data, error } = await this.client.rpc(name, { share_token: token });
      if (error) {
        const code = (error as { code?: string }).code;
        throw new CollectionSaveError(code === "28000" || code === "42501" || code === "PGRST301" ? "auth-required" : code === "P0002" ? "unavailable" : "failed");
      }
      return data;
    } catch (error) {
      throw error instanceof CollectionSaveError ? error : new CollectionSaveError("failed");
    }
  }
}
