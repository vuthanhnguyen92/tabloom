import { exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadFacadeAuthConfig } from "../../services/tabloom-mcp/src/auth/config";
import { sealArtifact } from "../../services/tabloom-mcp/src/auth/artifacts";
import type { ValidatedAuthorizationRequest } from "../../services/tabloom-mcp/src/oauth/authorization-request";
import {
  CONSENT_COOKIE_NAME,
  createConsentCookie,
  type ConsentSession,
} from "../../services/tabloom-mcp/src/oauth/cookies";
import { openAuthorizationCode } from "../../services/tabloom-mcp/src/oauth/consent";

const NOW = 1_788_000_000;
const ORIGIN = "https://tabloom-mcp.vercel.app";
const REDIRECT_URI = "https://client.example/callback?existing=kept&display=%22quoted%22";
const USER_ID = "4f6f8607-9439-4ce3-a19e-f5a302ef3e68";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
let privateJwk: JWK;

const authorizationRequest: ValidatedAuthorizationRequest = {
  client: {
    clientId: "5c177e69-8954-4c57-a777-07c732513bea",
    clientName: '<script>alert("x")</script> & Client',
    redirectUris: [REDIRECT_URI],
    source: "dcr",
  },
  redirectUri: REDIRECT_URI,
  state: "original-client-state",
  codeChallenge: CHALLENGE,
  resource: ORIGIN,
  scope: "tabloom:workspace",
};

const session: ConsentSession = {
  request: authorizationRequest,
  userId: USER_ID,
  supabaseAccessToken: "secret-supabase-access-token",
  supabaseRefreshToken: "secret-supabase-refresh-token",
  supabaseAccessTokenExpiresAt: NOW + 3600,
  csrfNonce: "n".repeat(43),
  authorizationCodeJti: "j".repeat(43),
  grantId: "g".repeat(43),
};

beforeAll(async () => {
  const keyPair = await generateKeyPair("ES256", { extractable: true });
  privateJwk = await exportJWK(keyPair.privateKey);
});

function useFacadeEnvironment(enabled = true, origin = ORIGIN) {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("TABLOOM_MCP_RESOURCE_URL", origin);
  vi.stubEnv("TABLOOM_OAUTH_ISSUER_URL", origin);
  vi.stubEnv("TABLOOM_OAUTH_ENABLED", String(enabled));
  vi.stubEnv("TABLOOM_OAUTH_SIGNING_KEYS", JSON.stringify([
    { kid: "signing-key", active: true, privateJwk: { ...privateJwk, alg: "ES256" } },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_ENCRYPTION_KEYS", JSON.stringify([
    { kid: "encryption-key", active: true, rootKey: Buffer.alloc(32, 3).toString("base64url") },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_DATABASE_SECRET", Buffer.alloc(32, 9).toString("base64url"));
}

function cookieHeader(cookie: string): string {
  return cookie.slice(0, cookie.indexOf(";"));
}

async function consentCookie(value: ConsentSession = session, issuedAt = NOW): Promise<string> {
  return createConsentCookie(
    value,
    loadFacadeAuthConfig(process.env).encryptionKeys,
    600,
    issuedAt,
  );
}

function consentRequest(cookie: string | undefined, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookieHeader(cookie));
  return new Request(`${ORIGIN}/oauth/consent`, { ...init, headers });
}

function postBody(action: string, nonce = session.csrfNonce): string {
  return new URLSearchParams({ action, csrf_nonce: nonce }).toString();
}

async function post(cookie: string, body: string, contentType = "application/x-www-form-urlencoded") {
  const route = await import("../../services/tabloom-mcp/app/oauth/consent/route");
  return route.POST(consentRequest(cookie, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  }));
}

function expectNoStore(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Pragma")).toBe("no-cache");
}

function expectConsentCleared(response: Response) {
  expect(response.headers.get("Set-Cookie")).toContain(`${CONSENT_COOKIE_NAME}=;`);
  expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  useFacadeEnvironment();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("../../services/tabloom-mcp/src/oauth/consent");
});
afterAll(() => vi.restoreAllMocks());

