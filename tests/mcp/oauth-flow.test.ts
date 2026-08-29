import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import {
  decodeJwt,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK,
} from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { issueAccessToken } from "../../services/tabloom-mcp/src/auth/access-token";
import { loadFacadeAuthConfig } from "../../services/tabloom-mcp/src/auth/config";
import { createTokenVerifier } from "../../services/tabloom-mcp/src/auth/verify-token";
import { fetchCimdClient } from "../../services/tabloom-mcp/src/oauth/cimd";
import {
  CONSENT_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
} from "../../services/tabloom-mcp/src/oauth/cookies";
import {
  createOAuthPersistence,
  type OAuthPersistence,
  type StoredPublicClient,
} from "../../services/tabloom-mcp/src/oauth/persistence";
import {
  createUpstreamSupabaseAuth,
  type UpstreamSupabaseAuth,
} from "../../services/tabloom-mcp/src/oauth/upstream-supabase";

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

const NOW = 1_788_000_000;
const ORIGIN = "https://tabloom-mcp.vercel.app";
const REDIRECT_URI = "https://client.example/callback";
const DCR_CLIENT_ID = "5c177e69-8954-4c57-a777-07c732513bea";
const CIMD_CLIENT_ID = "https://client.example/oauth/metadata.json";
const USER_A = "4f6f8607-9439-4ce3-a19e-f5a302ef3e68";
const USER_B = "c04ebf62-37cc-4419-9f3a-b4e24f796da9";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = createHash("sha256").update(VERIFIER, "ascii").digest("base64url");
let privateJwk: JWK;
let store: ReturnType<typeof fakePersistence>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateJwk = await exportJWK(pair.privateKey);
});

function useFacadeEnvironment(): void {
  vi.stubEnv("SUPABASE_URL", "https://exact-project.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("TABLOOM_MCP_RESOURCE_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ISSUER_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ENABLED", "true");
  vi.stubEnv("TABLOOM_OAUTH_SIGNING_KEYS", JSON.stringify([
    { kid: "signing-key", active: true, privateJwk: { ...privateJwk, alg: "ES256" } },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_ENCRYPTION_KEYS", JSON.stringify([
    { kid: "encryption-key", active: true, rootKey: Buffer.alloc(32, 51).toString("base64url") },
  ]));
}

function fakePersistence() {
  const clients = new Map<string, StoredPublicClient>();
  const consumed = new Set<string>();
  const revoked = new Set<string>();
  const persistence: OAuthPersistence = {
    async registerClient(input) {
      const client = {
        clientId: DCR_CLIENT_ID,
        clientName: input.clientName,
        redirectUris: input.redirectUris,
        createdAt: new Date(NOW * 1_000).toISOString(),
        expiresAt: null,
      };
      clients.set(client.clientId, client);
      return client;
    },
    async getClient(clientId) {
      return clients.get(clientId) ?? null;
    },
    async consume(kind, jti) {
      const key = `${kind}:${jti}`;
      if (consumed.has(key)) return false;
      consumed.add(key);
      return true;
    },
    async revokeGrant(grantId) {
      revoked.add(grantId);
    },
    async isGrantRevoked(grantId) {
      return revoked.has(grantId);
    },
  };
  return { clients, consumed, revoked, persistence };
}

function fakeUpstream(): UpstreamSupabaseAuth {
  return {
    async begin() {
      return {
        providerUrl: "https://exact-project.supabase.co/auth/v1/authorize?provider=google",
        codeVerifier: "s".repeat(64),
      };
    },
    async exchange(code) {
      const userId = code === "provider-user-b" ? USER_B : USER_A;
      const suffix = userId === USER_A ? "a" : "b";
      return {
        userId,
        accessToken: `inner-access-${suffix}`,
        refreshToken: `inner-refresh-${suffix}`,
        accessTokenExpiresAt: NOW + 3_600,
      };
    },
  };
}

function fakeSupabase(): void {
  vi.mocked(createClient).mockImplementation(() => ({
    auth: {
      async getUser(token: string) {
        const userId = token.endsWith("-b") ? USER_B : USER_A;
        return { data: { user: { id: userId } }, error: null };
      },
      async refreshSession({ refresh_token }: { refresh_token: string }) {
        const suffix = refresh_token.endsWith("-b") ? "b" : "a";
        const userId = suffix === "b" ? USER_B : USER_A;
        return {
          data: {
            user: { id: userId },
            session: {
              access_token: `rotated-access-${suffix}`,
              refresh_token: `rotated-refresh-${suffix}`,
              expires_at: NOW + 3_600,
            },
          },
          error: null,
        };
      },
    },
  }) as never);
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get("Set-Cookie")!];
}

