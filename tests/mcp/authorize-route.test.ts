import { exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loadFacadeAuthConfig } from "../../services/tabloom-mcp/src/auth/config";
import type { ValidatedAuthorizationRequest } from "../../services/tabloom-mcp/src/oauth/authorization-request";
import {
  CONSENT_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  createUpstreamStateCookie,
  readConsentSession,
  readUpstreamLoginState,
} from "../../services/tabloom-mcp/src/oauth/cookies";
import { fetchCimdClient } from "../../services/tabloom-mcp/src/oauth/cimd";
import { createOAuthPersistence, type OAuthPersistence } from "../../services/tabloom-mcp/src/oauth/persistence";
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
vi.mock("../../services/tabloom-mcp/src/oauth/cimd", async () => {
  const actual = await vi.importActual<typeof import("../../services/tabloom-mcp/src/oauth/cimd")>(
    "../../services/tabloom-mcp/src/oauth/cimd",
  );
  return { ...actual, fetchCimdClient: vi.fn() };
});
vi.mock("../../services/tabloom-mcp/src/oauth/upstream-supabase", async () => {
  const actual = await vi.importActual<typeof import("../../services/tabloom-mcp/src/oauth/upstream-supabase")>(
    "../../services/tabloom-mcp/src/oauth/upstream-supabase",
  );
  return { ...actual, createUpstreamSupabaseAuth: vi.fn() };
});

const ORIGIN = "https://tabloom-mcp.vercel.app";
const DCR_CLIENT_ID = "5c177e69-8954-4c57-a777-07c732513bea";
const CIMD_CLIENT_ID = "https://client.example/oauth/metadata.json";
const REDIRECT_URI = "https://client.example/callback";
const USER_ID = "4f6f8607-9439-4ce3-a19e-f5a302ef3e68";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "v".repeat(64);
let privateJwk: JWK;

beforeAll(async () => {
  const keyPair = await generateKeyPair("ES256", { extractable: true });
  privateJwk = await exportJWK(keyPair.privateKey);
});

function useFacadeEnvironment(enabled: boolean) {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("TABLOOM_MCP_RESOURCE_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ISSUER_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ENABLED", String(enabled));
  vi.stubEnv("TABLOOM_OAUTH_SIGNING_KEYS", JSON.stringify([
    { kid: "signing-key", active: true, privateJwk: { ...privateJwk, alg: "ES256" } },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_ENCRYPTION_KEYS", JSON.stringify([
    { kid: "encryption-key", active: true, rootKey: Buffer.alloc(32, 3).toString("base64url") },
  ]));
}

function persistence(): OAuthPersistence {
  return {
    async registerClient() { throw new Error("unused"); },
    async getClient(clientId) {
      if (clientId !== DCR_CLIENT_ID) return null;
      return {
        clientId,
        clientName: "DCR Client",
        redirectUris: [REDIRECT_URI],
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
    begin: vi.fn(async () => ({
      providerUrl: "https://example.supabase.co/auth/v1/authorize?provider=google",
      codeVerifier: VERIFIER,
    })),
    exchange: vi.fn(async () => ({
      userId: USER_ID,
      accessToken: "supabase-access-token",
      refreshToken: "supabase-refresh-token",
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    })),
  };
}

function authorizationUrl(clientId = DCR_CLIENT_ID, overrides: Record<string, string> = {}): string {
  const url = new URL("https://untrusted-forwarded-host.example/oauth/authorize");
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: "original-client-state",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: ORIGIN,
    scope: "tabloom:workspace",
    ...overrides,
  })) url.searchParams.set(key, value);
  return url.href;
}

function expectNoStore(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Pragma")).toBe("no-cache");
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get("Set-Cookie")!];
}

function cookieRequest(name: string, cookie: string, url = `${ORIGIN}/oauth/callback/supabase`): Request {
  const value = cookie.slice(`${name}=`.length).split(";", 1)[0]!;
  return new Request(url, { headers: { Cookie: `${name}=${value}` } });
}

async function authorizeRoute() {
  return import("../../services/tabloom-mcp/app/oauth/authorize/route");
}

async function callbackRoute() {
  return import("../../services/tabloom-mcp/app/oauth/callback/supabase/route");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});
