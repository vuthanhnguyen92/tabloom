import { describe, expect, it } from "vitest";

import { sealArtifact } from "../../services/tabloom-mcp/src/auth/artifacts";
import { createEncryptionKeyRing } from "../../services/tabloom-mcp/src/auth/key-rings";
import type { ValidatedAuthorizationRequest } from "../../services/tabloom-mcp/src/oauth/authorization-request";
import {
  CONSENT_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  clearConsentCookie,
  clearUpstreamStateCookie,
  createConsentCookie,
  createUpstreamStateCookie,
  readConsentSession,
  readUpstreamLoginState,
  type ConsentSession,
  type UpstreamLoginState,
} from "../../services/tabloom-mcp/src/oauth/cookies";

const NOW = 1_788_000_000;
const keys = createEncryptionKeyRing([
  { kid: "active", active: true, rootKey: Buffer.alloc(32, 9).toString("base64url") },
]);
const request: ValidatedAuthorizationRequest = {
  client: {
    clientId: "5c177e69-8954-4c57-a777-07c732513bea",
    clientName: "Example MCP Client",
    redirectUris: ["https://client.example/callback"],
    source: "dcr",
  },
  redirectUri: "https://client.example/callback",
  state: "original-client-state",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  resource: "https://tabloom-mcp.nickvu.dev",
  scope: "tabloom:workspace",
};
const upstream: UpstreamLoginState = {
  request,
  supabaseCodeVerifier: "v".repeat(64),
};
const consent: ConsentSession = {
  request,
  userId: "4f6f8607-9439-4ce3-a19e-f5a302ef3e68",
  supabaseAccessToken: "secret-access-token",
  supabaseRefreshToken: "secret-refresh-token",
  supabaseAccessTokenExpiresAt: NOW + 3600,
  csrfNonce: "n".repeat(43),
  authorizationCodeJti: "j".repeat(43),
  grantId: "g".repeat(43),
};

function uriWithLength(length: number): string {
  const prefix = "https://extra.example/";
  return `${prefix}${"a".repeat(length - prefix.length)}`;
}

function boundaryRequest(...extraRedirectUriLengths: number[]): ValidatedAuthorizationRequest {
  const redirectUri = "https://client.example/callback";
  return {
    client: {
      clientId: "5c177e69-8954-4c57-a777-07c732513bea",
      clientName: "Client",
      redirectUris: [redirectUri, ...extraRedirectUriLengths.map(uriWithLength)],
      source: "dcr",
    },
    redirectUri,
    state: "s",
    codeChallenge: "x".repeat(43),
    resource: "https://tabloom-mcp.nickvu.dev",
    scope: "tabloom:workspace",
  };
}

function requestWithCookie(name: string, cookie: string): Request {
  const value = cookie.slice(`${name}=`.length).split(";", 1)[0]!;
  return new Request("https://tabloom-mcp.nickvu.dev/oauth/callback/supabase", {
    headers: { Cookie: `${name}=${value}` },
  });
}

function attributes(cookie: string): string[] {
  return cookie.split(";").slice(1).map((value) => value.trim());
}

function expectSecureHostCookie(cookie: string, name: string, maxAge: number) {
  expect(cookie).toMatch(new RegExp(`^${name}=${maxAge === 0 ? "" : "[^;]+"};`));
  expect(attributes(cookie)).toEqual([
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ]);
  expect(cookie).not.toMatch(/(?:^|;)\s*Domain=/i);
  expect(maxAge).toBeLessThanOrEqual(600);
}