function authorizationUrl(clientId: string, state: string): URL {
  const url = new URL(`${ORIGIN}/oauth/authorize`);
  Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: ORIGIN,
    scope: "tabloom:workspace",
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

async function completeAuthorization(clientId: string, providerCode: string, ip: string) {
  const authorize = await import("../../services/tabloom-mcp/app/oauth/authorize/route");
  const callback = await import("../../services/tabloom-mcp/app/oauth/callback/supabase/route");
  const consent = await import("../../services/tabloom-mcp/app/oauth/consent/route");

  const authorization = await authorize.GET(new Request(authorizationUrl(clientId, `state-${providerCode}`), {
    headers: { "x-forwarded-for": ip },
  }));
  expect(authorization.status).toBe(302);
  const stateCookie = authorization.headers.get("Set-Cookie")!;
  expect(stateCookie).toContain(`${OAUTH_STATE_COOKIE_NAME}=`);

  const callbackResponse = await callback.GET(new Request(
    `${ORIGIN}/oauth/callback/supabase?code=${providerCode}`,
    { headers: { Cookie: cookiePair(stateCookie) } },
  ));
  expect(callbackResponse.status).toBe(302);
  const consentCookie = setCookies(callbackResponse)
    .find((value) => value.startsWith(`${CONSENT_COOKIE_NAME}=`))!;
  expect(consentCookie).toBeTruthy();

  const consentPage = await consent.GET(new Request(`${ORIGIN}/oauth/consent`, {
    headers: { Cookie: cookiePair(consentCookie) },
  }));
  expect(consentPage.status).toBe(200);
  expect(consentPage.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
  const html = await consentPage.text();
  const nonce = html.match(/name="csrf_nonce" value="([A-Za-z0-9_-]{43})"/)?.[1];
  expect(nonce).toBeTruthy();

  const approval = await consent.POST(new Request(`${ORIGIN}/oauth/consent`, {
    method: "POST",
    headers: {
      Cookie: cookiePair(consentCookie),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ action: "approve", csrf_nonce: nonce! }),
  }));
  expect(approval.status).toBe(302);
  const redirect = new URL(approval.headers.get("Location")!);
  expect(redirect.searchParams.get("state")).toBe(`state-${providerCode}`);
  return redirect.searchParams.get("code")!;
}

async function exchangeCode(clientId: string, code: string) {
  const route = await import("../../services/tabloom-mcp/app/oauth/token/route");
  return route.POST(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: ORIGIN,
      code_verifier: VERIFIER,
    }),
  }));
}

async function refresh(clientId: string, refreshToken: string) {
  const route = await import("../../services/tabloom-mcp/app/oauth/token/route");
  return route.POST(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: ORIGIN,
      scope: "tabloom:workspace",
    }),
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1_000);
  useFacadeEnvironment();
  store = fakePersistence();
  vi.mocked(createOAuthPersistence).mockReturnValue(store.persistence);
  vi.mocked(createUpstreamSupabaseAuth).mockReturnValue(fakeUpstream());
  vi.mocked(fetchCimdClient).mockImplementation(async (clientId) => ({
    clientId,
    clientName: "CIMD Client",
    redirectUris: [REDIRECT_URI],
    source: "cimd",
  }));
  fakeSupabase();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => vi.restoreAllMocks());

