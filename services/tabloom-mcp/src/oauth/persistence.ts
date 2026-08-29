import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { hashOpaqueIdentifier } from "../auth/artifacts";
import {
  signOAuthMutationProof,
  type OAuthDatabaseProofKey,
} from "../auth/database-proof";

export type StoredPublicClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
  expiresAt: string;
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
  expires_at: string;
};

export type OAuthMutationProofDependencies = {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
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
    typeof row.expires_at === "string"
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
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;

  constructor(
    private readonly client: OAuthRpcClient,
    private readonly databaseProofKey: OAuthDatabaseProofKey,
    dependencies: OAuthMutationProofDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
    this.random = dependencies.randomBytes ?? randomBytes;
  }

  private proof(action: string, canonicalPayload: string) {
    const timestamp = this.now();
    const nonce = Buffer.from(this.random(32)).toString("base64url");
    return signOAuthMutationProof(
      this.databaseProofKey,
      action,
      canonicalPayload,
      timestamp,
      nonce,
    );
  }

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
    const clientMetadata = {
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      expires_at: input.expiresAt,
    };
    const canonicalPayload = [
      "client_name",
      frame(input.clientName),
      "redirect_uris",
      String(input.redirectUris.length),
      input.redirectUris.map(frame).join(""),
      "expires_at",
      frame(input.expiresAt),
    ].join("\n");
    return decodeClient(await this.rpc("register_oauth_client", {
      client_metadata: clientMetadata,
      ...this.proof("register_oauth_client", canonicalPayload),
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
      ...this.proof("consume_oauth_token", [
        "token_hash",
        frame(hashOpaqueIdentifier(jti)),
        "token_kind",
        frame(kind),
        "expires_at",
        frame(expiresAt.toISOString()),
      ].join("\n")),
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
      ...this.proof("revoke_oauth_grant", [
        "grant_hash",
        frame(hashOpaqueIdentifier(grantId)),
        "expires_at",
        frame(expiresAt.toISOString()),
      ].join("\n")),
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
  config: {
    supabaseUrl: URL;
    anonKey: string;
    databaseProofKey?: OAuthDatabaseProofKey;
  },
  factory: SupabaseClientFactory = createAnonymousClient,
): OAuthPersistence {
  if (!config.databaseProofKey) {
    throw new Error("OAuth database proof key is required");
  }
  const client = factory(config.supabaseUrl.href, config.anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseOAuthPersistence(client, config.databaseProofKey);
}

function frame(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}
