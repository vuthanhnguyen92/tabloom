import { describe, expect, it } from "vitest";

import {
  AuthorizationRequestError,
  validateAuthorizationRequest,
  verifyS256,
} from "../../services/tabloom-mcp/src/oauth/authorization-request";
import {
  InvalidOAuthClientError,
  type ValidatedClient,
} from "../../services/tabloom-mcp/src/oauth/client-metadata";
import {
  CimdFetchError,
  CimdUnavailableError,
} from "../../services/tabloom-mcp/src/oauth/cimd-errors";
import { OAuthPersistenceUnavailableError } from "../../services/tabloom-mcp/src/oauth/persistence";

const RESOURCE = "https://tabloom.nickvu.dev/mcp";
const CLIENT_ID = "5c177e69-8954-4c57-a777-07c732513bea";
const REDIRECT_URI = "https://client.example/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CLIENT: ValidatedClient = {
  clientId: CLIENT_ID,
  clientName: "Example MCP Client",
  redirectUris: [REDIRECT_URI],
  source: "dcr",
};

function validParams(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: "opaque-client-state",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "tabloom:workspace",
    ...overrides,
  });
}

const resolveClient = async (clientId: string) => {
  if (clientId !== CLIENT_ID) throw new InvalidOAuthClientError();
  return CLIENT;
};

describe("authorization request validation", () => {
  it("returns an exact validated authorization request", async () => {
    await expect(validateAuthorizationRequest(validParams(), {
      resolveClient,
      resource: RESOURCE,
    })).resolves.toEqual({
      client: CLIENT,
      redirectUri: REDIRECT_URI,
      state: "opaque-client-state",
      codeChallenge: CHALLENGE,
      resource: RESOURCE,
      scope: "tabloom:workspace",
    });
  });

  it("rejects duplicate parameter names before resolving a client", async () => {
    const params = validParams();
    params.append("state", "second-state");
    let calls = 0;
    await expect(validateAuthorizationRequest(params, {
      resolveClient: async () => { calls += 1; return CLIENT; },
      resource: RESOURCE,
    })).rejects.toMatchObject({ error: "invalid_request", redirectUri: undefined });
    expect(calls).toBe(0);
  });

  it("treats prototype property names as unknown parameters", async () => {
    const params = validParams();
    params.append("__proto__", "ignored-by-plain-objects");
    await expect(validateAuthorizationRequest(params, { resolveClient, resource: RESOURCE }))
      .rejects.toMatchObject({ error: "invalid_request", redirectUri: REDIRECT_URI });
  });

  it.each([
    ["unknown key", (params: URLSearchParams) => params.set("unexpected", "value")],
    ["missing key", (params: URLSearchParams) => params.delete("scope")],
  ])("rejects an exact-key violation: %s", async (_label, mutate) => {
    const params = validParams();
    mutate(params);
    await expect(validateAuthorizationRequest(params, { resolveClient, resource: RESOURCE }))
      .rejects.toBeInstanceOf(AuthorizationRequestError);
  });

  it("does not expose a redirect for an unknown client", async () => {
    await expect(validateAuthorizationRequest(validParams({ client_id: "95bda9f2-a8a7-4b68-ae38-98b0e9c1553b" }), {
      resolveClient,
      resource: RESOURCE,
    })).rejects.toMatchObject({ error: "invalid_client", redirectUri: undefined });
  });

  it("preserves a typed DCR persistence outage without trusting the redirect", async () => {
    const unavailable = new OAuthPersistenceUnavailableError();

    await expect(validateAuthorizationRequest(validParams(), {
      resolveClient: async () => { throw unavailable; },
      resource: RESOURCE,
    })).rejects.toBe(unavailable);
  });

  it("preserves a retryable CIMD transport failure without trusting the redirect", async () => {
    const unavailable = new CimdUnavailableError();

    await expect(validateAuthorizationRequest(validParams({ client_id: "https://client.example/oauth.json" }), {
      resolveClient: async () => { throw unavailable; },
      resource: RESOURCE,
    })).rejects.toBe(unavailable);
  });

  it("maps a genuine invalid CIMD error to invalid_client", async () => {
    await expect(validateAuthorizationRequest(validParams({ client_id: "https://client.example/oauth.json" }), {
      resolveClient: async () => { throw new CimdFetchError(); },
      resource: RESOURCE,
    })).rejects.toMatchObject({ error: "invalid_client", redirectUri: undefined });
  });

  it.each([
    ["raw Error", new Error("programming failure with private detail")],
    ["spoofed invalid marker", { __tabloom_cimd_error_kind__: "invalid", detail: "private invalid detail" }],
    ["spoofed unavailable marker", {
      __tabloom_cimd_error_kind__: "unavailable",
      detail: "private unavailable detail",
    }],
  ])("preserves an unexpected %s for correlated server_error handling", async (_label, unexpected) => {

    await expect(validateAuthorizationRequest(validParams(), {
      resolveClient: async () => { throw unexpected; },
      resource: RESOURCE,
    })).rejects.toBe(unexpected);
  });

  it("does not expose an unregistered redirect URI", async () => {
    await expect(validateAuthorizationRequest(validParams({ redirect_uri: "https://attacker.example/callback" }), {
      resolveClient,
      resource: RESOURCE,
    })).rejects.toMatchObject({ error: "invalid_request", redirectUri: undefined });
  });

  it.each([
    ["response type", { response_type: "token" }, "invalid_request"],
    ["empty state", { state: "" }, "invalid_request"],
    ["oversized UTF-8 state", { state: "🙂".repeat(129) }, "invalid_request"],
    ["short challenge", { code_challenge: "x".repeat(42) }, "invalid_request"],
    ["44-character challenge", { code_challenge: "x".repeat(44) }, "invalid_request"],
    ["long challenge", { code_challenge: "x".repeat(129) }, "invalid_request"],
    ["invalid challenge character", { code_challenge: `${"x".repeat(42)}=` }, "invalid_request"],
    ["verifier-only dot in challenge", { code_challenge: `${"x".repeat(42)}.` }, "invalid_request"],
    ["verifier-only tilde in challenge", { code_challenge: `${"x".repeat(42)}~` }, "invalid_request"],
    ["plain challenge", { code_challenge_method: "plain" }, "invalid_request"],
    ["wrong resource", { resource: `${RESOURCE}/api/mcp` }, "invalid_request"],
    ["wrong scope", { scope: "openid" }, "invalid_scope"],
    ["multiple scopes", { scope: "tabloom:workspace openid" }, "invalid_scope"],
  ])("returns a redirect-safe error for invalid %s", async (_label, overrides, error) => {
    await expect(validateAuthorizationRequest(validParams(overrides), { resolveClient, resource: RESOURCE }))
      .rejects.toMatchObject({
        error,
        redirectUri: REDIRECT_URI,
        state: "state" in overrides ? overrides.state : "opaque-client-state",
      });
  });
});

describe("S256 PKCE verification", () => {
  it("verifies the RFC 7636 S256 example", () => {
    expect(verifyS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", CHALLENGE)).toBe(true);
  });

  it("rejects mismatches and malformed verifier inputs", () => {
    expect(verifyS256("x".repeat(43), CHALLENGE)).toBe(false);
    expect(verifyS256("too-short", CHALLENGE)).toBe(false);
    expect(verifyS256(`${"x".repeat(42)}=`, CHALLENGE)).toBe(false);
    expect(verifyS256("x".repeat(129), CHALLENGE)).toBe(false);
    expect(verifyS256("x".repeat(43), "too-short")).toBe(false);
  });
});
