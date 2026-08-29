import { exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OAuthInvalidClientMetadataError,
  OAuthPersistenceUnavailableError,
  OAuthRegistrationCapacityError,
  createOAuthPersistence,
  type OAuthPersistence,
} from "../../services/tabloom-mcp/src/oauth/persistence";

vi.mock("../../services/tabloom-mcp/src/oauth/persistence", async () => {
  const actual = await vi.importActual<typeof import("../../services/tabloom-mcp/src/oauth/persistence")>(
    "../../services/tabloom-mcp/src/oauth/persistence",
  );
  return { ...actual, createOAuthPersistence: vi.fn() };
});

const ORIGIN = "https://mcp.tabloom.app";
const registration = {
  client_name: "Example MCP Client",
  redirect_uris: ["https://client.example/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

async function useFacadeEnvironment(enabled: boolean) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("TABLOOM_MCP_RESOURCE_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ISSUER_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ENABLED", String(enabled));
  vi.stubEnv("TABLOOM_OAUTH_SIGNING_KEYS", JSON.stringify([
    { kid: "signing-key", active: true, privateJwk: { ...privateJwk, alg: "ES256" } },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_ENCRYPTION_KEYS", JSON.stringify([
    { kid: "encryption-key", active: true, rootKey: Buffer.alloc(32, 1).toString("base64url") },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_DATABASE_SECRET", Buffer.alloc(32, 9).toString("base64url"));
}

function persistence(): OAuthPersistence {
  return {
    async registerClient() {
      return {
        clientId: "5c177e69-8954-4c57-a777-07c732513bea",
        clientName: "Example MCP Client",
        redirectUris: ["https://client.example/callback"],
        createdAt: "2026-08-29T01:02:03.000Z",
        expiresAt: "2026-08-30T01:02:03.000Z",
      };
    },
    async getClient() { return null; },
    async consume() { return false; },
    async revokeGrant() {},
    async isGrantRevoked() { return false; },
  };
}

function rejectingPersistence(error: Error): OAuthPersistence {
  return {
    ...persistence(),
    async registerClient() { throw error; },
  };
}

function expectNoStore(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Pragma")).toBe("no-cache");
}

async function route() {
  return import("../../services/tabloom-mcp/app/oauth/register/route");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("public dynamic client registration", () => {
  it("serves a no-store CORS preflight for the POST-only endpoint", async () => {
    await useFacadeEnvironment(true);
    const handler = await route();

    const response = handler.OPTIONS();

    expect(response.status).toBe(204);
    expectNoStore(response);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
  });

  it("returns a safe temporarily_unavailable error until the facade is enabled", async () => {
    await useFacadeEnvironment(false);
    const handler = await route();

    const response = await handler.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...registration, client_secret: "do-not-echo" }),
    }));

    expect(response.status).toBe(503);
    expectNoStore(response);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "temporarily_unavailable" });
    expect(body).not.toContain("do-not-echo");
  });

  it("returns the fixed no-store 405 contract for every unsupported HTTP method", async () => {
    await useFacadeEnvironment(true);
    const handler = await route();

    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"] as const) {
      const response = await (handler as unknown as Record<
        string,
        (request: Request) => Response | Promise<Response>
      >)[method]!(
        new Request(`${ORIGIN}/oauth/register`, { method }),
      );

      expect(response.status).toBe(405);
      expectNoStore(response);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Allow")).toBe("POST, OPTIONS");
      await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    }
  });

  it("rejects non-JSON POST requests with a fixed no-store error", async () => {
    await useFacadeEnvironment(true);
    const handler = await route();

    const response = await handler.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(registration),
    }));

    expect(response.status).toBe(400);
    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("does not disclose malformed JSON parser details", async () => {
    await useFacadeEnvironment(true);
    const handler = await route();
    const parserDetail = "parser detail must not be reflected";

    const response = await handler.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"client_name":"${parserDetail}`,
    }));

    expect(response.status).toBe(400);
    expectNoStore(response);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "invalid_request" });
    expect(body).not.toContain(parserDetail);
  });

  it("does not disclose invalid UTF-8 bytes", async () => {
    await useFacadeEnvironment(true);
    const handler = await route();

    const response = await handler.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    }));

    expect(response.status).toBe(400);
    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("rejects JSON request bodies larger than 32 KiB without reflecting them", async () => {
    await useFacadeEnvironment(true);
    const handler = await route();
    const secret = "secret-value-that-must-not-leak";
    const payload = JSON.stringify({ ...registration, unknown: `${secret}${"x".repeat(32 * 1024)}` });

    const response = await handler.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    }));

    expect(response.status).toBe(413);
    expectNoStore(response);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "invalid_request" });
    expect(body).not.toContain(secret);
  });

  it("returns invalid_client_metadata without echoing rejected client fields", async () => {
    await useFacadeEnvironment(true);
    const handler = await route();
    const secret = "not-a-client-secret";

    const response = await handler.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...registration, client_secret: secret, unknown: "do-not-echo" }),
    }));

    expect(response.status).toBe(400);
    expectNoStore(response);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "invalid_client_metadata" });
    expect(body).not.toContain(secret);
    expect(body).not.toContain("unknown");
  });

  it("maps defensive database metadata rejection to invalid_client_metadata", async () => {
    await useFacadeEnvironment(true);
    vi.mocked(createOAuthPersistence).mockReturnValue(
      rejectingPersistence(new OAuthInvalidClientMetadataError()),
    );
    const handler = await route();

    const response = await handler.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    }));

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({ error: "invalid_client_metadata" });
  });

  it("maps registration capacity to a fixed retryable 429 and rate-limited audit", async () => {
    await useFacadeEnvironment(true);
    vi.mocked(createOAuthPersistence).mockReturnValue(
      rejectingPersistence(new OAuthRegistrationCapacityError()),
    );
    const audit = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const handler = await route();

    const response = await handler.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    }));

    expect(response.status).toBe(429);
    expectNoStore(response);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      routeCategory: "register",
      resultClass: "rate_limited",
    }));
  });

  it("keeps persistence outages on the sanitized dependency response", async () => {
    await useFacadeEnvironment(true);
    vi.mocked(createOAuthPersistence).mockReturnValue(
      rejectingPersistence(new OAuthPersistenceUnavailableError()),
    );
    const handler = await route();

    const response = await handler.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    }));

    expect(response.status).toBe(503);
    expectNoStore(response);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
  });

  it("sanitizes unexpected registration failures", async () => {
    await useFacadeEnvironment(true);
    const privateDetail = "private database identifier oauth_clients_internal";
    vi.mocked(createOAuthPersistence).mockReturnValue(
      rejectingPersistence(new Error(privateDetail)),
    );
    const handler = await route();

    const response = await handler.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    }));

    expect(response.status).toBe(500);
    expectNoStore(response);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: "server_error" });
    expect(body).not.toContain(privateDetail);
  });

  it("registers only validated public metadata and never returns a client secret", async () => {
    await useFacadeEnvironment(true);
    vi.mocked(createOAuthPersistence).mockReturnValue(persistence());
    const handler = await route();

    const response = await handler.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(registration),
    }));

    expect(response.status).toBe(201);
    expectNoStore(response);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({
      client_id: "5c177e69-8954-4c57-a777-07c732513bea",
      client_name: "Example MCP Client",
      redirect_uris: ["https://client.example/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(body.client_secret).toBeUndefined();
  });
});
