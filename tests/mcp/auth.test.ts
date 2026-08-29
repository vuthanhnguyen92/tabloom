import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  generateSecret,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMcpAuthConfig } from "../../services/tabloom-mcp/src/auth/config";
import { createTokenVerifier } from "../../services/tabloom-mcp/src/auth/verify-token";

const SUPABASE_URL = "https://example.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const RESOURCE = "https://mcp.tabloom.app";
const USER_ID = "2f1c5393-46b8-4d79-a12b-b4624b1bc54c";
const CLIENT_ID = "tabloom-test-client";
const ANON_KEY = "test-anon-key";

const validEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  SUPABASE_URL,
  SUPABASE_ANON_KEY: ANON_KEY,
  TABLOOM_MCP_RESOURCE_URL: RESOURCE,
});

describe("MCP authentication configuration", () => {
  it("derives one canonical issuer, JWKS endpoint, and resource origin", () => {
    const config = loadMcpAuthConfig(validEnv());

    expect(config).toMatchObject({
      issuer: ISSUER,
      anonKey: ANON_KEY,
    });
    expect(config.supabaseUrl.href).toBe(`${SUPABASE_URL}/`);
    expect(config.jwksUrl.href).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(config.resourceUrl.href).toBe(`${RESOURCE}/`);
    expect(config.resourceUrl.origin).toBe(RESOURCE);
  });

  it.each(["SUPABASE_URL", "SUPABASE_ANON_KEY", "TABLOOM_MCP_RESOURCE_URL"])(
    "rejects missing %s",
    (name) => {
      const env = validEnv();
      delete env[name];

      expect(() => loadMcpAuthConfig(env)).toThrow(name);
    },
  );

  it.each([
    ["malformed Supabase URL", { SUPABASE_URL: "not a URL" }],
    ["malformed resource URL", { TABLOOM_MCP_RESOURCE_URL: "not a URL" }],
    ["HTTP Supabase URL", { SUPABASE_URL: "http://example.supabase.co" }],
    ["HTTP production resource", { TABLOOM_MCP_RESOURCE_URL: "http://mcp.tabloom.app" }],
    ["resource transport path", { TABLOOM_MCP_RESOURCE_URL: `${RESOURCE}/api/mcp` }],
    ["resource query", { TABLOOM_MCP_RESOURCE_URL: `${RESOURCE}?environment=production` }],
  ])("rejects %s configuration", (_name, overrides) => {
    expect(() => loadMcpAuthConfig({ ...validEnv(), ...overrides })).toThrow();
  });

  it.each([
    ["SUPABASE_URL", "https://your-project.supabase.co"],
    ["SUPABASE_ANON_KEY", "replace-with-project-anon-key"],
    ["TABLOOM_MCP_RESOURCE_URL", "${TABLOOM_MCP_RESOURCE_URL}"],
    ["SUPABASE_ANON_KEY", "<supabase-anon-key>"],
  ])("rejects template-valued %s", (name, value) => {
    expect(() => loadMcpAuthConfig({ ...validEnv(), [name]: value })).toThrow(
      name,
    );
  });
});

describe("Supabase OAuth access-token verification", () => {
  let verifier: ReturnType<typeof createTokenVerifier>;
  let signToken: (
    overrides?: Record<string, unknown>,
    protectedHeader?: { alg: string; kid?: string },
  ) => Promise<string>;

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = "ES256";
    publicJwk.kid = "test-es256-key";

    verifier = createTokenVerifier(
      loadMcpAuthConfig(validEnv()),
      createLocalJWKSet({ keys: [publicJwk] }),
    );
    signToken = async (
      overrides = {},
      protectedHeader = { alg: "ES256", kid: publicJwk.kid },
    ) => {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: ISSUER,
        aud: ["authenticated", RESOURCE],
        sub: USER_ID,
        client_id: CLIENT_ID,
        scope: "openid email",
        iat: now,
        exp: now + 3600,
        ...overrides,
      };

      return new SignJWT(claims)
        .setProtectedHeader(protectedHeader)
        .sign(privateKey);
    };
  });

  it("accepts a resource-bound Supabase OAuth token", async () => {
    const token = await signToken();

    await expect(
      verifier(new Request(`${RESOURCE}/api/mcp`), token),
    ).resolves.toMatchObject({
      token,
      clientId: CLIENT_ID,
      scopes: ["openid", "email"],
      resource: new URL(RESOURCE),
      extra: {
        userId: USER_ID,
        claims: {
          iss: ISSUER,
          aud: ["authenticated", RESOURCE],
          sub: USER_ID,
          client_id: CLIENT_ID,
          scope: "openid email",
        },
      },
    });
  });

  it.each([
    ["issuer", { iss: "https://attacker.example" }],
    ["generic authenticated audience", { aud: "authenticated" }],
    ["different resource audience", { aud: ["authenticated", "https://other.example"] }],
    ["subject", { sub: "not-a-uuid" }],
    ["client", { client_id: "" }],
    ["whitespace client", { client_id: "   " }],
    ["non-canonical client", { client_id: " client-with-padding " }],
    ["expiry", { exp: 1 }],
    ["missing expiry", { exp: undefined }],
  ])("rejects a token with invalid %s", async (_name, overrides) => {
    await expect(
      verifier(
        new Request(`${RESOURCE}/api/mcp`),
        await signToken(overrides),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a token signed by an untrusted ES256 key", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: ISSUER,
      aud: RESOURCE,
      sub: USER_ID,
      client_id: CLIENT_ID,
      exp: now + 3600,
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-es256-key" })
      .sign(privateKey);

    await expect(
      verifier(new Request(`${RESOURCE}/api/mcp`), token),
    ).resolves.toBeUndefined();
  });

  it("rejects credentials that do not use ES256", async () => {
    const now = Math.floor(Date.now() / 1000);
    const secret = await generateSecret("HS256");
    const token = await new SignJWT({
      iss: ISSUER,
      aud: RESOURCE,
      sub: USER_ID,
      client_id: CLIENT_ID,
      exp: now + 3600,
    })
      .setProtectedHeader({ alg: "HS256", kid: "test-es256-key" })
      .sign(secret);

    await expect(
      verifier(new Request(`${RESOURCE}/api/mcp`), token),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when bearer credentials are missing", async () => {
    await expect(
      verifier(new Request(`${RESOURCE}/api/mcp`), undefined),
    ).resolves.toBeUndefined();
  });
});
