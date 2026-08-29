import { exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://mcp.tabloom.app";

async function signingKey(kid: string, active: boolean) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return {
    kid,
    active,
    privateJwk: { ...await exportJWK(privateKey), alg: "ES256" },
  };
}

async function useFacadeEnvironment() {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("TABLOOM_MCP_RESOURCE_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ISSUER_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ENABLED", "false");
  vi.stubEnv("TABLOOM_OAUTH_ENCRYPTION_KEYS", "[]");
  vi.stubEnv("TABLOOM_OAUTH_SIGNING_KEYS", JSON.stringify([
    await signingKey("current-signing-key", true),
    await signingKey("retained-signing-key", false),
  ]));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("OAuth facade discovery", () => {
  it("publishes exact authorization-server metadata while disabled", async () => {
    await useFacadeEnvironment();
    const route = await import(
      "../../services/tabloom-mcp/app/.well-known/oauth-authorization-server/route"
    );

    const response = route.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("public");
    await expect(response.json()).resolves.toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      jwks_uri: `${ORIGIN}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["tabloom:workspace"],
    });

    const optionsResponse = route.OPTIONS();
    expect(optionsResponse.status).toBe(204);
    expect(optionsResponse.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });

  it("points protected-resource metadata only at the facade issuer", async () => {
    await useFacadeEnvironment();
    const route = await import(
      "../../services/tabloom-mcp/app/.well-known/oauth-protected-resource/route"
    );

    const response = route.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      resource: ORIGIN,
      authorization_servers: [ORIGIN],
    });
    expect(route.OPTIONS().headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });

  it("publishes every signing key as a public ES256 JWKS key", async () => {
    await useFacadeEnvironment();
    const route = await import(
      "../../services/tabloom-mcp/app/.well-known/jwks.json/route"
    );

    const response = await route.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("public");
    const { keys } = await response.json() as { keys: Array<Record<string, unknown>> };
    expect(keys.map((key) => key.kid).sort()).toEqual([
      "current-signing-key",
      "retained-signing-key",
    ]);
    for (const key of keys) {
      expect(key).toMatchObject({
        kty: "EC",
        crv: "P-256",
        alg: "ES256",
        use: "sig",
      });
      expect(Object.keys(key).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
      expect(key.d).toBeUndefined();
    }
    expect(route.OPTIONS().headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
  });
});
