import {
  decodeJwt,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK,
  type JWSHeaderParameters,
  type JWTPayload,
} from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { issueAccessToken } from "../../services/tabloom-mcp/src/auth/access-token";
import { sealArtifact } from "../../services/tabloom-mcp/src/auth/artifacts";
import { loadFacadeAuthConfig } from "../../services/tabloom-mcp/src/auth/config";
import {
  createOAuthPersistence,
  OAuthPersistenceUnavailableError,
  type OAuthPersistence,
} from "../../services/tabloom-mcp/src/oauth/persistence";
import {
  REFRESH_TOKEN_LIFETIME_SECONDS,
  type RefreshTokenPayload,
} from "../../services/tabloom-mcp/src/oauth/token-service";

vi.mock("../../services/tabloom-mcp/src/oauth/persistence", async () => {
  const actual = await vi.importActual<typeof import("../../services/tabloom-mcp/src/oauth/persistence")>(
    "../../services/tabloom-mcp/src/oauth/persistence",
  );
  return { ...actual, createOAuthPersistence: vi.fn() };
});

const NOW = 1_788_000_000;
const ORIGIN = "https://tabloom-mcp.vercel.app";
const SUPABASE_URL = "https://exact-project.supabase.co";
const CLIENT_ID = "5c177e69-8954-4c57-a777-07c732513bea";
const USER_ID = "4f6f8607-9439-4ce3-a19e-f5a302ef3e68";
const GRANT_ID = "g".repeat(43);
const ATTACKER_GRANT_ID = "a".repeat(43);
const REFRESH_JTI = "r".repeat(43);
let privateJwk: JWK;
let revoked: boolean;
let revokeCalls: Array<{ grantId: string; expiresAt: Date }>;
let consumeCalls: Array<{ kind: string; jti: string; expiresAt: Date }>;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  privateJwk = await exportJWK(privateKey);
});

function useFacadeEnvironment(enabled = true, signingJwk = privateJwk, encryptionByte = 7): void {
  vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("TABLOOM_MCP_RESOURCE_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ISSUER_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ENABLED", String(enabled));
  vi.stubEnv("TABLOOM_OAUTH_SIGNING_KEYS", JSON.stringify([
    { kid: "signing-key", active: true, privateJwk: { ...signingJwk, alg: "ES256" } },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_ENCRYPTION_KEYS", JSON.stringify([
    {
      kid: "encryption-key",
      active: true,
      rootKey: Buffer.alloc(32, encryptionByte).toString("base64url"),
    },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_DATABASE_SECRET", Buffer.alloc(32, 9).toString("base64url"));
}

function persistence(): OAuthPersistence {
  return {
    async registerClient() { throw new Error("not used"); },
    async getClient() { return null; },
    async consume(kind, jti, expiresAt) {
      consumeCalls.push({ kind, jti, expiresAt });
      return true;
    },
    async revokeGrant(grantId, expiresAt) {
      revokeCalls.push({ grantId, expiresAt });
    },
    async isGrantRevoked() { return revoked; },
  };
}

async function accessToken(
  issuedAt = NOW,
  innerExpiresAt = issuedAt + 600,
): Promise<string> {
  return issueAccessToken({
    sub: USER_ID,
    clientId: CLIENT_ID,
    grantId: GRANT_ID,
    supabaseToken: "upstream-access-token",
    innerExpiresAt,
  }, loadFacadeAuthConfig(process.env), issuedAt);
}

async function handSignedAccessToken(
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Partial<JWSHeaderParameters> = {},
): Promise<string> {
  const issuedPayload = decodeJwt(await accessToken());
  const payload = {
    ...issuedPayload,
    grant_id: ATTACKER_GRANT_ID,
    ...payloadOverrides,
  } as JWTPayload;
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: "ES256",
      kid: "signing-key",
      typ: "at+jwt",
      ...headerOverrides,
    })
    .sign(await importJWK({ ...privateJwk, alg: "ES256" }, "ES256"));
}

function refreshPayload(overrides: Partial<RefreshTokenPayload> = {}): RefreshTokenPayload {
  return {
    supabaseRefreshToken: "upstream-refresh-token",
    userId: USER_ID,
    clientId: CLIENT_ID,
    resource: ORIGIN,
    scope: "tabloom:workspace",
    grantId: GRANT_ID,
    jti: REFRESH_JTI,
    issuedAt: NOW,
    expiresAt: NOW + REFRESH_TOKEN_LIFETIME_SECONDS,
    ...overrides,
  };
}

async function refreshToken(
  overrides: Partial<RefreshTokenPayload> = {},
  issuedAt = NOW,
): Promise<string> {
  return sealArtifact(
    "refresh_token",
    refreshPayload(overrides),
    REFRESH_TOKEN_LIFETIME_SECONDS,
    loadFacadeAuthConfig(process.env).encryptionKeys,
    issuedAt,
  );
}

async function revokeRequest(
  token: string,
  tokenTypeHint?: string,
  requestOverrides: RequestInit = {},
): Promise<Response> {
  const body = new URLSearchParams({ token });
  if (tokenTypeHint !== undefined) body.set("token_type_hint", tokenTypeHint);
  const headers = new Headers(requestOverrides.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }
  const route = await import("../../services/tabloom-mcp/app/oauth/revoke/route");
  return route.POST(new Request(`${ORIGIN}/oauth/revoke`, {
    method: "POST",
    body,
    ...requestOverrides,
    headers,
  }));
}

function expectNoStore(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
}

async function expectEmptySuccess(response: Response): Promise<void> {
  expect(response.status).toBe(200);
  expectNoStore(response);
  expect(response.headers.get("Content-Type")).toBeNull();
  await expect(response.text()).resolves.toBe("");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  useFacadeEnvironment();
  revoked = false;
  revokeCalls = [];
  consumeCalls = [];
  vi.mocked(createOAuthPersistence).mockReturnValue(persistence());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});
