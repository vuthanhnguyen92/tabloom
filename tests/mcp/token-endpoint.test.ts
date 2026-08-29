import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { exportJWK, generateKeyPair, jwtDecrypt, jwtVerify, type JWK } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { openArtifact } from "../../services/tabloom-mcp/src/auth/artifacts";
import { loadFacadeAuthConfig } from "../../services/tabloom-mcp/src/auth/config";
import { signingPublicKey } from "../../services/tabloom-mcp/src/auth/key-rings";
import type { ValidatedAuthorizationRequest } from "../../services/tabloom-mcp/src/oauth/authorization-request";
import { sealAuthorizationCode } from "../../services/tabloom-mcp/src/oauth/consent";
import type { ConsentSession } from "../../services/tabloom-mcp/src/oauth/cookies";
import {
  createOAuthPersistence,
  OAuthPersistenceUnavailableError,
  type OAuthPersistence,
} from "../../services/tabloom-mcp/src/oauth/persistence";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
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
const REDIRECT_URI = "https://client.example/callback";
const USER_ID = "4f6f8607-9439-4ce3-a19e-f5a302ef3e68";
const OTHER_USER_ID = "c04ebf62-37cc-4419-9f3a-b4e24f796da9";
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = createHash("sha256").update(CODE_VERIFIER, "ascii").digest("base64url");
const ACCESS_TOKEN = "original-supabase-access-token";
const REFRESH_TOKEN = "original-supabase-refresh-token";
let privateJwk: JWK;
let consumed: Set<string>;
let revoked: boolean;
let getUser: ReturnType<typeof vi.fn>;

const authorizationRequest: ValidatedAuthorizationRequest = {
  client: {
    clientId: CLIENT_ID,
    clientName: "Example MCP Client",
    redirectUris: [REDIRECT_URI],
    source: "dcr",
  },
  redirectUri: REDIRECT_URI,
  state: "client-state",
  codeChallenge: CODE_CHALLENGE,
  resource: ORIGIN,
  scope: "tabloom:workspace",
};

const consentSession: ConsentSession = {
  request: authorizationRequest,
  userId: USER_ID,
  supabaseAccessToken: ACCESS_TOKEN,
  supabaseRefreshToken: REFRESH_TOKEN,
  supabaseAccessTokenExpiresAt: NOW + 90,
  csrfNonce: "n".repeat(43),
  authorizationCodeJti: "j".repeat(43),
  grantId: "g".repeat(43),
};

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  privateJwk = await exportJWK(privateKey);
});

function useFacadeEnvironment(enabled = true): void {
  vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("TABLOOM_MCP_RESOURCE_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ISSUER_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ENABLED", String(enabled));
  vi.stubEnv("TABLOOM_OAUTH_SIGNING_KEYS", JSON.stringify([
    { kid: "signing-key", active: true, privateJwk: { ...privateJwk, alg: "ES256" } },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_ENCRYPTION_KEYS", JSON.stringify([
    { kid: "encryption-key", active: true, rootKey: Buffer.alloc(32, 7).toString("base64url") },
  ]));
}

function persistence(): OAuthPersistence {
  return {
    async registerClient() { throw new Error("not used"); },
    async getClient() { return null; },
    async consume(kind, jti) {
      if (kind !== "authorization_code" || consumed.has(jti)) return false;
      consumed.add(jti);
      return true;
    },
    async revokeGrant() {},
    async isGrantRevoked() { return revoked; },
  };
}

function mockSupabaseUser(userId = USER_ID): void {
  getUser = vi.fn().mockResolvedValue({ data: { user: { id: userId } }, error: null });
  vi.mocked(createClient).mockReturnValue({ auth: { getUser } } as never);
}

async function authorizationCode(
  session: ConsentSession = consentSession,
  issuedAt = NOW,
): Promise<string> {
  return sealAuthorizationCode(
    session,
    loadFacadeAuthConfig(process.env).encryptionKeys,
    issuedAt,
  );
}

