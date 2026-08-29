import { createHash } from "node:crypto";

import { exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  InMemoryOAuthRateLimitStorage,
  checkOAuthRateLimit,
  trustedVercelClientIp,
} from "../../services/tabloom-mcp/src/security/oauth-rate-limit";
import {
  createOAuthAuditContext,
  emitOAuthAudit,
} from "../../services/tabloom-mcp/src/observability/oauth-audit";
import { oauthJson } from "../../services/tabloom-mcp/src/oauth/responses";
import {
  createOAuthPersistence,
  type OAuthPersistence,
} from "../../services/tabloom-mcp/src/oauth/persistence";
import {
  createUpstreamSupabaseAuth,
  type UpstreamSupabaseAuth,
} from "../../services/tabloom-mcp/src/oauth/upstream-supabase";

vi.mock("../../services/tabloom-mcp/src/oauth/persistence", async () => {
  const actual = await vi.importActual<typeof import("../../services/tabloom-mcp/src/oauth/persistence")>(
    "../../services/tabloom-mcp/src/oauth/persistence",
  );
  return { ...actual, createOAuthPersistence: vi.fn() };
});
vi.mock("../../services/tabloom-mcp/src/oauth/upstream-supabase", async () => {
  const actual = await vi.importActual<typeof import("../../services/tabloom-mcp/src/oauth/upstream-supabase")>(
    "../../services/tabloom-mcp/src/oauth/upstream-supabase",
  );
  return { ...actual, createUpstreamSupabaseAuth: vi.fn() };
});

const ORIGIN = "https://tabloom-mcp.vercel.app";
let privateJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateJwk = await exportJWK(pair.privateKey);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

afterAll(() => vi.unstubAllEnvs());

function useFacadeEnvironment(): void {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("TABLOOM_MCP_RESOURCE_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ISSUER_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ENABLED", "true");
  vi.stubEnv("TABLOOM_OAUTH_SIGNING_KEYS", JSON.stringify([
    { kid: "signing-key", active: true, privateJwk: { ...privateJwk, alg: "ES256" } },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_ENCRYPTION_KEYS", JSON.stringify([
    { kid: "encryption-key", active: true, rootKey: Buffer.alloc(32, 41).toString("base64url") },
  ]));
}

function persistence(): OAuthPersistence {
  return {
    async registerClient(input) {
      return {
        clientId: "5c177e69-8954-4c57-a777-07c732513bea",
        clientName: input.clientName,
        redirectUris: input.redirectUris,
        createdAt: "2026-08-29T01:02:03.000Z",
        expiresAt: null,
      };
    },
    async getClient(clientId) {
      return {
        clientId,
        clientName: "Rate Limit Client",
        redirectUris: ["https://client.example/callback"],
        createdAt: "2026-08-29T01:02:03.000Z",
        expiresAt: null,
      };
    },
    async consume() { return false; },
    async revokeGrant() {},
    async isGrantRevoked() { return false; },
  };
}

function upstream(): UpstreamSupabaseAuth {
  return {
    async begin() {
      return {
        providerUrl: "https://example.supabase.co/auth/v1/authorize?provider=google",
        codeVerifier: "v".repeat(64),
      };
    },
    async exchange() {
      throw new Error("unused");
    },
  };
}

function expectRateLimited(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toMatch(/^([1-9]|[1-5][0-9]|60)$/);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  return expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
}

