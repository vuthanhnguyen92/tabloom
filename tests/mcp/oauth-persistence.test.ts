import { describe, expect, it } from "vitest";

import {
  OAuthPersistenceUnavailableError,
  SupabaseOAuthPersistence,
  createOAuthPersistence,
  type OAuthRpcClient,
  type OAuthRpcResult,
  type SupabaseClientFactory,
} from "../../services/tabloom-mcp/src/oauth/persistence";

type RpcCall = { name: string; args: Record<string, unknown> };

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
  expires_at: null,
};

describe("SupabaseOAuthPersistence", () => {
  it("decodes registered client metadata and sends only the exact RPC shape", async () => {
    const client = new FakeRpcClient({ data: storedClient, error: null });
    const persistence = new SupabaseOAuthPersistence(client);

    await expect(persistence.registerClient({
      clientName: "Example MCP Client",
      redirectUris: ["https://client.example/callback"],
      expiresAt: null,
    })).resolves.toEqual({
      clientId: storedClient.client_id,
      clientName: storedClient.client_name,
      redirectUris: storedClient.redirect_uris,
      createdAt: storedClient.created_at,
      expiresAt: null,
    });
    expect(client.calls).toEqual([{
      name: "register_oauth_client",
      args: {
        client_metadata: {
          client_name: "Example MCP Client",
          redirect_uris: ["https://client.example/callback"],
          expires_at: null,
        },
      },
    }]);
  });

  it("returns null for an unknown exact client id", async () => {
    const client = new FakeRpcClient({ data: null, error: null });
    const persistence = new SupabaseOAuthPersistence(client);

    await expect(persistence.getClient(storedClient.client_id)).resolves.toBeNull();
    expect(client.calls).toEqual([{
      name: "get_oauth_client",
      args: { client_id: storedClient.client_id },
    }]);
  });

  it("decodes a client returned by exact lookup", async () => {
    const expiringClient = { ...storedClient, expires_at: "2027-08-29T01:02:03.000Z" };
    const client = new FakeRpcClient({ data: expiringClient, error: null });
    const persistence = new SupabaseOAuthPersistence(client);

    await expect(persistence.getClient(storedClient.client_id)).resolves.toEqual({
      clientId: storedClient.client_id,
      clientName: storedClient.client_name,
      redirectUris: storedClient.redirect_uris,
      createdAt: storedClient.created_at,
      expiresAt: expiringClient.expires_at,
    });
  });

  it("hashes a token JTI before atomically consuming it", async () => {
    const client = new FakeRpcClient({ data: true, error: null });
    const persistence = new SupabaseOAuthPersistence(client);
    const expiresAt = new Date("2026-08-30T00:00:00.000Z");

    await expect(persistence.consume("authorization_code", "raw-code-jti", expiresAt)).resolves.toBe(true);
    expect(client.calls).toEqual([{
      name: "consume_oauth_token",
      args: {
        token_hash: "110d3139cc5a161abc92a9d0e77f29d07c776f6447956bbed76b9305ce7c3c98",
        token_kind: "authorization_code",
        expires_at: "2026-08-30T00:00:00.000Z",
      },
    }]);
  });

  it("hashes grant ids for revocation writes and reads", async () => {
    const client = new FakeRpcClient(
      { data: null, error: null },
      { data: true, error: null },
    );
    const persistence = new SupabaseOAuthPersistence(client);
    const expiresAt = new Date("2026-09-28T00:00:00.000Z");

    await expect(persistence.revokeGrant("raw-grant-family", expiresAt)).resolves.toBeUndefined();
    await expect(persistence.isGrantRevoked("raw-grant-family")).resolves.toBe(true);
    expect(client.calls).toEqual([
      {
        name: "revoke_oauth_grant",
        args: {
          grant_hash: "38f8cb91b2da7d15e2f61c25faab53569ea655f993f12798548aa8b4b10e165e",
          expires_at: "2026-09-28T00:00:00.000Z",
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
    const persistence = new SupabaseOAuthPersistence(client);

    const operation = persistence.getClient(storedClient.client_id);
    await expect(operation).rejects.toBeInstanceOf(OAuthPersistenceUnavailableError);
    await expect(operation).rejects.toThrow("OAuth persistence is temporarily unavailable");
    await expect(operation).rejects.not.toThrow(error.message);
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
});
