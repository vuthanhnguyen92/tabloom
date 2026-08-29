import { createClient } from "@supabase/supabase-js";
import { hashOpaqueIdentifier } from "../auth/artifacts";

export type StoredPublicClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
  expiresAt: string | null;
};

export interface OAuthPersistence {
  registerClient(
    input: Omit<StoredPublicClient, "clientId" | "createdAt">,
  ): Promise<StoredPublicClient>;
  getClient(clientId: string): Promise<StoredPublicClient | null>;
  consume(
    kind: "authorization_code" | "refresh_token",
    jti: string,
    expiresAt: Date,
  ): Promise<boolean>;
  revokeGrant(grantId: string, expiresAt: Date): Promise<void>;
  isGrantRevoked(grantId: string): Promise<boolean>;
}

export type OAuthRpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

export interface OAuthRpcClient {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<OAuthRpcResult>;
}

type AnonymousSupabaseOptions = {
  auth: {
    autoRefreshToken: false;
    detectSessionInUrl: false;
    persistSession: false;
  };
};

export type SupabaseClientFactory = (
  url: string,
  anonKey: string,
  options: AnonymousSupabaseOptions,
) => OAuthRpcClient;

type StoredPublicClientRow = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
  expires_at: string | null;
};

const RETRYABLE_DATABASE_CODES = new Set([
  "53300",
  "53400",
  "57P01",
  "57P02",
  "57P03",
  "PGRST000",
  "PGRST001",
  "PGRST002",
  "PGRST003",
]);

export class OAuthPersistenceUnavailableError extends Error {
  constructor() {
    super("OAuth persistence is temporarily unavailable");
    this.name = "OAuthPersistenceUnavailableError";
  }
}

function isRetryableDatabaseError(error: OAuthRpcResult["error"]): boolean {
  const code = error?.code;
  return typeof code === "string" && (
    code.startsWith("08") || RETRYABLE_DATABASE_CODES.has(code)
  );
}

function failedOperation(error: OAuthRpcResult["error"]): Error {
  if (isRetryableDatabaseError(error)) {
    return new OAuthPersistenceUnavailableError();
  }
  return new Error("OAuth persistence operation failed");
}

function isStoredPublicClientRow(value: unknown): value is StoredPublicClientRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.client_id === "string" &&
    typeof row.client_name === "string" &&
    Array.isArray(row.redirect_uris) &&
    row.redirect_uris.every((uri) => typeof uri === "string") &&
    typeof row.created_at === "string" &&
    (row.expires_at === null || typeof row.expires_at === "string")
  );
}

function decodeClient(value: unknown): StoredPublicClient {
  if (!isStoredPublicClientRow(value)) {
    throw new Error("OAuth persistence returned invalid client metadata");
  }
  return {
    clientId: value.client_id,
    clientName: value.client_name,
    redirectUris: value.redirect_uris,
    createdAt: value.created_at,
    expiresAt: value.expires_at,
  };
}

const createAnonymousClient: SupabaseClientFactory = (url, anonKey, options) => {
  const client = createClient(url, anonKey, options);
  return {
    async rpc(name, args = {}) {
      const result = await client.rpc(name as never, args as never);
      return { data: result.data, error: result.error };
    },
  };
};

export class SupabaseOAuthPersistence implements OAuthPersistence {
  constructor(private readonly client: OAuthRpcClient) {}

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const result = await this.client.rpc(name, args);
      if (result.error) throw failedOperation(result.error);
      return result.data;
    } catch (error) {
      if (error instanceof OAuthPersistenceUnavailableError) throw error;
      if (error instanceof Error && error.message.startsWith("OAuth persistence")) {
        throw error;
      }
      throw new OAuthPersistenceUnavailableError();
    }
  }

  async registerClient(
    input: Omit<StoredPublicClient, "clientId" | "createdAt">,
  ): Promise<StoredPublicClient> {
    return decodeClient(await this.rpc("register_oauth_client", {
      client_metadata: {
        client_name: input.clientName,
        redirect_uris: input.redirectUris,
        expires_at: input.expiresAt,
      },
    }));
  }

  async getClient(clientId: string): Promise<StoredPublicClient | null> {
    const data = await this.rpc("get_oauth_client", { client_id: clientId });
    return data === null ? null : decodeClient(data);
  }

  async consume(
    kind: "authorization_code" | "refresh_token",
    jti: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const data = await this.rpc("consume_oauth_token", {
      token_hash: hashOpaqueIdentifier(jti),
      token_kind: kind,
      expires_at: expiresAt.toISOString(),
    });
    if (typeof data !== "boolean") {
      throw new Error("OAuth persistence returned an invalid consume result");
    }
    return data;
  }

  async revokeGrant(grantId: string, expiresAt: Date): Promise<void> {
    await this.rpc("revoke_oauth_grant", {
      grant_hash: hashOpaqueIdentifier(grantId),
      expires_at: expiresAt.toISOString(),
    });
  }

  async isGrantRevoked(grantId: string): Promise<boolean> {
    const data = await this.rpc("is_oauth_grant_revoked", {
      grant_hash: hashOpaqueIdentifier(grantId),
    });
    if (typeof data !== "boolean") {
      throw new Error("OAuth persistence returned an invalid revocation result");
    }
    return data;
  }
}

export function createOAuthPersistence(
  config: { supabaseUrl: URL; anonKey: string },
  factory: SupabaseClientFactory = createAnonymousClient,
): OAuthPersistence {
  const client = factory(config.supabaseUrl.href, config.anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseOAuthPersistence(client);
}