describe("OAuth fixed-window abuse damping", () => {
  it("allows the configured count, then returns the remaining fixed-window delay", async () => {
    const storage = new InMemoryOAuthRateLimitStorage();
    const request = new Request(`${ORIGIN}/oauth/register`, {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });

    for (let index = 0; index < 20; index += 1) {
      await expect(checkOAuthRateLimit({
        route: "register",
        request,
        storage,
        nowMs: 12_345,
      })).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    await expect(checkOAuthRateLimit({
      route: "register",
      request,
      storage,
      nowMs: 12_345,
    })).resolves.toEqual({ allowed: false, retryAfterSeconds: 48 });

    await expect(checkOAuthRateLimit({
      route: "register",
      request,
      storage,
      nowMs: 60_000,
    })).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("uses only a valid first forwarded address and never scans attacker-controlled later values", () => {
    expect(trustedVercelClientIp(new Headers({
      "x-forwarded-for": "2001:db8::8, 10.0.0.1",
    }))).toBe("2001:db8::8");
    expect(trustedVercelClientIp(new Headers({
      "x-forwarded-for": "attacker.invalid, 203.0.113.9",
    }))).toBeNull();
    expect(trustedVercelClientIp(new Headers({
      "x-forwarded-for": "203.0.113.9:443, 198.51.100.2",
    }))).toBeNull();
    expect(trustedVercelClientIp(new Headers())).toBeNull();
  });

  it("groups invalid first forwarded values into one fail-safe bucket", async () => {
    const storage = new InMemoryOAuthRateLimitStorage();
    for (let index = 0; index < 20; index += 1) {
      const result = await checkOAuthRateLimit({
        route: "register",
        request: new Request(`${ORIGIN}/oauth/register`, {
          headers: { "x-forwarded-for": `invalid-${index}, 203.0.113.${index + 1}` },
        }),
        storage,
        nowMs: 100,
      });
      expect(result.allowed).toBe(true);
    }
    await expect(checkOAuthRateLimit({
      route: "register",
      request: new Request(`${ORIGIN}/oauth/register`, {
        headers: { "x-forwarded-for": "still-invalid, 198.51.100.20" },
      }),
      storage,
      nowMs: 100,
    })).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it("uses route-specific limits and hashes token client identifiers before storage", async () => {
    const calls: string[] = [];
    const storage = {
      async increment(key: string) {
        calls.push(key);
        return calls.length;
      },
    };
    const request = new Request(`${ORIGIN}/oauth/token`);
    await checkOAuthRateLimit({
      route: "token",
      request,
      clientId: "sensitive-client-id",
      storage,
      nowMs: 1,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(createHash("sha256").update("sensitive-client-id").digest("hex"));
    expect(calls[0]).not.toContain("sensitive-client-id");
  });

  it("fails open when replaceable limiter storage is unavailable", async () => {
    const request = new Request(`${ORIGIN}/oauth/revoke`, {
      headers: { "x-forwarded-for": "203.0.113.70" },
    });

    await expect(checkOAuthRateLimit({
      route: "revoke",
      request,
      storage: {
        async increment() {
          throw new Error("edge storage unavailable");
        },
      },
      nowMs: 1,
    })).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
  });
});

describe("allowlisted OAuth audit events and response headers", () => {
  it("emits only categorical fields, a correlation ID, and hashed identifiers", () => {
    const sink = vi.fn();
    const context = createOAuthAuditContext("token", 1_000, "00000000-0000-4000-8000-000000000001");

    emitOAuthAudit(context, {
      resultClass: "client_error",
      clientId: "raw-client-id",
      grantId: "raw-grant-id",
      nowMs: 1_125,
    }, sink);

    expect(sink).toHaveBeenCalledOnce();
    const event = sink.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual([
      "clientHash",
      "correlationId",
      "grantHash",
      "latencyBucket",
      "resultClass",
      "routeCategory",
    ]);
    expect(event).toEqual({
      routeCategory: "token",
      latencyBucket: "100-999ms",
      resultClass: "client_error",
      correlationId: "00000000-0000-4000-8000-000000000001",
      clientHash: createHash("sha256").update("raw-client-id").digest("hex"),
      grantHash: createHash("sha256").update("raw-grant-id").digest("hex"),
    });
    expect(JSON.stringify(event)).not.toContain("raw-client-id");
    expect(JSON.stringify(event)).not.toContain("raw-grant-id");
  });

  it("adds immutable no-store and nosniff headers to OAuth JSON", async () => {
    const response = oauthJson({ error: "invalid_request" }, 400);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });
});

describe("OAuth route security integration", () => {
  it("enforces 20 registration attempts per forwarded IP per minute", async () => {
    useFacadeEnvironment();
    vi.mocked(createOAuthPersistence).mockReturnValue(persistence());
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const route = await import("../../services/tabloom-mcp/app/oauth/register/route");
    const request = () => new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.20",
      },
      body: JSON.stringify({
        client_name: "Rate Limit Client",
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

    for (let index = 0; index < 20; index += 1) {
      expect((await route.POST(request())).status).toBe(201);
    }
    await expectRateLimited(await route.POST(request()));
  });

  it("enforces 30 authorization attempts per forwarded IP per minute", async () => {
    useFacadeEnvironment();
    vi.mocked(createOAuthPersistence).mockReturnValue(persistence());
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(upstream());
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const route = await import("../../services/tabloom-mcp/app/oauth/authorize/route");
    const request = () => {
      const url = new URL(`${ORIGIN}/oauth/authorize`);
      Object.entries({
        response_type: "code",
        client_id: "5c177e69-8954-4c57-a777-07c732513bea",
        redirect_uri: "https://client.example/callback",
        state: "state",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: ORIGIN,
        scope: "tabloom:workspace",
      }).forEach(([key, value]) => url.searchParams.set(key, value));
      return new Request(url, { headers: { "x-forwarded-for": "203.0.113.30" } });
    };

    for (let index = 0; index < 30; index += 1) {
      expect((await route.GET(request())).status).toBe(302);
    }
    await expectRateLimited(await route.GET(request()));
  });

  it("enforces 30 token attempts per client per minute", async () => {
    useFacadeEnvironment();
    vi.mocked(createOAuthPersistence).mockReturnValue(persistence());
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const route = await import("../../services/tabloom-mcp/app/oauth/token/route");
    const request = () => new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "invalid-code",
        client_id: "rate-limit-token-client",
        redirect_uri: "https://client.example/callback",
        resource: ORIGIN,
        code_verifier: "v".repeat(64),
      }),
    });

    for (let index = 0; index < 30; index += 1) {
      expect((await route.POST(request())).status).toBe(400);
    }
    await expectRateLimited(await route.POST(request()));
    const output = JSON.stringify(log.mock.calls);
    expect(output).not.toContain("invalid-code");
    expect(output).not.toContain("rate-limit-token-client");
    expect(output).not.toContain("v".repeat(64));
    for (const [event] of log.mock.calls) {
      expect(Object.keys(event as Record<string, unknown>).sort()).toEqual([
        "clientHash",
        "correlationId",
        "latencyBucket",
        "resultClass",
        "routeCategory",
      ]);
    }
  });

  it("enforces 60 revocation attempts per forwarded IP per minute", async () => {
    useFacadeEnvironment();
    vi.mocked(createOAuthPersistence).mockReturnValue(persistence());
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const route = await import("../../services/tabloom-mcp/app/oauth/revoke/route");
    const request = () => new Request(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "203.0.113.60",
      },
      body: new URLSearchParams({ token: "unknown-token" }),
    });

    for (let index = 0; index < 60; index += 1) {
      expect((await route.POST(request())).status).toBe(200);
    }
    await expectRateLimited(await route.POST(request()));
  });

  it("uses one correlation ID for an unexpected error response and its redacted audit event", async () => {
    useFacadeEnvironment();
    vi.mocked(createOAuthPersistence).mockImplementation(() => {
      throw new Error("provider-token=https://secret.example/?code=raw-code");
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const route = await import("../../services/tabloom-mcp/app/oauth/register/route");
    const response = await route.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "198.51.100.99",
      },
      body: JSON.stringify({
        client_name: "Unexpected Error Client",
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }));

    expect(response.status).toBe(500);
    const body = await response.json() as { correlation_id: string };
    const event = log.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event.correlationId).toBe(body.correlation_id);
    expect(Object.keys(event).sort()).toEqual([
      "correlationId",
      "latencyBucket",
      "resultClass",
      "routeCategory",
    ]);
    expect(JSON.stringify(event)).not.toMatch(/provider-token|secret\.example|raw-code|198\.51\.100\.99/);
  });
});