describe("in-process authorization facade", () => {
  it("completes DCR through authenticated MCP, rotation, replay rejection, and immediate revocation", async () => {
    const registration = await import("../../services/tabloom-mcp/app/oauth/register/route");
    const registered = await registration.POST(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.101",
      },
      body: JSON.stringify({
        client_name: "Integration Client",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }));
    expect(registered.status).toBe(201);
    const clientId = (await registered.json() as { client_id: string }).client_id;

    const code = await completeAuthorization(clientId, "provider-user-a", "203.0.113.102");
    const exchanged = await exchangeCode(clientId, code);
    expect(exchanged.status).toBe(200);
    const first = await exchanged.json() as { access_token: string; refresh_token: string };

    const verifier = createTokenVerifier(loadFacadeAuthConfig(process.env), {
      persistence: store.persistence,
    });
    await expect(verifier(new Request(`${ORIGIN}/api/mcp`), first.access_token))
      .resolves.toMatchObject({ extra: { userId: USER_A, clientId } });
    const mcp = await import("../../services/tabloom-mcp/app/api/mcp/route");
    const mcpResponse = await mcp.POST(new Request(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${first.access_token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_service_status", arguments: {} },
      }),
    }));
    expect(mcpResponse.status).toBe(200);
    expect(await mcpResponse.text()).toContain(
      JSON.stringify({ service: "tabloom-mcp", status: "ok" }),
    );

    const codeReplay = await exchangeCode(clientId, code);
    expect(codeReplay.status).toBe(400);
    await expect(codeReplay.json()).resolves.toEqual({ error: "invalid_grant" });

    const rotatedResponse = await refresh(clientId, first.refresh_token);
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    const refreshReplay = await refresh(clientId, first.refresh_token);
    expect(refreshReplay.status).toBe(400);
    await expect(refreshReplay.json()).resolves.toEqual({ error: "invalid_grant" });

    const revoke = await import("../../services/tabloom-mcp/app/oauth/revoke/route");
    const revoked = await revoke.POST(new Request(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "203.0.113.103",
      },
      body: new URLSearchParams({ token: rotated.access_token }),
    }));
    expect(revoked.status).toBe(200);
    await expect(verifier(new Request(`${ORIGIN}/api/mcp`), rotated.access_token))
      .resolves.toBeUndefined();
    const revokedMcpResponse = await mcp.POST(new Request(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rotated.access_token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_service_status", arguments: {} },
      }),
    }));
    expect(revokedMcpResponse.status).toBe(401);
  });

  it("completes the same authorization path for a hardened CIMD client", async () => {
    const code = await completeAuthorization(CIMD_CLIENT_ID, "provider-user-a", "203.0.113.111");
    const response = await exchangeCode(CIMD_CLIENT_ID, code);

    expect(response.status).toBe(200);
    expect(fetchCimdClient).toHaveBeenCalledWith(CIMD_CLIENT_ID);
    expect(store.clients.size).toBe(0);
    const token = (await response.json() as { access_token: string }).access_token;
    const verifier = createTokenVerifier(loadFacadeAuthConfig(process.env), {
      persistence: store.persistence,
    });
    await expect(verifier(new Request(`${ORIGIN}/api/mcp`), token))
      .resolves.toMatchObject({ clientId: CIMD_CLIENT_ID, extra: { userId: USER_A } });
  });

  it("rejects User B's encrypted inner credential substituted into User A's outer claims", async () => {
    const config = loadFacadeAuthConfig(process.env);
    const userBToken = await issueAccessToken({
      sub: USER_B,
      clientId: DCR_CLIENT_ID,
      grantId: "g".repeat(43),
      supabaseToken: "inner-access-b",
      innerExpiresAt: NOW + 600,
    }, config, NOW);
    const userBClaims = decodeJwt(userBToken) as Record<string, unknown>;
    const substituted = await new SignJWT({
      ...userBClaims,
      sub: USER_A,
    })
      .setProtectedHeader({ alg: "ES256", kid: "signing-key", typ: "at+jwt" })
      .sign(await importJWK({ ...privateJwk, alg: "ES256" }, "ES256"));
    const verifier = createTokenVerifier(config, { persistence: store.persistence });

    await expect(verifier(new Request(`${ORIGIN}/api/mcp`), substituted))
      .resolves.toBeUndefined();
  });
});
