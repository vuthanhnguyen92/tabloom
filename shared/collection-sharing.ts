import type { SavedLink } from "./domain";

export type CollectionShare = {
  collectionId: string;
  token: string;
  createdAt: string;
  updatedAt: string;
};

export type SharedCollectionSnapshot = {
  name: string;
  links: Array<Pick<
    SavedLink,
    "id" | "title" | "description" | "url" | "favicon_url" | "position"
  >>;
};

export type ShareAvailability =
  | "ready"
  | "sign-in-required"
  | "sync-required"
  | "offline";

export interface CollectionShareRepository {
  get(collectionId: string): Promise<CollectionShare | null>;
  enable(collectionId: string): Promise<CollectionShare>;
  regenerate(collectionId: string): Promise<CollectionShare>;
  disable(collectionId: string): Promise<void>;
}

type RemoteError = { message: string } | null;
type RemoteResult = { data: unknown; error: RemoteError };
type AwaitableResult = PromiseLike<RemoteResult>;

export interface CollectionShareClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): AwaitableResult;
      };
    };
  };
  rpc(name: string, args: Record<string, unknown>): AwaitableResult;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function throwRemoteError(error: RemoteError) {
  if (error) throw new Error(error.message);
}

function decodeShareRow(value: unknown): CollectionShare {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("invalid collection share");
  }

  const row = candidate as Record<string, unknown>;
  if (
    typeof row.collection_id !== "string"
    || !row.collection_id
    || typeof row.token !== "string"
    || !TOKEN_PATTERN.test(row.token)
    || typeof row.created_at !== "string"
    || typeof row.updated_at !== "string"
  ) {
    throw new Error("invalid collection share");
  }

  return {
    collectionId: row.collection_id,
    token: row.token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function collectionShareUrl(siteUrl: string, token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("invalid collection share token");
  const url = new URL(siteUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("invalid Tabloom site URL");
  }
  url.pathname = `/s/${encodeURIComponent(token)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class SupabaseCollectionShareRepository implements CollectionShareRepository {
  constructor(private readonly client: CollectionShareClient) {}

  async get(collectionId: string): Promise<CollectionShare | null> {
    const result = await this.client
      .from("collection_shares")
      .select("collection_id,token,created_at,updated_at")
      .eq("collection_id", collectionId)
      .maybeSingle();
    throwRemoteError(result.error);
    return result.data === null ? null : decodeShareRow(result.data);
  }

  async enable(collectionId: string): Promise<CollectionShare> {
    return this.mutate("enable_collection_share", collectionId);
  }

  async regenerate(collectionId: string): Promise<CollectionShare> {
    return this.mutate("regenerate_collection_share", collectionId);
  }

  async disable(collectionId: string): Promise<void> {
    const result = await this.client.rpc("disable_collection_share", {
      target_collection_id: collectionId,
    });
    throwRemoteError(result.error);
  }

  private async mutate(name: string, collectionId: string): Promise<CollectionShare> {
    const result = await this.client.rpc(name, {
      target_collection_id: collectionId,
    });
    throwRemoteError(result.error);
    return decodeShareRow(result.data);
  }
}