afterAll(() => vi.restoreAllMocks());

describe("GET /oauth/authorize", () => {
  it("returns a safe disabled response before resolving clients or starting Supabase", async () => {
    useFacadeEnvironment(false);
    const auth = upstream();
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(auth);
    const route = await authorizeRoute();

    const response = await route.GET(new Request(authorizationUrl()));

    expect(response.status).toBe(503);
    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(createOAuthPersistence).not.toHaveBeenCalled();
    expect(auth.begin).not.toHaveBeenCalled();
  });

  it("validates the complete client request before redirecting upstream", async () => {
    useFacadeEnvironment(true);
    vi.mocked(createOAuthPersistence).mockReturnValue(persistence());
    const auth = upstream();
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(auth);
    const route = await authorizeRoute();

    const response = await route.GET(new Request(authorizationUrl(DCR_CLIENT_ID, { response_type: "token" })));

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
    expect(auth.begin).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("resolves a DCR client and keeps original client state encrypted during Google login", async () => {
    useFacadeEnvironment(true);
    vi.mocked(createOAuthPersistence).mockReturnValue(persistence());
    const auth = upstream();
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(auth);
    const route = await authorizeRoute();

    const response = await route.GET(new Request(authorizationUrl()));

    expect(response.status).toBe(302);
    expectNoStore(response);
    expect(response.headers.get("Location")).toBe("https://example.supabase.co/auth/v1/authorize?provider=google");
    expect(auth.begin).toHaveBeenCalledWith(`${ORIGIN}/oauth/callback/supabase`);
    const cookie = response.headers.get("Set-Cookie")!;
    expect(cookie).toContain(`${OAUTH_STATE_COOKIE_NAME}=`);
    expect(cookie).not.toContain("original-client-state");
    expect(cookie).not.toContain(VERIFIER);
    const state = await readUpstreamLoginState(
      cookieRequest(OAUTH_STATE_COOKIE_NAME, cookie),
      loadFacadeAuthConfig(process.env).encryptionKeys,
    );
    expect(state.request.client).toMatchObject({ clientId: DCR_CLIENT_ID, source: "dcr" });
    expect(state.request.state).toBe("original-client-state");
    expect(state.supabaseCodeVerifier).toBe(VERIFIER);
  });

  it("supports a hardened CIMD client without consulting DCR storage", async () => {
    useFacadeEnvironment(true);
    const store = persistence();
    const getClient = vi.spyOn(store, "getClient");
    vi.mocked(createOAuthPersistence).mockReturnValue(store);
    vi.mocked(fetchCimdClient).mockResolvedValue({
      clientId: CIMD_CLIENT_ID,
      clientName: "CIMD Client",
      redirectUris: [REDIRECT_URI],
      source: "cimd",
    });
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(upstream());
    const route = await authorizeRoute();

    const response = await route.GET(new Request(authorizationUrl(CIMD_CLIENT_ID)));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("example.supabase.co");
    expect(fetchCimdClient).toHaveBeenCalledWith(CIMD_CLIENT_ID);
    expect(getClient).not.toHaveBeenCalled();
  });

  it("maps upstream failures to a safe client redirect", async () => {
    useFacadeEnvironment(true);
    vi.mocked(createOAuthPersistence).mockReturnValue(persistence());
    const auth = upstream();
    vi.mocked(auth.begin).mockRejectedValue(new Error("provider detail and token"));
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(auth);
    const route = await authorizeRoute();

    const response = await route.GET(new Request(authorizationUrl()));

    expect(response.status).toBe(302);
    const location = response.headers.get("Location")!;
    expect(new URL(location).searchParams.get("error")).toBe("temporarily_unavailable");
    expect(new URL(location).searchParams.get("state")).toBe("original-client-state");
    expect(location).not.toContain("provider+detail");
  });

  it("returns a fixed error instead of redirecting upstream when transaction state exceeds the cookie limit", async () => {
    useFacadeEnvironment(true);
    const store = persistence();
    vi.spyOn(store, "getClient").mockResolvedValue({
      clientId: DCR_CLIENT_ID,
      clientName: "DCR Client",
      redirectUris: [
        REDIRECT_URI,
        `https://one.example/${"a".repeat(1_380)}`,
        `https://two.example/${"b".repeat(1_380)}`,
      ],
      createdAt: "2026-08-29T01:02:03.000Z",
      expiresAt: null,
    });
    vi.mocked(createOAuthPersistence).mockReturnValue(store);
    const auth = upstream();
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(auth);
    const route = await authorizeRoute();

    const response = await route.GET(new Request(authorizationUrl()));

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "invalid_request" });
    expect(body).not.toContain("original-client-state");
    expect(body).not.toContain("one.example");
  });
});

