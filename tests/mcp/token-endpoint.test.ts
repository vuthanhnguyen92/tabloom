import { createHash } from "node:crypto";

import { AuthRetryableFetchError, createClient } from "@supabase/supabase-js";
import { exportJWK, generateKeyPair, jwtDecrypt, jwtVerify, type JWK } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { openArtifact, sealArtifact } from "../../services/tabloom-mcp/src/auth/artifacts";
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
import {
  REFRESH_TOKEN_LIFETIME_SECONDS,
  type RefreshTokenPayload,
} from "../../services/tabloom-mcp/src/oauth/token-service";

vi.mock("@supabase/supabase-js", async () => {
  const actual = await vi.importActual<typeof import("@supabase/supabase-js")>(
    "@supabase/supabase-js",
  );
  return { ...actual, createClient: vi.fn() };
});
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
const ROTATED_ACCESS_TOKEN = "rotated-supabase-access-token";
const ROTATED_REFRESH_TOKEN = "rotated-supabase-refresh-token";
let privateJwk: JWK;
let consumed: Set<string>;
let revoked: boolean;
let revocationExpiries: Date[];
let getUser: ReturnType<typeof vi.fn>;
let refreshSession: ReturnType<typeof vi.fn>;

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
    async consume(_kind, jti) {
      if (consumed.has(jti)) return false;
      consumed.add(jti);
      return true;
    },
    async revokeGrant(_grantId, expiresAt) {
      revoked = true;
      revocationExpiries.push(expiresAt);
    },
    async isGrantRevoked() { return revoked; },
  };
}

function mockSupabaseUser(userId = USER_ID): void {
  getUser = vi.fn().mockResolvedValue({ data: { user: { id: userId } }, error: null });
  refreshSession = vi.fn().mockResolvedValue({
    data: {
      user: { id: userId },
      session: {
        access_token: ROTATED_ACCESS_TOKEN,
        refresh_token: ROTATED_REFRESH_TOKEN,
        expires_at: NOW + 300,
      },
    },
    error: null,
  });
  vi.mocked(createClient).mockReturnValue({ auth: { getUser, refreshSession } } as never);
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

async function rawTokenRequest(body: string, requestOverrides: RequestInit = {}): Promise<Response> {
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

function authorizationCodeForm(code: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    resource: ORIGIN,
    code_verifier: CODE_VERIFIER,
  });
}

function refreshPayload(overrides: Partial<RefreshTokenPayload> = {}): RefreshTokenPayload {
  return {
    supabaseRefreshToken: REFRESH_TOKEN,
    userId: USER_ID,
    clientId: CLIENT_ID,
    resource: ORIGIN,
    scope: "tabloom:workspace",
    grantId: consentSession.grantId,
    jti: "r".repeat(43),
    issuedAt: NOW,
    expiresAt: NOW + REFRESH_TOKEN_LIFETIME_SECONDS,
    ...overrides,
  };
}

async function refreshArtifact(
  overrides: Partial<RefreshTokenPayload> = {},
  issuedAt = NOW,
  purpose: "refresh_token" | "authorization_code" = "refresh_token",
): Promise<string> {
  return sealArtifact(
    purpose,
    refreshPayload(overrides),
    purpose === "refresh_token" ? REFRESH_TOKEN_LIFETIME_SECONDS : 120,
    loadFacadeAuthConfig(process.env).encryptionKeys,
    issuedAt,
  );
}

