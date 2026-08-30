import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createOAuthDatabaseProofKey } from "../../services/tabloom-mcp/src/auth/database-proof";

import {
  OAuthInvalidClientMetadataError,
  OAuthPersistenceUnavailableError,
  OAuthRegistrationCapacityError,
  SupabaseOAuthPersistence,
  createOAuthPersistence,
  type OAuthRpcClient,
  type OAuthRpcResult,
  type SupabaseClientFactory,
} from "../../services/tabloom-mcp/src/oauth/persistence";

type RpcCall = { name: string; args: Record<string, unknown> };
const PROOF_NOW = 1_788_000_000;
const DATABASE_SECRET = Buffer.alloc(32, 0x42).toString("base64url");
const DATABASE_PROOF_KEY = createOAuthDatabaseProofKey(DATABASE_SECRET);
const PROOF_NONCE = Buffer.alloc(32, 0x24).toString("base64url");

function persistence(client: OAuthRpcClient) {
  return new SupabaseOAuthPersistence(client, DATABASE_PROOF_KEY, {
    now: () => PROOF_NOW,
    randomBytes: (size) => Buffer.alloc(size, 0x24),
  });
}

function framed(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function expectedProof(action: string, canonicalPayload: string) {
  const envelope = [
    "tabloom-oauth-rpc-v1",
    action,
    canonicalPayload,
    String(PROOF_NOW),
    PROOF_NONCE,
  ].join("\n");
  return {
    proof_timestamp: PROOF_NOW,
    proof_nonce: PROOF_NONCE,
    proof_signature: createHmac(
      "sha256",
      Buffer.from(DATABASE_SECRET, "base64url"),
    ).update(envelope, "utf8").digest("base64url"),
  };
}

class FakeRpcClient implements OAuthRpcClient {
  readonly calls: RpcCall[] = [];
  readonly responses: OAuthRpcResult[];

  constructor(...responses: OAuthRpcResult[]) {
    this.responses = [...responses];
  }

  async rpc(name: string, args: Record<string, unknown> = {}): Promise<OAuthRpcResult> {
    this.calls.push({ name, args });
    const response = this.responses.shift();
    if (!response) throw new Error(`missing fake response for ${name}`);
    return response;
  }
}

const storedClient = {
  client_id: "5c177e69-8954-4c57-a777-07c732513bea",
  client_name: "Example MCP Client",
  redirect_uris: ["https://client.example/callback"],
  created_at: "2026-08-29T01:02:03.000Z",
  expires_at: "2026-08-30T01:02:03.000Z",
};

describe("SupabaseOAuthPersistence", () => {
  it("decodes registered client metadata and sends only the exact RPC shape", async () => {
    const client = new FakeRpcClient({ data: storedClient, error: null });
    const store = persistence(client);

    await expect(store.registerClient({
      clientName: "Example MCP Client",
      redirectUris: ["https://client.example/callback"],
      expiresAt: storedClient.expires_at,
    })).resolves.toEqual({
      clientId: storedClient.client_id,
      clientName: storedClient.client_name,
      redirectUris: storedClient.redirect_uris,
      createdAt: storedClient.created_at,
      expiresAt: storedClient.expires_at,
    });
    expect(client.calls).toEqual([{
      name: "register_oauth_client",
      args: {
        client_metadata: {
          client_name: "Example MCP Client",
          redirect_uris: ["https://client.example/callback"],
          expires_at: storedClient.expires_at,
        },
        ...expectedProof("register_oauth_client", [
          "client_name",
          framed("Example MCP Client"),
          "redirect_uris",
          "1",
          framed("https://client.example/callback"),
          "expires_at",
          framed(storedClient.expires_at),
        ].join("\n")),
      },
    }]);
    expect(JSON.stringify(client.calls)).not.toContain(DATABASE_SECRET);
  });

  it("returns null for an unknown exact client id", async () => {
    const client = new FakeRpcClient({ data: null, error: null });
    const store = persistence(client);

    await expect(store.getClient(storedClient.client_id)).resolves.toBeNull();
    expect(client.calls).toEqual([{
      name: "get_oauth_client",
      args: { client_id: storedClient.client_id },
    }]);
  });

  it("decodes a client returned by exact lookup", async () => {
    const expiringClient = { ...storedClient, expires_at: "2027-08-29T01:02:03.000Z" };
    const client = new FakeRpcClient({ data: expiringClient, error: null });
    const store = persistence(client);

    await expect(store.getClient(storedClient.client_id)).resolves.toEqual({
      clientId: storedClient.client_id,
      clientName: storedClient.client_name,
      redirectUris: storedClient.redirect_uris,
      createdAt: storedClient.created_at,
      expiresAt: expiringClient.expires_at,
    });
  });

  it("hashes a token JTI before atomically consuming it", async () => {
    const client = new FakeRpcClient({ data: true, error: null });
    const store = persistence(client);
    const expiresAt = new Date("2026-08-30T00:00:00.000Z");

    await expect(store.consume("authorization_code", "raw-code-jti", expiresAt)).resolves.toBe(true);
    expect(client.calls).toEqual([{
      name: "consume_oauth_token",
      args: {
        token_hash: "110d3139cc5a161abc92a9d0e77f29d07c776f6447956bbed76b9305ce7c3c98",
        token_kind: "authorization_code",
        expires_at: "2026-08-30T00:00:00.000Z",
        ...expectedProof("consume_oauth_token", [
          "token_hash",
          framed("110d3139cc5a161abc92a9d0e77f29d07c776f6447956bbed76b9305ce7c3c98"),
          "token_kind",
          framed("authorization_code"),
          "expires_at",
          framed("2026-08-30T00:00:00.000Z"),
        ].join("\n")),
      },
    }]);
  });

  it("hashes grant ids for revocation writes and reads", async () => {
    const client = new FakeRpcClient(
      { data: null, error: null },
      { data: true, error: null },
    );
    const store = persistence(client);
    const expiresAt = new Date("2026-09-28T00:00:00.000Z");

    await expect(store.revokeGrant("raw-grant-family", expiresAt)).resolves.toBeUndefined();
    await expect(store.isGrantRevoked("raw-grant-family")).resolves.toBe(true);
    expect(client.calls).toEqual([
      {
        name: "revoke_oauth_grant",
        args: {
          grant_hash: "38f8cb91b2da7d15e2f61c25faab53569ea655f993f12798548aa8b4b10e165e",
          expires_at: "2026-09-28T00:00:00.000Z",
          ...expectedProof("revoke_oauth_grant", [
            "grant_hash",
            framed("38f8cb91b2da7d15e2f61c25faab53569ea655f993f12798548aa8b4b10e165e"),
            "expires_at",
            framed("2026-09-28T00:00:00.000Z"),
          ].join("\n")),
        },
      },
      {
        name: "is_oauth_grant_revoked",
        args: {
          grant_hash: "38f8cb91b2da7d15e2f61c25faab53569ea655f993f12798548aa8b4b10e165e",
        },
      },
    ]);
  });

  it.each([
    { code: "08006", message: "connection failure with database host" },
    { code: "PGRST002", message: "schema cache unavailable: internal-host.example" },
    { code: "57P01", message: "terminating connection due to administrator command" },
  ])("maps retryable $code failures to one non-sensitive error", async (error) => {
    const client = new FakeRpcClient({ data: null, error });
    const store = persistence(client);

    const operation = store.getClient(storedClient.client_id);
    await expect(operation).rejects.toBeInstanceOf(OAuthPersistenceUnavailableError);
    await expect(operation).rejects.toThrow("OAuth persistence is temporarily unavailable");
    await expect(operation).rejects.not.toThrow(error.message);
  });

  it("maps SQLSTATE 22023 to non-sensitive invalid client metadata", async () => {
    const databaseMessage = "invalid OAuth client metadata at private schema oauth_private";
    const client = new FakeRpcClient({
      data: null,
      error: { code: "22023", message: databaseMessage },
    });
    const store = persistence(client);

    const operation = store.registerClient({
      clientName: "Example MCP Client",
      redirectUris: ["https://client.example/callback"],
      expiresAt: storedClient.expires_at,
    });
    await expect(operation).rejects.toBeInstanceOf(OAuthInvalidClientMetadataError);
    await expect(operation).rejects.not.toThrow(databaseMessage);
  });

  it("maps a consume expiry clock race to a typed non-sensitive invalid grant", async () => {
    const databaseMessage = "invalid OAuth token consumption";
    const client = new FakeRpcClient({
      data: null,
      error: { code: "22023", message: databaseMessage },
    });
    const store = persistence(client);

    const operation = store.consume(
      "authorization_code",
      "fresh-code-jti",
      new Date("2026-08-30T00:00:01.000Z"),
    );
    await expect(operation).rejects.toMatchObject({
      name: "OAuthInvalidGrantPersistenceError",
      message: "OAuth token consumption is invalid",
    });
    await expect(operation).rejects.not.toThrow(databaseMessage);
  });

  it("keeps unrelated SQLSTATE 22023 failures generic and non-sensitive", async () => {
    const databaseMessage = "unrelated invalid parameter in private database function";
    const operations = [
      () => persistence(new FakeRpcClient({
        data: null,
        error: { code: "22023", message: databaseMessage },
      })).getClient(storedClient.client_id),
      () => persistence(new FakeRpcClient({
        data: null,
        error: { code: "22023", message: databaseMessage },
      })).consume(
        "authorization_code",
        "fresh-code-jti",
        new Date("2026-08-30T00:00:01.000Z"),
      ),
      () => persistence(new FakeRpcClient({
        data: null,
        error: { code: "22023", message: databaseMessage },
      })).revokeGrant("raw-grant-family", new Date("2026-09-28T00:00:00.000Z")),
    ];

    for (const startOperation of operations) {
      const operation = startOperation();
      await expect(operation).rejects.toMatchObject({
        name: "OAuthPersistenceOperationError",
        message: "OAuth persistence operation failed",
      });
      await expect(operation).rejects.not.toThrow(databaseMessage);
    }
  });

  it("maps only the fixed registration quota failure to capacity", async () => {
    const client = new FakeRpcClient({
      data: null,
      error: { code: "P0001", message: "OAuth registration quota exceeded" },
    });
    const store = persistence(client);

    const operation = store.registerClient({
      clientName: "Example MCP Client",
      redirectUris: ["https://client.example/callback"],
      expiresAt: storedClient.expires_at,
    });
    await expect(operation).rejects.toBeInstanceOf(OAuthRegistrationCapacityError);
    await expect(operation).rejects.toMatchObject({ retryAfterSeconds: 60 });
    await expect(operation).rejects.not.toThrow("OAuth registration quota exceeded");
  });

  it("keeps unrelated P0001 failures generic and non-sensitive", async () => {
    const databaseMessage = "private constraint oauth_clients_internal failed";
    const client = new FakeRpcClient({
      data: null,
      error: { code: "P0001", message: databaseMessage },
    });
    const store = persistence(client);

    const operation = store.registerClient({
      clientName: "Example MCP Client",
      redirectUris: ["https://client.example/callback"],
      expiresAt: storedClient.expires_at,
    });
    await expect(operation).rejects.not.toBeInstanceOf(OAuthRegistrationCapacityError);
    await expect(operation).rejects.not.toBeInstanceOf(OAuthPersistenceUnavailableError);
    await expect(operation).rejects.toThrow("OAuth persistence operation failed");
    await expect(operation).rejects.not.toThrow(databaseMessage);
  });
});

describe("createOAuthPersistence", () => {
  it("creates an anonymous client with all browser session behavior disabled", () => {
    const rpcClient = new FakeRpcClient();
    const calls: Parameters<SupabaseClientFactory>[] = [];
    const factory: SupabaseClientFactory = (...args) => {
      calls.push(args);
      return rpcClient;
    };

    const persistence = createOAuthPersistence({
      supabaseUrl: new URL("https://project.supabase.co"),
      anonKey: "public-anon-key",
      databaseProofKey: DATABASE_PROOF_KEY,
    }, factory);

    expect(persistence).toBeInstanceOf(SupabaseOAuthPersistence);
    expect(calls).toEqual([[
      "https://project.supabase.co/",
      "public-anon-key",
      {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
      },
    ]]);
  });

  it("refuses to construct mutation persistence without a server-only proof key", () => {
    expect(() => createOAuthPersistence({
      supabaseUrl: new URL("https://project.supabase.co"),
      anonKey: "public-anon-key",
    }, () => new FakeRpcClient())).toThrow();
  });
});