afterAll(() => vi.restoreAllMocks());

describe("POST /oauth/revoke", () => {
  it("revokes the grant family represented by a valid access token", async () => {
    const response = await revokeRequest(await accessToken(), "access_token");

    await expectEmptySuccess(response);
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0]!.grantId).toBe(GRANT_ID);
    expect(revokeCalls[0]!.expiresAt.getTime()).toBe(
      (NOW + REFRESH_TOKEN_LIFETIME_SECONDS) * 1000,
    );
    expect(consumeCalls).toEqual([]);
  });

  it("revokes a refresh grant and attempts to consume the presented JTI", async () => {
    const response = await revokeRequest(await refreshToken(), "access_token");

    await expectEmptySuccess(response);
    expect(revokeCalls).toEqual([{
      grantId: GRANT_ID,
      expiresAt: new Date((NOW + REFRESH_TOKEN_LIFETIME_SECONDS) * 1000),
    }]);
    expect(consumeCalls).toEqual([{
      kind: "refresh_token",
      jti: REFRESH_JTI,
      expiresAt: new Date((NOW + REFRESH_TOKEN_LIFETIME_SECONDS) * 1000),
    }]);
  });

  it("returns the same empty success for unknown, malformed, wrong-key, expired, and revoked tokens", async () => {
    const expiredAccess = await accessToken(NOW - 601, NOW - 1);
    const expiredRefresh = await refreshToken({
      issuedAt: NOW - REFRESH_TOKEN_LIFETIME_SECONDS - 1,
      expiresAt: NOW - 1,
    }, NOW - REFRESH_TOKEN_LIFETIME_SECONDS - 1);

    useFacadeEnvironment(true, privateJwk, 8);
    const wrongKey = await refreshToken();
    useFacadeEnvironment();
    revoked = true;

    const tokens = [
      "unknown-token",
      "not.a.valid.compact.artifact",
      wrongKey,
      expiredAccess,
      expiredRefresh,
      await accessToken(),
    ];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (const token of tokens) {
      await expectEmptySuccess(await revokeRequest(token));
    }

    expect(consoleError).not.toHaveBeenCalled();
    expect(JSON.stringify(revokeCalls)).not.toContain("upstream-access-token");
    expect(JSON.stringify(revokeCalls)).not.toContain("upstream-refresh-token");
  });

  it.each([
    ["non-UUID subject", { sub: "attacker-subject" }, {}],
    ["non-versioned DCR-shaped client", { client_id: "00000000-0000-0000-0000-000000000000" }, {}],
    ["HTTP client metadata identifier", { client_id: "http://client.example/oauth.json" }, {}],
    ["credentialed client metadata identifier", { client_id: "https://user:pass@client.example/oauth.json" }, {}],
    ["fragmented client metadata identifier", { client_id: "https://client.example/oauth.json#fragment" }, {}],
    ["wildcard client metadata identifier", { client_id: "https://*.client.example/oauth.json" }, {}],
    ["whitespace-padded client metadata identifier", { client_id: " https://client.example/oauth.json" }, {}],
    ["invalid grant identifier", { grant_id: "attacker-grant" }, {}],
    ["invalid access JTI", { jti: "attacker-jti" }, {}],
    ["wrong scope", { scope: "other:scope" }, {}],
    ["wrong issuer", { iss: "https://attacker.example" }, {}],
    ["wrong audience", { aud: "https://attacker.example" }, {}],
    ["overlong access lifetime", { exp: NOW + 601 }, {}],
    ["inconsistent issue/not-before time", { iat: NOW - 1, nbf: NOW }, {}],
    ["unexpected claim", { attacker_claim: "present" }, {}],
    ["malformed inner credential", { supabase_token: "not-an-inner-jwe" }, {}],
    ["empty inner credential", { supabase_token: "" }, {}],
    ["wrong access-token type", {}, { typ: "JWT" }],
  ])(
    "does not revoke an attacker-chosen grant from a hand-signed token with %s",
    async (_label, payloadOverrides, headerOverrides) => {
      const token = await handSignedAccessToken(payloadOverrides, headerOverrides);

      await expectEmptySuccess(await revokeRequest(token, "access_token"));

      expect(revokeCalls).toEqual([]);
      expect(consumeCalls).toEqual([]);
    },
  );

  it("does not treat another encrypted artifact purpose as an inner access credential", async () => {
    const token = await handSignedAccessToken({ supabase_token: await refreshToken() });

    await expectEmptySuccess(await revokeRequest(token, "access_token"));

    expect(revokeCalls).toEqual([]);
    expect(consumeCalls).toEqual([]);
  });

  it.each([
    CLIENT_ID,
    "https://client.example/oauth/metadata.json",
    "https://client.example",
    "https://CLIENT.example/oauth.json",
    "https://client.example:443/oauth.json",
  ])("accepts the client metadata identifier %s in a strict access token", async (clientId) => {
    const token = await handSignedAccessToken({
      client_id: clientId,
    });

    await expectEmptySuccess(await revokeRequest(token, "access_token"));

    expect(revokeCalls).toEqual([{
      grantId: ATTACKER_GRANT_ID,
      expiresAt: new Date((NOW + REFRESH_TOKEN_LIFETIME_SECONDS) * 1000),
    }]);
  });

  it.each(["revoke", "consume"])(
    "returns temporarily_unavailable when durable %s state cannot be written",
    async (operation) => {
      const base = persistence();
      vi.mocked(createOAuthPersistence).mockReturnValue({
        ...base,
        async revokeGrant(grantId, expiresAt) {
          if (operation === "revoke") throw new OAuthPersistenceUnavailableError();
          return base.revokeGrant(grantId, expiresAt);
        },
        async consume(kind, jti, expiresAt) {
          if (operation === "consume") throw new OAuthPersistenceUnavailableError();
          return base.consume(kind, jti, expiresAt);
        },
      });

      const token = operation === "revoke" ? await accessToken() : await refreshToken();
      const response = await revokeRequest(token);

      expect(response.status).toBe(503);
      expectNoStore(response);
      await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    },
  );

  it("keeps the endpoint form-only, public-client, exact, bounded, and no-store", async () => {
    const token = await accessToken();
    const wrongContentType = await revokeRequest(token, undefined, {
      headers: { "Content-Type": "application/json" },
    });
    expect(wrongContentType.status).toBe(400);
    expectNoStore(wrongContentType);
    await expect(wrongContentType.json()).resolves.toEqual({ error: "invalid_request" });

    const authorization = await revokeRequest(token, undefined, {
      headers: { Authorization: "Basic Zm9vOmJhcg==" },
    });
    expect(authorization.status).toBe(401);
    expectNoStore(authorization);
    await expect(authorization.json()).resolves.toEqual({ error: "invalid_client" });

    const route = await import("../../services/tabloom-mcp/app/oauth/revoke/route");
    const secret = await route.POST(new Request(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_secret: "secret" }),
    }));
    expect(secret.status).toBe(401);
    expectNoStore(secret);
    await expect(secret.json()).resolves.toEqual({ error: "invalid_client" });

    const unknown = await route.POST(new Request(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, extra: "x" }),
    }));
    expect(unknown.status).toBe(400);
    expectNoStore(unknown);
    await expect(unknown.json()).resolves.toEqual({ error: "invalid_request" });

    const oversized = await route.POST(new Request(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${"x".repeat(32 * 1024)}`,
    }));
    expect(oversized.status).toBe(413);
    expectNoStore(oversized);
    await expect(oversized.json()).resolves.toEqual({ error: "invalid_request" });

    const getResponse = route.GET();
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("Allow")).toBe("POST");
    expectNoStore(getResponse);
    await expect(getResponse.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("returns temporarily_unavailable without touching persistence when OAuth is disabled", async () => {
    useFacadeEnvironment(false);

    const response = await revokeRequest("unknown-token");

    expect(response.status).toBe(503);
    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(createOAuthPersistence).not.toHaveBeenCalled();
  });
});