async function refreshTokenRequest(
  refreshToken: string,
  overrides: Record<string, string> = {},
  requestOverrides: RequestInit = {},
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    resource: ORIGIN,
    scope: "tabloom:workspace",
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

async function revokeTokenRequest(token: string): Promise<Response> {
  const route = await import("../../services/tabloom-mcp/app/oauth/revoke/route");
  return route.POST(new Request(`${ORIGIN}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: "refresh_token" }),
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
  revocationExpiries = [];
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
    expect(Object.keys(refresh).sort()).toEqual([
      "clientId",
      "expiresAt",
      "grantId",
      "issuedAt",
      "jti",
      "resource",
      "scope",
      "supabaseRefreshToken",
      "userId",
    ]);
    expect(refresh.jti).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(refresh)).not.toContain(ACCESS_TOKEN);
    expect(consumed).toEqual(new Set([consentSession.authorizationCodeJti]));
    expect(getUser).toHaveBeenCalledExactlyOnceWith(ACCESS_TOKEN);
    expect(createClient).toHaveBeenCalledWith(SUPABASE_URL + "/", "test-anon-key", {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
  });

  it("caps a long-lived upstream session to a 600-second access token", async () => {
    const longLivedSession: ConsentSession = {
      ...consentSession,
      supabaseAccessTokenExpiresAt: NOW + 3600,
      authorizationCodeJti: "l".repeat(43),
    };
    const response = await tokenRequest({ code: await authorizationCode(longLivedSession) });
    const body = await response.json() as Record<string, unknown>;
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

    expect(response.status).toBe(200);
    expect(body.expires_in).toBe(600);
    expect(access.payload.exp).toBe(NOW + 600);
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

  it.each(["%FF", "%C3%28"])(
    "rejects invalid percent-decoded UTF-8 %s as invalid_request",
    async (invalidUtf8) => {
      const form = authorizationCodeForm(await authorizationCode()).toString();
      const body = form.replace(
        `code_verifier=${encodeURIComponent(CODE_VERIFIER)}`,
        `code_verifier=${invalidUtf8}`,
      );

      await expectError(await rawTokenRequest(body), "invalid_request");
      expect(createOAuthPersistence).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
    },
  );

  it("rejects declared and streamed bodies above 32 KiB but accepts the exact boundary", async () => {
    const declaredOversized = authorizationCodeForm(await authorizationCode()).toString();
    await expectError(await rawTokenRequest(declaredOversized, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(32 * 1024 + 1),
      },
    }), "invalid_request", 413);

    const prefix = "grant_type=authorization_code&code=";
    const suffix = `&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&resource=${encodeURIComponent(ORIGIN)}&code_verifier=${CODE_VERIFIER}`;
    const boundaryBody = `${prefix}${"x".repeat(32 * 1024 - prefix.length - suffix.length)}${suffix}`;
    expect(Buffer.byteLength(boundaryBody, "utf8")).toBe(32 * 1024);
    await expectError(await rawTokenRequest(boundaryBody), "invalid_grant");

    await expectError(await rawTokenRequest(`${boundaryBody}x`), "invalid_request", 413);
  });

  it("rejects duplicate, missing, and empty required form values", async () => {
    const form = authorizationCodeForm(await authorizationCode());
    await expectError(
      await rawTokenRequest(`${form.toString()}&client_id=${encodeURIComponent(CLIENT_ID)}`),
      "invalid_request",
    );

    const missing = new URLSearchParams(form);
    missing.delete("redirect_uri");
    await expectError(await rawTokenRequest(missing.toString()), "invalid_request");

    const empty = new URLSearchParams(form);
    empty.set("resource", "");
    await expectError(await rawTokenRequest(empty.toString()), "invalid_request");
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

  it("returns 503 after consuming a code when getUser resolves with a retryable fetch error", async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError("network detail must stay private", 0),
    });

    const first = await tokenRequest();
    const second = await tokenRequest();

    await expectError(first, "temporarily_unavailable", 503);
    await expectError(second, "invalid_grant");
    expect(consumed).toEqual(new Set([consentSession.authorizationCodeJti]));
    expect(getUser).toHaveBeenCalledTimes(1);
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

describe("POST /oauth/token refresh_token", () => {
  it("rotates both credentials with fresh JTIs while preserving the bound grant", async () => {
    const initialResponse = await tokenRequest();
    const initialBody = await initialResponse.json() as Record<string, unknown>;
    const config = loadFacadeAuthConfig(process.env);
    const initialAccess = await jwtVerify(
      initialBody.access_token as string,
      signingPublicKey(config.signingKeys, "signing-key"),
      { issuer: ORIGIN, audience: ORIGIN, currentDate: new Date(NOW * 1000) },
    );
    const initialRefresh = await openArtifact<RefreshTokenPayload>(
      "refresh_token",
      initialBody.refresh_token as string,
      config.encryptionKeys,
      NOW,
    );

    const response = await refreshTokenRequest(initialBody.refresh_token as string);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toMatchObject({
      token_type: "Bearer",
      expires_in: 300,
      scope: "tabloom:workspace",
    });
    expect(JSON.stringify(body)).not.toContain(ROTATED_ACCESS_TOKEN);
    expect(JSON.stringify(body)).not.toContain(ROTATED_REFRESH_TOKEN);
    expect(refreshSession).toHaveBeenCalledExactlyOnceWith({
      refresh_token: REFRESH_TOKEN,
    });

    const rotatedAccess = await jwtVerify(
      body.access_token as string,
      signingPublicKey(config.signingKeys, "signing-key"),
      { issuer: ORIGIN, audience: ORIGIN, currentDate: new Date(NOW * 1000) },
    );
    expect(rotatedAccess.payload).toMatchObject({
      sub: USER_ID,
      client_id: CLIENT_ID,
      scope: "tabloom:workspace",
      grant_id: consentSession.grantId,
      iat: NOW,
      nbf: NOW,
      exp: NOW + 300,
    });
    expect(rotatedAccess.payload.jti).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotatedAccess.payload.jti).not.toBe(initialAccess.payload.jti);
    const inner = await jwtDecrypt(
      rotatedAccess.payload.supabase_token as string,
      config.encryptionKeys.active!.derived("inner_access_token"),
      { currentDate: new Date(NOW * 1000) },
    );
    expect(inner.payload).toMatchObject({ token: ROTATED_ACCESS_TOKEN, exp: NOW + 300 });
    expect(JSON.stringify(inner.payload)).not.toContain(ROTATED_REFRESH_TOKEN);

    const rotatedRefresh = await openArtifact<RefreshTokenPayload>(
      "refresh_token",
      body.refresh_token as string,
      config.encryptionKeys,
      NOW,
    );
    expect(rotatedRefresh).toMatchObject({
      supabaseRefreshToken: ROTATED_REFRESH_TOKEN,
      userId: USER_ID,
      clientId: CLIENT_ID,
      resource: ORIGIN,
      scope: "tabloom:workspace",
      grantId: consentSession.grantId,
      issuedAt: NOW,
      expiresAt: NOW + REFRESH_TOKEN_LIFETIME_SECONDS,
    });
    expect(rotatedRefresh.jti).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotatedRefresh.jti).not.toBe(initialRefresh.jti);
    expect(Object.keys(rotatedRefresh).sort()).toEqual([
      "clientId",
      "expiresAt",
      "grantId",
      "issuedAt",
      "jti",
      "resource",
      "scope",
      "supabaseRefreshToken",
      "userId",
    ]);
    expect(consumed).toEqual(new Set([
      consentSession.authorizationCodeJti,
      initialRefresh.jti,
    ]));
  });

  it.each([
    ["client", { client_id: OTHER_USER_ID }],
    ["resource", { resource: "https://other.example" }],
    ["scope", { scope: "other:scope" }],
  ])("rejects a %s binding mismatch before consuming", async (_label, overrides) => {
    const token = await refreshArtifact();

    await expectError(await refreshTokenRequest(token, overrides), "invalid_grant");

    expect(consumed).toEqual(new Set());
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("rejects expired, wrong-purpose, and wrong-key artifacts identically", async () => {
    const expired = await refreshArtifact(
      {
        issuedAt: NOW - REFRESH_TOKEN_LIFETIME_SECONDS - 1,
        expiresAt: NOW - 1,
      },
      NOW - REFRESH_TOKEN_LIFETIME_SECONDS - 1,
    );
    const wrongPurpose = await refreshArtifact({}, NOW, "authorization_code");

    vi.stubEnv("TABLOOM_OAUTH_ENCRYPTION_KEYS", JSON.stringify([
      { kid: "other-key", active: true, rootKey: Buffer.alloc(32, 8).toString("base64url") },
    ]));
    const wrongKey = await refreshArtifact();
    useFacadeEnvironment();

    for (const token of [expired, wrongPurpose, wrongKey]) {
      await expectError(await refreshTokenRequest(token), "invalid_grant");
    }
    expect(consumed).toEqual(new Set());
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("rejects a refresh artifact without an upstream refresh credential", async () => {
    const token = await refreshArtifact({ supabaseRefreshToken: undefined as never });

    await expectError(await refreshTokenRequest(token), "invalid_grant");

    expect(consumed).toEqual(new Set());
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("rejects a revoked family before consuming or contacting Supabase", async () => {
    revoked = true;
    const token = await refreshArtifact();

    await expectError(await refreshTokenRequest(token), "invalid_grant");

    expect(consumed).toEqual(new Set());
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("burns the refresh JTI when Supabase rejects the upstream credential", async () => {
    const token = await refreshArtifact();
    refreshSession.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "provider detail" },
    });

    const first = await refreshTokenRequest(token);
    const second = await refreshTokenRequest(token);

    await expectError(first, "invalid_grant");
    await expectError(second, "invalid_grant");
    expect(consumed).toEqual(new Set(["r".repeat(43)]));
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("burns the refresh JTI when a transient Supabase failure returns 503", async () => {
    const token = await refreshArtifact();
    refreshSession.mockRejectedValue(new Error("upstream unavailable with secret detail"));

    const first = await refreshTokenRequest(token);
    const second = await refreshTokenRequest(token);

    await expectError(first, "temporarily_unavailable", 503);
    await expectError(second, "invalid_grant");
    expect(consumed).toEqual(new Set(["r".repeat(43)]));
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("burns the refresh JTI and returns 503 for a resolved retryable fetch error", async () => {
    const token = await refreshArtifact();
    refreshSession.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthRetryableFetchError("network detail must stay private", 503),
    });

    const first = await refreshTokenRequest(token);
    const second = await refreshTokenRequest(token);

    await expectError(first, "temporarily_unavailable", 503);
    await expectError(second, "invalid_grant");
    expect(consumed).toEqual(new Set(["r".repeat(43)]));
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("burns the refresh JTI and returns 503 when the post-provider revocation check is unavailable", async () => {
    const token = await refreshArtifact();
    const base = persistence();
    let revokedChecks = 0;
    vi.mocked(createOAuthPersistence).mockReturnValue({
      ...base,
      async isGrantRevoked(grantId) {
        revokedChecks += 1;
        if (revokedChecks === 2) throw new OAuthPersistenceUnavailableError();
        return base.isGrantRevoked(grantId);
      },
    });

    await expectError(await refreshTokenRequest(token), "temporarily_unavailable", 503);

    expect(consumed).toEqual(new Set(["r".repeat(43)]));
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(revokedChecks).toBe(2);
  });

  it("burns the refresh JTI when Supabase returns a changed user", async () => {
    const token = await refreshArtifact();
    refreshSession.mockResolvedValue({
      data: {
        user: { id: OTHER_USER_ID },
        session: {
          access_token: ROTATED_ACCESS_TOKEN,
          refresh_token: ROTATED_REFRESH_TOKEN,
          expires_at: NOW + 300,
        },
      },
      error: null,
    });

    await expectError(await refreshTokenRequest(token), "invalid_grant");
    await expectError(await refreshTokenRequest(token), "invalid_grant");

    expect(consumed).toEqual(new Set(["r".repeat(43)]));
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("burns the refresh JTI when Supabase omits a rotated credential", async () => {
    const token = await refreshArtifact();
    refreshSession.mockResolvedValue({
      data: {
        user: { id: USER_ID },
        session: {
          access_token: ROTATED_ACCESS_TOKEN,
          refresh_token: "",
          expires_at: NOW + 300,
        },
      },
      error: null,
    });

    await expectError(await refreshTokenRequest(token), "invalid_grant");

    expect(consumed).toEqual(new Set(["r".repeat(43)]));
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("has exactly one upstream winner when a refresh token is reused concurrently", async () => {
    const token = await refreshArtifact();

    const responses = await Promise.all([
      refreshTokenRequest(token),
      refreshTokenRequest(token),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const loser = responses.find((response) => response.status === 400)!;
    await expect(loser.json()).resolves.toEqual({ error: "invalid_grant" });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(consumed).toEqual(new Set(["r".repeat(43)]));
  });

  it("does not mint or resurrect a descendant when an aged refresh is revoked during provider work", async () => {
    const tenDays = 10 * 24 * 60 * 60;
    const agedIssuedAt = NOW - tenDays;
    const agedExpiresAt = agedIssuedAt + REFRESH_TOKEN_LIFETIME_SECONDS;
    const token = await refreshArtifact({
      issuedAt: agedIssuedAt,
      expiresAt: agedExpiresAt,
    }, agedIssuedAt);
    let providerStarted!: () => void;
    let finishProvider!: (value: unknown) => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const providerResult = new Promise((resolve) => { finishProvider = resolve; });
    refreshSession.mockImplementation(() => {
      providerStarted();
      return providerResult;
    });

    const refreshing = refreshTokenRequest(token);
    await started;
    const revocation = await revokeTokenRequest(token);
    await expect(revocation.text()).resolves.toBe("");
    expect(revocation.status).toBe(200);
    finishProvider({
      data: {
        user: { id: USER_ID },
        session: {
          access_token: ROTATED_ACCESS_TOKEN,
          refresh_token: ROTATED_REFRESH_TOKEN,
          expires_at: NOW + 300,
        },
      },
      error: null,
    });

    await expectError(await refreshing, "invalid_grant");
    await expectError(await refreshTokenRequest(token), "invalid_grant");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(consumed).toEqual(new Set(["r".repeat(43)]));
    expect(revocationExpiries).toEqual([
      new Date((NOW + REFRESH_TOKEN_LIFETIME_SECONDS) * 1000),
    ]);
    expect(revocationExpiries[0]!.getTime()).toBeGreaterThan(agedExpiresAt * 1000);
  });

  it("caps a descendant to its absolute family expiry when revocation started before refresh", async () => {
    const oneDay = 24 * 60 * 60;
    const familyExpiresAt = NOW + REFRESH_TOKEN_LIFETIME_SECONDS;
    const token = await refreshArtifact();
    let revocationStarted!: () => void;
    let finishRevocation!: () => void;
    const started = new Promise<void>((resolve) => { revocationStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { finishRevocation = resolve; });
    let revokedUntil: number | undefined;
    const base = persistence();
    vi.mocked(createOAuthPersistence).mockReturnValue({
      ...base,
      async revokeGrant(_grantId, expiresAt) {
        revocationExpiries.push(expiresAt);
        revocationStarted();
        await blocked;
        revokedUntil = Math.floor(expiresAt.getTime() / 1000);
      },
      async isGrantRevoked() {
        return revokedUntil !== undefined && Math.floor(Date.now() / 1000) < revokedUntil;
      },
    });

    const revoking = revokeTokenRequest(token);
    await started;

    const refreshNow = NOW + oneDay;
    vi.setSystemTime(refreshNow * 1000);
    refreshSession.mockImplementation(() => Promise.resolve({
      data: {
        user: { id: USER_ID },
        session: {
          access_token: ROTATED_ACCESS_TOKEN,
          refresh_token: ROTATED_REFRESH_TOKEN,
          expires_at: Math.floor(Date.now() / 1000) + 300,
        },
      },
      error: null,
    }));

    const refreshed = await refreshTokenRequest(token);
    expect(refreshed.status).toBe(200);
    const refreshedBody = await refreshed.json() as Record<string, unknown>;
    const descendant = await openArtifact<RefreshTokenPayload>(
      "refresh_token",
      refreshedBody.refresh_token as string,
      loadFacadeAuthConfig(process.env).encryptionKeys,
      refreshNow,
    );

    finishRevocation();
    const revocation = await revoking;
    expect(revocation.status).toBe(200);
    await expect(revocation.text()).resolves.toBe("");
    expect(revocationExpiries).toEqual([new Date(familyExpiresAt * 1000)]);

    vi.setSystemTime((familyExpiresAt + 1) * 1000);
    const afterDurableHorizon = await refreshTokenRequest(refreshedBody.refresh_token as string);

    expect(descendant.expiresAt).toBe(familyExpiresAt);
    await expectError(afterDurableHorizon, "invalid_grant");
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("burns a refresh whose absolute family lifetime expires during provider work", async () => {
    const familyExpiresAt = NOW + 60;
    const token = await refreshArtifact({ expiresAt: familyExpiresAt });
    let providerStarted!: () => void;
    let finishProvider!: (value: unknown) => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const providerResult = new Promise((resolve) => { finishProvider = resolve; });
    refreshSession.mockImplementation(() => {
      providerStarted();
      return providerResult;
    });

    const refreshing = refreshTokenRequest(token);
    await started;
    vi.setSystemTime((familyExpiresAt + 1) * 1000);
    finishProvider({
      data: {
        user: { id: USER_ID },
        session: {
          access_token: ROTATED_ACCESS_TOKEN,
          refresh_token: ROTATED_REFRESH_TOKEN,
          expires_at: familyExpiresAt + 300,
        },
      },
      error: null,
    });

    await expectError(await refreshing, "invalid_grant");
    expect(consumed).toEqual(new Set(["r".repeat(43)]));
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("keeps refresh requests form-only, public-client, exact, and bounded", async () => {
    const token = await refreshArtifact();
    await expectError(
      await refreshTokenRequest(token, {}, { headers: { "Content-Type": "application/json" } }),
      "invalid_request",
    );
    await expectError(await refreshTokenRequest(token, { extra: "x" }), "invalid_request");
    await expectError(
      await refreshTokenRequest(token, { client_secret: "secret" }),
      "invalid_client",
      401,
    );
    await expectError(
      await refreshTokenRequest(token, {}, { headers: { Authorization: "Basic Zm9vOmJhcg==" } }),
      "invalid_client",
      401,
    );
  });
});