describe("GET /oauth/callback/supabase", () => {
  async function stateCookie(now?: number): Promise<string> {
    const client = {
      clientId: DCR_CLIENT_ID,
      clientName: "DCR Client",
      redirectUris: [REDIRECT_URI],
      source: "dcr" as const,
    };
    const request: ValidatedAuthorizationRequest = {
      client,
      redirectUri: REDIRECT_URI,
      state: "original-client-state",
      codeChallenge: CHALLENGE,
      resource: ORIGIN,
      scope: "tabloom:workspace",
    };
    return createUpstreamStateCookie(
      { request, supabaseCodeVerifier: VERIFIER },
      loadFacadeAuthConfig(process.env).encryptionKeys,
      now,
    );
  }

  it("returns a safe disabled response and clears existing callback state", async () => {
    useFacadeEnvironment(true);
    const cookie = await stateCookie();
    useFacadeEnvironment(false);
    const auth = upstream();
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(auth);
    const route = await callbackRoute();

    const response = await route.GET(cookieRequest(
      OAUTH_STATE_COOKIE_NAME,
      cookie,
      `${ORIGIN}/oauth/callback/supabase?code=supabase-code`,
    ));

    expect(response.status).toBe(503);
    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(response.headers.get("Set-Cookie")).toContain(`${OAUTH_STATE_COOKIE_NAME}=;`);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(auth.exchange).not.toHaveBeenCalled();
  });

  it("clears existing callback state when facade configuration is invalid", async () => {
    useFacadeEnvironment(true);
    const cookie = await stateCookie();
    vi.stubEnv("SUPABASE_URL", "not-a-url");
    const route = await callbackRoute();

    const response = await route.GET(cookieRequest(
      OAUTH_STATE_COOKIE_NAME,
      cookie,
      `${ORIGIN}/oauth/callback/supabase?code=supabase-code`,
    ));

    expect(response.status).toBe(500);
    expectNoStore(response);
    expect(response.headers.get("Set-Cookie")).toContain(`${OAUTH_STATE_COOKIE_NAME}=;`);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: "server_error" });
    expect(body).not.toContain("not-a-url");
  });

  it.each([
    ["malformed", "not-an-artifact"],
    ["expired", null],
  ])("clears %s callback state that cannot be opened", async (_label, cookieValue) => {
    useFacadeEnvironment(true);
    const cookie = cookieValue === null
      ? await stateCookie(Math.floor(Date.now() / 1000) - 601)
      : `${OAUTH_STATE_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
    const route = await callbackRoute();

    const response = await route.GET(cookieRequest(
      OAUTH_STATE_COOKIE_NAME,
      cookie,
      `${ORIGIN}/oauth/callback/supabase?code=supabase-code`,
    ));

    expect(response.status).toBe(400);
    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(response.headers.get("Set-Cookie")).toContain(`${OAUTH_STATE_COOKIE_NAME}=;`);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("rejects a callback without the encrypted transaction cookie", async () => {
    useFacadeEnvironment(true);
    const auth = upstream();
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(auth);
    const route = await callbackRoute();

    const response = await route.GET(new Request(`${ORIGIN}/oauth/callback/supabase?code=supabase-code`));

    expect(response.status).toBe(400);
    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(response.headers.get("Set-Cookie")).toContain(`${OAUTH_STATE_COOKIE_NAME}=;`);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(auth.exchange).not.toHaveBeenCalled();
  });

  it("returns provider denial safely and clears the transaction cookie", async () => {
    useFacadeEnvironment(true);
    const cookie = await stateCookie();
    const auth = upstream();
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(auth);
    const route = await callbackRoute();
    const request = cookieRequest(
      OAUTH_STATE_COOKIE_NAME,
      cookie,
      `${ORIGIN}/oauth/callback/supabase?error=access_denied&error_description=private+provider+detail`,
    );

    const response = await route.GET(request);

    expect(response.status).toBe(302);
    expectNoStore(response);
    const location = response.headers.get("Location")!;
    expect(new URL(location).origin + new URL(location).pathname).toBe(REDIRECT_URI);
    expect(new URL(location).searchParams.get("error")).toBe("access_denied");
    expect(new URL(location).searchParams.get("state")).toBe("original-client-state");
    expect(location).not.toContain("private+provider+detail");
    expect(response.headers.get("Set-Cookie")).toContain(`${OAUTH_STATE_COOKIE_NAME}=;`);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(auth.exchange).not.toHaveBeenCalled();
  });

  it("exchanges the code without requiring Supabase to echo MCP state and creates consent state", async () => {
    useFacadeEnvironment(true);
    const cookie = await stateCookie();
    const auth = upstream();
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(auth);
    const route = await callbackRoute();
    const request = cookieRequest(
      OAUTH_STATE_COOKIE_NAME,
      cookie,
      `${ORIGIN}/oauth/callback/supabase?code=supabase-code`,
    );

    const response = await route.GET(request);

    expect(response.status).toBe(302);
    expectNoStore(response);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/oauth/consent`);
    expect(auth.exchange).toHaveBeenCalledWith("supabase-code", VERIFIER);
    const cookies = setCookies(response);
    const cleared = cookies.find((value) => value.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`))!;
    const sealedConsent = cookies.find((value) => value.startsWith(`${CONSENT_COOKIE_NAME}=`))!;
    expect(cleared).toContain("Max-Age=0");
    expect(sealedConsent).not.toContain("supabase-access-token");
    expect(sealedConsent).not.toContain("supabase-refresh-token");
    const consent = await readConsentSession(
      cookieRequest(CONSENT_COOKIE_NAME, sealedConsent, `${ORIGIN}/oauth/consent`),
      loadFacadeAuthConfig(process.env).encryptionKeys,
    );
    expect(consent).toMatchObject({
      request: { state: "original-client-state" },
      userId: USER_ID,
      supabaseAccessToken: "supabase-access-token",
      supabaseRefreshToken: "supabase-refresh-token",
    });
    expect(consent.csrfNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get("Location")).not.toMatch(/token|state|code/i);
  });

  it("fails closed on missing codes and safe-maps exchange failures", async () => {
    useFacadeEnvironment(true);
    const cookie = await stateCookie();
    const auth = upstream();
    vi.mocked(auth.exchange).mockRejectedValue(new Error("provider exchange detail"));
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(auth);
    const route = await callbackRoute();

    const missing = await route.GET(cookieRequest(OAUTH_STATE_COOKIE_NAME, cookie));
    expect(new URL(missing.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
    expect(missing.headers.get("Set-Cookie")).toContain("Max-Age=0");

    const failed = await route.GET(cookieRequest(
      OAUTH_STATE_COOKIE_NAME,
      cookie,
      `${ORIGIN}/oauth/callback/supabase?code=supabase-code&state=untrusted-upstream-state`,
    ));
    const failedLocation = failed.headers.get("Location")!;
    expect(new URL(failedLocation).searchParams.get("error")).toBe("temporarily_unavailable");
    expect(new URL(failedLocation).searchParams.get("state")).toBe("original-client-state");
    expect(failedLocation).not.toContain("provider+exchange+detail");
    expect(failed.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("returns a fixed error and clears transaction state when consent state exceeds the cookie limit", async () => {
    useFacadeEnvironment(true);
    const cookie = await stateCookie();
    const auth = upstream();
    vi.mocked(auth.exchange).mockResolvedValue({
      userId: USER_ID,
      accessToken: "a".repeat(3_000),
      refreshToken: "supabase-refresh-token",
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(auth);
    const route = await callbackRoute();

    const response = await route.GET(cookieRequest(
      OAUTH_STATE_COOKIE_NAME,
      cookie,
      `${ORIGIN}/oauth/callback/supabase?code=supabase-code`,
    ));

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toContain(`${OAUTH_STATE_COOKIE_NAME}=;`);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "invalid_request" });
    expect(body).not.toContain("original-client-state");
    expect(body).not.toContain("aaa");
  });
});