async function tokenRequest(
  overrides: Record<string, string> = {},
  requestOverrides: RequestInit = {},
): Promise<Response> {
  const code = overrides.code ?? await authorizationCode();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    resource: ORIGIN,
    code_verifier: CODE_VERIFIER,
    ...overrides,
  });
  const headers = new Headers(requestOverrides.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }
  const route = await import("../../services/tabloom-mcp/app/oauth/token/route");
  return route.POST(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST",
    body,
    ...requestOverrides,
    headers,
  }));
}

function expectNoStore(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Pragma")).toBe("no-cache");
}

async function expectError(response: Response, error: string, status = 400): Promise<void> {
  expect(response.status).toBe(status);
  expectNoStore(response);
  await expect(response.json()).resolves.toEqual({ error });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  useFacadeEnvironment();
  consumed = new Set();
  revoked = false;
  vi.mocked(createOAuthPersistence).mockReturnValue(persistence());
  mockSupabaseUser();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});
afterAll(() => vi.restoreAllMocks());

describe("POST /oauth/token authorization_code", () => {
  it("issues exact resource-bound tokens only after revalidating and consuming the code", async () => {
    const response = await tokenRequest();
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toMatchObject({
      token_type: "Bearer",
      expires_in: 90,
      scope: "tabloom:workspace",
    });
    expect(body.access_token).toEqual(expect.any(String));
    expect(body.refresh_token).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(body)).not.toContain(REFRESH_TOKEN);

    const config = loadFacadeAuthConfig(process.env);
    const access = await jwtVerify(
      body.access_token as string,
      signingPublicKey(config.signingKeys, "signing-key"),
      {
        algorithms: ["ES256"],
        issuer: ORIGIN,
        audience: ORIGIN,
        currentDate: new Date(NOW * 1000),
      },
    );
    expect(access.protectedHeader).toEqual({ alg: "ES256", kid: "signing-key", typ: "at+jwt" });
    expect(access.payload).toMatchObject({
      iss: ORIGIN,
      aud: ORIGIN,
      sub: USER_ID,
      client_id: CLIENT_ID,
      scope: "tabloom:workspace",
      grant_id: consentSession.grantId,
      iat: NOW,
      nbf: NOW,
      exp: NOW + 90,
    });
    expect(access.payload.jti).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(access.payload.exp).toBeLessThanOrEqual(Math.min(NOW + 600, consentSession.supabaseAccessTokenExpiresAt));

    const inner = await jwtDecrypt(
      access.payload.supabase_token as string,
      config.encryptionKeys.active!.derived("inner_access_token"),
      { currentDate: new Date(NOW * 1000) },
    );
    expect(inner.protectedHeader).toEqual({
      alg: "dir",
      enc: "A256GCM",
      kid: "encryption-key",
      typ: "tabloom+inner_access_token",
    });
    expect(inner.payload).toMatchObject({ token: ACCESS_TOKEN, exp: consentSession.supabaseAccessTokenExpiresAt });
    expect(JSON.stringify(inner.payload)).not.toContain(REFRESH_TOKEN);

    const refresh = await openArtifact<Record<string, unknown>>(
      "refresh_token",
      body.refresh_token as string,
      config.encryptionKeys,
      NOW,
    );
    expect(refresh).toMatchObject({
      supabaseRefreshToken: REFRESH_TOKEN,
      userId: USER_ID,
      clientId: CLIENT_ID,
      resource: ORIGIN,
      scope: "tabloom:workspace",
      grantId: consentSession.grantId,
      issuedAt: NOW,
      expiresAt: NOW + 30 * 24 * 60 * 60,
    });
    expect(refresh.jti).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(refresh)).not.toContain(ACCESS_TOKEN);
    expect(consumed).toEqual(new Set([consentSession.authorizationCodeJti]));
    expect(getUser).toHaveBeenCalledExactlyOnceWith(ACCESS_TOKEN);
    expect(createClient).toHaveBeenCalledWith(SUPABASE_URL + "/", "test-anon-key", {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
  });

  it("accepts only bounded form POSTs", async () => {
    await expectError(await tokenRequest({}, { headers: { "Content-Type": "application/json" } }), "invalid_request");
    await expectError(await tokenRequest({ extra: "x" }), "invalid_request");
    await expectError(await tokenRequest({ grant_type: "password" }), "invalid_request");

    const route = await import("../../services/tabloom-mcp/app/oauth/token/route");
    const oversized = new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&padding=${"x".repeat(32 * 1024)}`,
    });
    await expectError(await route.POST(oversized), "invalid_request", 413);

    const getResponse = route.GET();
    await expectError(getResponse, "invalid_request", 405);
    expect(getResponse.headers.get("Allow")).toBe("POST");
  });

  it("rejects client authentication because every client is public", async () => {
    await expectError(await tokenRequest({ client_secret: "must-not-be-accepted" }), "invalid_client", 401);
    await expectError(await tokenRequest({}, { headers: { Authorization: "Basic Zm9vOmJhcg==" } }), "invalid_client", 401);
  });

  it.each([
    ["malformed code", { code: "not-an-authorization-code" }],
    ["client mismatch", { client_id: "00000000-0000-4000-8000-000000000000" }],
    ["redirect mismatch", { redirect_uri: "https://client.example/other" }],
    ["resource mismatch", { resource: "https://other.example" }],
    ["PKCE mismatch", { code_verifier: "x".repeat(43) }],
  ])("returns the same invalid_grant for %s", async (_label, overrides) => {
    await expectError(await tokenRequest(overrides), "invalid_grant");
    expect(getUser).not.toHaveBeenCalled();
  });

  it("returns that same invalid_grant for expiry, revocation, and replay", async () => {
    const expired = await authorizationCode(consentSession, NOW - 121);
    await expectError(await tokenRequest({ code: expired }), "invalid_grant");

    revoked = true;
    await expectError(await tokenRequest(), "invalid_grant");
    revoked = false;

    const replayed = await authorizationCode();
    expect((await tokenRequest({ code: replayed })).status).toBe(200);
    await expectError(await tokenRequest({ code: replayed }), "invalid_grant");
  });

  it("has exactly one winner when duplicate approval artifacts race", async () => {
    const duplicateA = await authorizationCode();
    const duplicateB = await authorizationCode();

    const responses = await Promise.all([
      tokenRequest({ code: duplicateA }),
      tokenRequest({ code: duplicateB }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const loser = responses.find((response) => response.status === 400)!;
    await expect(loser.json()).resolves.toEqual({ error: "invalid_grant" });
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("consumes before revalidation and rejects an inner/outer subject mismatch", async () => {
    const order: string[] = [];
    const base = persistence();
    vi.mocked(createOAuthPersistence).mockReturnValue({
      ...base,
      async consume(kind, jti, expiresAt) {
        order.push("consume");
        return base.consume(kind, jti, expiresAt);
      },
    });
    getUser.mockImplementation(async () => {
      order.push("getUser");
      return { data: { user: { id: OTHER_USER_ID } }, error: null };
    });

    await expectError(await tokenRequest(), "invalid_grant");
    expect(order).toEqual(["consume", "getUser"]);
    expect(consumed).toEqual(new Set([consentSession.authorizationCodeJti]));
  });

  it("fails closed when the upstream access token is no longer valid", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "provider detail" } });

    const response = await tokenRequest();
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: "invalid_grant" });
    expect(text).not.toContain("provider detail");
    expect(consumed).toEqual(new Set([consentSession.authorizationCodeJti]));
  });

  it("never issues without durable replay protection", async () => {
    vi.mocked(createOAuthPersistence).mockReturnValue({
      ...persistence(),
      async consume() { throw new OAuthPersistenceUnavailableError(); },
    });

    await expectError(await tokenRequest(), "temporarily_unavailable", 503);
    expect(getUser).not.toHaveBeenCalled();
  });
});