describe("GET /oauth/consent", () => {
  it("renders escaped consent details without exposing the encrypted session", async () => {
    const cookie = await consentCookie();
    const route = await import("../../services/tabloom-mcp/app/oauth/consent/route");

    const response = await route.GET(consentRequest(cookie));
    const html = await response.text();

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toBe(CSP);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(html).toContain("Read and organize your synchronized Tabloom workspace");
    expect(html).toContain("Current browser tabs and device-only bookmarks are not included");
    expect(html).toContain("tabloom:workspace");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Client");
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("existing=kept&amp;display=%22quoted%22");
    expect(html).toContain('<form method="post" action="/oauth/consent">');
    expect(html).toContain(`name="csrf_nonce" value="${session.csrfNonce}"`);
    expect(html).toContain('name="action" value="approve"');
    expect(html).toContain('name="action" value="deny"');
    for (const secret of [
      session.supabaseAccessToken,
      session.supabaseRefreshToken,
      session.userId,
      session.request.state,
      session.authorizationCodeJti,
      session.grantId,
    ]) expect(html).not.toContain(secret);
  });

  it.each([
    ["missing", undefined],
    ["expired", "expired"],
    ["malformed", "malformed"],
  ])("returns a fixed no-store error and clears a %s consent session", async (_label, kind) => {
    const cookie = kind === "expired"
      ? await consentCookie(session, NOW - 601)
      : kind === "malformed"
        ? `${CONSENT_COOKIE_NAME}=not-an-artifact; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
        : undefined;
    const route = await import("../../services/tabloom-mcp/app/oauth/consent/route");

    const response = await route.GET(consentRequest(cookie));

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(response.headers.get("Location")).toBeNull();
    expectConsentCleared(response);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("fails closed without redirecting when the cookie resource no longer matches configuration", async () => {
    const cookie = await consentCookie();
    useFacadeEnvironment(true, "https://other.example");
    const route = await import("../../services/tabloom-mcp/app/oauth/consent/route");

    const response = await route.GET(consentRequest(cookie));

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expectConsentCleared(response);
  });
});

describe("POST /oauth/consent", () => {
  it.each([
    ["non-form content type", postBody("approve"), "application/json"],
    ["form content type parameters", postBody("approve"), "application/x-www-form-urlencoded; charset=utf-8"],
    ["missing action", `csrf_nonce=${session.csrfNonce}`, "application/x-www-form-urlencoded"],
    ["duplicate action", `action=approve&action=deny&csrf_nonce=${session.csrfNonce}`, "application/x-www-form-urlencoded"],
    ["extra field", `${postBody("approve")}&state=attacker-state`, "application/x-www-form-urlencoded"],
    ["malformed percent encoding", `action=approve&csrf_nonce=%ZZ`, "application/x-www-form-urlencoded"],
    ["unknown action", postBody("APPROVE"), "application/x-www-form-urlencoded"],
    ["CSRF mismatch", postBody("approve", "x".repeat(43)), "application/x-www-form-urlencoded"],
  ])("rejects %s through only the validated client redirect", async (_label, body, contentType) => {
    const cookie = await consentCookie();

    const response = await post(cookie, body, contentType);

    expect(response.status).toBe(302);
    expectNoStore(response);
    expectConsentCleared(response);
    const location = new URL(response.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe("https://client.example/callback");
    expect(location.searchParams.get("existing")).toBe("kept");
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe(session.request.state);
    expect(location.href).not.toContain("attacker-state");
    expect(location.href).not.toContain(session.supabaseAccessToken);
  });

  it("returns access_denied with original state and clears consent", async () => {
    const cookie = await consentCookie();
    const audit = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await post(cookie, postBody("deny"));

    expect(response.status).toBe(302);
    expectNoStore(response);
    expectConsentCleared(response);
    const location = new URL(response.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe("https://client.example/callback");
    expect(location.searchParams.get("existing")).toBe("kept");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe(session.request.state);
    expect(location.searchParams.has("code")).toBe(false);
    expect(audit.mock.calls.at(-1)?.[0]).toMatchObject({
      routeCategory: "consent",
      resultClass: "client_error",
    });
  });

  it("uses one opaque correlation ID for an unexpected consent redirect and audit", async () => {
    const cookie = await consentCookie();
    const audit = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.doMock("../../services/tabloom-mcp/src/oauth/consent", async () => {
      const actual = await vi.importActual<typeof import("../../services/tabloom-mcp/src/oauth/consent")>(
        "../../services/tabloom-mcp/src/oauth/consent",
      );
      return {
        ...actual,
        sealAuthorizationCode: vi.fn().mockRejectedValue(
          new Error("private consent failure detail"),
        ),
      };
    });

    const response = await post(cookie, postBody("approve"));
    const location = new URL(response.headers.get("Location")!);
    const correlationId = location.searchParams.get("correlation_id");

    expect(location.searchParams.get("error")).toBe("server_error");
    expect(correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(audit.mock.calls.at(-1)?.[0]).toMatchObject({
      routeCategory: "consent",
      resultClass: "server_error",
      correlationId,
    });
    expect(`${location.href}${JSON.stringify(audit.mock.calls)}`)
      .not.toContain("private consent failure detail");
  });

  it("seals a two-minute authorization code with every validated binding", async () => {
    const cookie = await consentCookie();

    const response = await post(cookie, postBody("approve"));

    expect(response.status).toBe(302);
    expectNoStore(response);
    expectConsentCleared(response);
    const location = new URL(response.headers.get("Location")!);
    const code = location.searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect(location.searchParams.get("state")).toBe(session.request.state);
    expect(location.searchParams.get("existing")).toBe("kept");
    expect(location.href).not.toContain(session.supabaseAccessToken);
    expect(location.href).not.toContain(session.supabaseRefreshToken);

    const keys = loadFacadeAuthConfig(process.env).encryptionKeys;
    await expect(openAuthorizationCode(code, keys, NOW)).resolves.toEqual({
      clientId: session.request.client.clientId,
      redirectUri: session.request.redirectUri,
      resource: session.request.resource,
      scope: session.request.scope,
      codeChallenge: session.request.codeChallenge,
      userId: session.userId,
      supabaseAccessToken: session.supabaseAccessToken,
      supabaseRefreshToken: session.supabaseRefreshToken,
      supabaseAccessTokenExpiresAt: session.supabaseAccessTokenExpiresAt,
      jti: session.authorizationCodeJti,
      grantId: session.grantId,
      issuedAt: NOW,
      expiresAt: NOW + 120,
    });
    await expect(openAuthorizationCode(code, keys, NOW + 120)).rejects.toThrow("Invalid authorization code");
  });

  it("reuses the pre-generated code JTI and grant family across duplicate approvals", async () => {
    const cookie = await consentCookie();

    const [first, second] = await Promise.all([
      post(cookie, postBody("approve")),
      post(cookie, postBody("approve")),
    ]);
    const firstCode = new URL(first.headers.get("Location")!).searchParams.get("code")!;
    const secondCode = new URL(second.headers.get("Location")!).searchParams.get("code")!;
    const keys = loadFacadeAuthConfig(process.env).encryptionKeys;
    const [firstPayload, secondPayload] = await Promise.all([
      openAuthorizationCode(firstCode, keys, NOW),
      openAuthorizationCode(secondCode, keys, NOW),
    ]);

    expect(firstCode).not.toBe(secondCode);
    expect(secondPayload).toEqual(firstPayload);
    expect(firstPayload.jti).toBe(session.authorizationCodeJti);
    expect(firstPayload.grantId).toBe(session.grantId);
  });

  it("rejects authorization-code payload timestamps that disagree with the artifact lifetime", async () => {
    const cookie = await consentCookie();
    const response = await post(cookie, postBody("approve"));
    const code = new URL(response.headers.get("Location")!).searchParams.get("code")!;
    const keys = loadFacadeAuthConfig(process.env).encryptionKeys;
    const payload = await openAuthorizationCode(code, keys, NOW);
    const inconsistent = await sealArtifact("authorization_code", {
      ...payload,
      issuedAt: NOW + 10,
      expiresAt: NOW + 130,
    }, 120, keys, NOW);

    await expect(openAuthorizationCode(inconsistent, keys, NOW))
      .rejects.toThrow("Invalid authorization code");
  });

  it("clears an unreadable session without redirecting or disclosing the request body", async () => {
    const response = await post(
      `${CONSENT_COOKIE_NAME}=not-an-artifact; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      postBody("approve"),
    );

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(response.headers.get("Location")).toBeNull();
    expectConsentCleared(response);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "invalid_request" });
    expect(body).not.toContain(session.csrfNonce);
  });
});