describe("OAuth encrypted cookies", () => {
  it("seals upstream state in a ten-minute host-only cookie", async () => {
    const cookie = await createUpstreamStateCookie(upstream, keys, NOW);

    expectSecureHostCookie(cookie, OAUTH_STATE_COOKIE_NAME, 600);
    expect(cookie).not.toContain(request.state);
    expect(cookie).not.toContain(upstream.supabaseCodeVerifier);
    await expect(readUpstreamLoginState(
      requestWithCookie(OAUTH_STATE_COOKIE_NAME, cookie),
      keys,
      NOW,
    )).resolves.toEqual(upstream);
  });

  it("seals Supabase credentials in a purpose-separated HttpOnly consent cookie", async () => {
    const cookie = await createConsentCookie(consent, keys, 600, NOW);

    expectSecureHostCookie(cookie, CONSENT_COOKIE_NAME, 600);
    expect(cookie).not.toContain(consent.supabaseAccessToken);
    expect(cookie).not.toContain(consent.supabaseRefreshToken);
    await expect(readConsentSession(
      requestWithCookie(CONSENT_COOKIE_NAME, cookie),
      keys,
      NOW,
    )).resolves.toEqual(consent);

    const encrypted = cookie.slice(`${CONSENT_COOKIE_NAME}=`.length).split(";", 1)[0]!;
    await expect(readUpstreamLoginState(new Request("https://example.test", {
      headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=${encrypted}` },
    }), keys, NOW)).rejects.toThrow("Invalid OAuth cookie");

    const upstreamCookie = await createUpstreamStateCookie(upstream, keys, NOW);
    const encryptedUpstream = upstreamCookie.slice(`${OAUTH_STATE_COOKIE_NAME}=`.length).split(";", 1)[0]!;
    await expect(readConsentSession(new Request("https://example.test", {
      headers: { Cookie: `${CONSENT_COOKIE_NAME}=${encryptedUpstream}` },
    }), keys, NOW)).rejects.toThrow("Invalid OAuth cookie");
  });

  it("rejects missing, duplicated, expired, and malformed cookie state", async () => {
    await expect(readUpstreamLoginState(new Request("https://example.test"), keys, NOW))
      .rejects.toThrow("Invalid OAuth cookie");

    const cookie = await createUpstreamStateCookie(upstream, keys, NOW);
    const encrypted = cookie.slice(`${OAUTH_STATE_COOKIE_NAME}=`.length).split(";", 1)[0]!;
    await expect(readUpstreamLoginState(new Request("https://example.test", {
      headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=${encrypted}; ${OAUTH_STATE_COOKIE_NAME}=${encrypted}` },
    }), keys, NOW)).rejects.toThrow("Invalid OAuth cookie");
    await expect(readUpstreamLoginState(
      requestWithCookie(OAUTH_STATE_COOKIE_NAME, cookie),
      keys,
      NOW + 600,
    )).rejects.toThrow("Invalid OAuth cookie");
    await expect(readUpstreamLoginState(new Request("https://example.test", {
      headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=not-an-artifact` },
    }), keys, NOW)).rejects.toThrow("Invalid OAuth cookie");

    const consentCookie = await createConsentCookie(consent, keys, 600, NOW);
    await expect(readConsentSession(
      requestWithCookie(CONSENT_COOKIE_NAME, consentCookie),
      keys,
      NOW + 600,
    )).rejects.toThrow("Invalid OAuth cookie");
  });

  it("rejects decrypted state without a PKCE verifier", async () => {
    const encrypted = await sealArtifact(
      "upstream_state",
      { ...upstream, supabaseCodeVerifier: "" },
      600,
      keys,
      NOW,
    );
    await expect(readUpstreamLoginState(
      new Request("https://example.test", {
        headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=${encrypted}` },
      }),
      keys,
      NOW,
    )).rejects.toThrow("Invalid OAuth cookie");
  });

  it("clears each cookie with the same host-only security attributes", () => {
    expectSecureHostCookie(clearUpstreamStateCookie(), OAUTH_STATE_COOKIE_NAME, 0);
    expectSecureHostCookie(clearConsentCookie(), CONSENT_COOKIE_NAME, 0);
  });

  it("accepts a complete transaction Set-Cookie at 3,800 bytes and rejects the next byte", async () => {
    const atLimit = await createUpstreamStateCookie({
      request: boundaryRequest(2048, 120),
      supabaseCodeVerifier: "v".repeat(64),
    }, keys, NOW);

    expect(Buffer.byteLength(atLimit, "utf8")).toBe(3_800);
    await expect(createUpstreamStateCookie({
      request: boundaryRequest(2048, 121),
      supabaseCodeVerifier: "v".repeat(64),
    }, keys, NOW)).rejects.toThrow("OAuth cookie exceeds storage limit");
  });

  it("accepts a complete consent Set-Cookie at 3,800 bytes and rejects the next size", async () => {
    const session = (redirectUriLength: number): ConsentSession => ({
      request: boundaryRequest(redirectUriLength),
      userId: consent.userId,
      supabaseAccessToken: "a".repeat(100),
      supabaseRefreshToken: "r".repeat(40),
      supabaseAccessTokenExpiresAt: consent.supabaseAccessTokenExpiresAt,
      csrfNonce: consent.csrfNonce,
      authorizationCodeJti: consent.authorizationCodeJti,
      grantId: consent.grantId,
    });
    const atLimit = await createConsentCookie(session(1799), keys, 600, NOW);

    expect(Buffer.byteLength(atLimit, "utf8")).toBe(3_800);
    await expect(createConsentCookie(session(1800), keys, 600, NOW))
      .rejects.toThrow("OAuth cookie exceeds storage limit");
  });
});
