import {
  decodeJwt,
  EncryptJWT,
  exportJWK,
  generateKeyPair,
  generateSecret,
  importJWK,
  SignJWT,
  type JWK,
  type JWSHeaderParameters,
  type JWTPayload,
} from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { issueAccessToken } from "../../services/tabloom-mcp/src/auth/access-token";
import { loadFacadeAuthConfig } from "../../services/tabloom-mcp/src/auth/config";
import type { TabloomRequestContext } from "../../services/tabloom-mcp/src/auth/request-context";
import { createSupabaseTokenVerifier } from "../../services/tabloom-mcp/src/auth/verify-supabase-token";
import { createTokenVerifier } from "../../services/tabloom-mcp/src/auth/verify-token";
import type { OAuthPersistence } from "../../services/tabloom-mcp/src/oauth/persistence";

const NOW = 1_788_000_000;
const ORIGIN = "https://tabloom-mcp.vercel.app";
const SUPABASE_URL = "https://exact-project.supabase.co";
const SUPABASE_ISSUER = `${SUPABASE_URL}/auth/v1`;
const INNER_TOKEN = "configured-project-inner-access-token";
const USER_ID = "4f6f8607-9439-4ce3-a19e-f5a302ef3e68";
const OTHER_USER_ID = "c04ebf62-37cc-4419-9f3a-b4e24f796da9";
const CLIENT_ID = "5c177e69-8954-4c57-a777-07c732513bea";
const GRANT_ID = "g".repeat(43);
let privateJwk: JWK;
let otherPrivateJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateJwk = await exportJWK(pair.privateKey);
  const otherPair = await generateKeyPair("ES256", { extractable: true });
  otherPrivateJwk = await exportJWK(otherPair.privateKey);
});

function useFacadeEnvironment(): void {
  vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("TABLOOM_MCP_RESOURCE_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ISSUER_URL", ORIGIN);
  vi.stubEnv("TABLOOM_OAUTH_ENABLED", "true");
  vi.stubEnv("TABLOOM_OAUTH_SIGNING_KEYS", JSON.stringify([
    { kid: "signing-key", active: true, privateJwk: { ...privateJwk, alg: "ES256" } },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_ENCRYPTION_KEYS", JSON.stringify([
    { kid: "encryption-key", active: true, rootKey: Buffer.alloc(32, 7).toString("base64url") },
  ]));
  vi.stubEnv("TABLOOM_OAUTH_DATABASE_SECRET", Buffer.alloc(32, 9).toString("base64url"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  useFacadeEnvironment();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => vi.restoreAllMocks());

function config() {
  return loadFacadeAuthConfig(process.env);
}

async function validToken(): Promise<string> {
  return issueAccessToken({
    sub: USER_ID,
    clientId: CLIENT_ID,
    grantId: GRANT_ID,
    supabaseToken: INNER_TOKEN,
    innerExpiresAt: NOW + 600,
  }, config(), NOW);
}

async function handSignedToken(
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Partial<JWSHeaderParameters> = {},
  signingJwk: JWK = privateJwk,
): Promise<string> {
  const payload = {
    ...decodeJwt(await validToken()),
    ...payloadOverrides,
  } as JWTPayload;
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: "ES256",
      kid: "signing-key",
      typ: "at+jwt",
      ...headerOverrides,
    })
    .sign(await importJWK({ ...signingJwk, alg: "ES256" }, "ES256"));
}

type NestedTokenOptions = {
  payloadOverrides?: Record<string, unknown>;
  headerOverrides?: Record<string, unknown>;
  keyPurpose?: string;
  keyBytes?: number;
};

async function nestedToken(options: NestedTokenOptions = {}): Promise<string> {
  const facade = config();
  const keyPurpose = options.keyPurpose ?? "inner_access_token";
  const derived = facade.encryptionKeys.active!.derived(keyPurpose);
  const key = options.keyBytes === undefined
    ? derived
    : derived.slice(0, options.keyBytes);
  return new EncryptJWT({
    token: INNER_TOKEN,
    iat: NOW,
    nbf: NOW,
    exp: NOW + 600,
    ...options.payloadOverrides,
  })
    .setProtectedHeader({
      alg: "dir",
      enc: "A256GCM",
      kid: "encryption-key",
      typ: "tabloom+inner_access_token",
      ...options.headerOverrides,
    })
    .encrypt(key);
}

type Harness = {
  events: string[];
  revoked: { value: boolean };
  providerUser: { value: string | undefined };
  verifier: ReturnType<typeof createTokenVerifier>;
};

function harness(): Harness {
  const events: string[] = [];
  const revoked = { value: false };
  const providerUser = { value: USER_ID as string | undefined };
  const persistence: OAuthPersistence = {
    async registerClient() { throw new Error("not used"); },
    async getClient() { return null; },
    async consume() { return false; },
    async revokeGrant() {},
    async isGrantRevoked(grantId) {
      events.push(`revocation:${grantId}`);
      return revoked.value;
    },
  };
  const requestContext = {
    userId: USER_ID,
    clientId: CLIENT_ID,
    scope: "tabloom:workspace",
    supabase: { marker: "request-local" },
  } as unknown as TabloomRequestContext;
  const verifier = createTokenVerifier(config(), {
    persistence,
    now: () => NOW,
    verifySupabaseToken: async (token) => {
      events.push(`provider:${token}`);
      return providerUser.value;
    },
    createRequestContext: (input) => {
      events.push(`context:${input.authenticatedUserId}:${input.innerAccessToken}`);
      return requestContext;
    },
  });
  return { events, revoked, providerUser, verifier };
}

describe("Tabloom facade bearer verification", () => {
  it("returns a server-internal RLS context only after strict nested verification", async () => {
    const { events, verifier } = harness();
    const token = await validToken();

    await expect(verifier(new Request(`${ORIGIN}/api/mcp`), token)).resolves.toMatchObject({
      token,
      clientId: CLIENT_ID,
      scopes: ["tabloom:workspace"],
      expiresAt: NOW + 600,
      resource: new URL(ORIGIN),
      extra: {
        userId: USER_ID,
        clientId: CLIENT_ID,
        requestContext: {
          userId: USER_ID,
          clientId: CLIENT_ID,
          scope: "tabloom:workspace",
        },
      },
    });
    expect(events).toEqual([
      `revocation:${GRANT_ID}`,
      `provider:${INNER_TOKEN}`,
      `context:${USER_ID}:${INNER_TOKEN}`,
    ]);
  });

  it.each([
    ["missing bearer", undefined],
    ["empty bearer", ""],
    ["oversized bearer", "x".repeat(32 * 1024 + 1)],
  ])("rejects %s before persistence or provider work", async (_name, token) => {
    const { events, verifier } = harness();

    await expect(
      verifier(new Request(`${ORIGIN}/api/mcp`), token),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it("rejects the former direct Supabase resource-bearing token", async () => {
    const { events, verifier } = harness();
    const directToken = await handSignedToken({
      iss: SUPABASE_ISSUER,
      aud: ["authenticated", ORIGIN],
      scope: "openid email",
      grant_id: undefined,
      supabase_token: undefined,
      jti: undefined,
      nbf: undefined,
    });

    await expect(
      verifier(new Request(`${ORIGIN}/api/mcp`), directToken),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it.each([
    ["generic Supabase audience", { aud: "authenticated" }],
    ["array resource audience", { aud: [ORIGIN] }],
    ["different resource", { aud: "https://other.example" }],
    ["wrong issuer", { iss: "https://attacker.example" }],
    ["missing subject", { sub: undefined }],
    ["non-string subject", { sub: 42 }],
    ["invalid subject", { sub: "not-a-uuid" }],
    ["missing client", { client_id: undefined }],
    ["non-string client", { client_id: 42 }],
    ["non-canonical client", { client_id: " padded-client " }],
    ["non-UUID DCR-shaped client", { client_id: "00000000-0000-0000-0000-000000000000" }],
    ["unsupported scope", { scope: "openid" }],
    ["non-string scope", { scope: 42 }],
    ["missing scope", { scope: undefined }],
    ["missing JTI", { jti: undefined }],
    ["non-string JTI", { jti: 42 }],
    ["short JTI", { jti: "short" }],
    ["missing grant", { grant_id: undefined }],
    ["non-string grant", { grant_id: 42 }],
    ["short grant", { grant_id: "short" }],
    ["missing issued-at", { iat: undefined }],
    ["non-integer issued-at", { iat: "now" }],
    ["missing not-before", { nbf: undefined }],
    ["non-integer not-before", { nbf: "now" }],
    ["missing expiry", { exp: undefined }],
    ["non-integer expiry", { exp: "later" }],
    ["non-string inner credential", { supabase_token: 42 }],
    ["expired lifetime", { exp: NOW - 1 }],
    ["not-yet-valid lifetime", { nbf: NOW + 1 }],
    ["future issuance", { iat: NOW + 1, nbf: NOW + 1 }],
    ["mismatched issued/not-before", { nbf: NOW - 1 }],
    ["overlong lifetime", { exp: NOW + 601 }],
    ["unexpected outer claim", { unexpected: "claim" }],
  ])("rejects a facade token with %s before grant lookup", async (_name, overrides) => {
    const { events, verifier } = harness();

    await expect(
      verifier(new Request(`${ORIGIN}/api/mcp`), await handSignedToken(overrides)),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it.each([
    ["wrong type", { typ: "JWT" }],
    ["missing type", { typ: undefined }],
    ["unknown key", { kid: "unknown-key" }],
    ["unexpected header", { unexpected: "header" }],
  ])("rejects a facade token with %s", async (_name, headerOverrides) => {
    const { events, verifier } = harness();

    await expect(
      verifier(
        new Request(`${ORIGIN}/api/mcp`),
        await handSignedToken({}, headerOverrides as Partial<JWSHeaderParameters>),
      ),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it("rejects a facade token signed by an untrusted ES256 key", async () => {
    const { events, verifier } = harness();

    await expect(
      verifier(new Request(`${ORIGIN}/api/mcp`), await handSignedToken({}, {}, otherPrivateJwk)),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it("rejects any signing algorithm other than ES256", async () => {
    const { events, verifier } = harness();
    const secret = await generateSecret("HS256");
    const token = await new SignJWT(decodeJwt(await validToken()))
      .setProtectedHeader({ alg: "HS256", kid: "signing-key", typ: "at+jwt" })
      .sign(secret);

    await expect(
      verifier(new Request(`${ORIGIN}/api/mcp`), token),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it("checks durable grant revocation before opening or forwarding the inner token", async () => {
    const { events, revoked, verifier } = harness();
    revoked.value = true;

    await expect(
      verifier(new Request(`${ORIGIN}/api/mcp`), await validToken()),
    ).resolves.toBeUndefined();
    expect(events).toEqual([`revocation:${GRANT_ID}`]);
  });

  it("rejects a malformed nested JWE after grant lookup and before provider work", async () => {
    const { events, verifier } = harness();

    await expect(
      verifier(
        new Request(`${ORIGIN}/api/mcp`),
        await handSignedToken({ supabase_token: "not-a-compact-jwe" }),
      ),
    ).resolves.toBeUndefined();
    expect(events).toEqual([`revocation:${GRANT_ID}`]);
  });

  it.each([
    ["expired lifetime", { exp: NOW - 1 }],
    ["unexpected claim", { unexpected: "claim" }],
  ])("rejects a nested credential with %s before provider work", async (_name, overrides) => {
    const { events, verifier } = harness();
    const facade = config();
    const nested = await new EncryptJWT({
      token: INNER_TOKEN,
      iat: NOW,
      nbf: NOW,
      exp: NOW + 600,
      ...overrides,
    })
      .setProtectedHeader({
        alg: "dir",
        enc: "A256GCM",
        kid: "encryption-key",
        typ: "tabloom+inner_access_token",
      })
      .encrypt(facade.encryptionKeys.active!.derived("inner_access_token"));

    await expect(
      verifier(
        new Request(`${ORIGIN}/api/mcp`),
        await handSignedToken({ supabase_token: nested }),
      ),
    ).resolves.toBeUndefined();
    expect(events).toEqual([`revocation:${GRANT_ID}`]);
  });

  it.each([
    ["missing token", { token: undefined }],
    ["non-string token", { token: 42 }],
    ["missing issued-at", { iat: undefined }],
    ["non-integer issued-at", { iat: "now" }],
    ["missing not-before", { nbf: undefined }],
    ["non-integer not-before", { nbf: "now" }],
    ["missing expiry", { exp: undefined }],
    ["non-integer expiry", { exp: "later" }],
    ["issued-at mismatch", { iat: NOW - 1 }],
    ["not-before mismatch", { nbf: NOW - 1 }],
    ["expiry shorter than outer", { exp: NOW + 599 }],
  ])("rejects a nested credential with %s", async (_name, payloadOverrides) => {
    const { events, verifier } = harness();
    const nested = await nestedToken({ payloadOverrides });

    await expect(
      verifier(
        new Request(`${ORIGIN}/api/mcp`),
        await handSignedToken({ supabase_token: nested }),
      ),
    ).resolves.toBeUndefined();
    expect(events).toEqual([`revocation:${GRANT_ID}`]);
  });

  it.each([
    ["wrong key-management algorithm", { headerOverrides: { alg: "A256KW" } }],
    ["wrong content-encryption algorithm", { headerOverrides: { enc: "A128GCM" }, keyBytes: 16 }],
    ["unknown encryption key", { headerOverrides: { kid: "unknown-key" } }],
    ["wrong artifact purpose", {
      headerOverrides: { typ: "tabloom+refresh_token" },
      keyPurpose: "refresh_token",
    }],
    ["missing artifact type", { headerOverrides: { typ: undefined } }],
    ["unexpected protected header", { headerOverrides: { unexpected: "header" } }],
  ])("rejects a nested credential with %s", async (_name, options) => {
    const { events, verifier } = harness();
    const nested = await nestedToken(options);

    await expect(
      verifier(
        new Request(`${ORIGIN}/api/mcp`),
        await handSignedToken({ supabase_token: nested }),
      ),
    ).resolves.toBeUndefined();
    expect(events).toEqual([`revocation:${GRANT_ID}`]);
  });

  it.each([
    CLIENT_ID,
    "https://CLIENT.example/oauth.json",
    "https://client.example:443/oauth.json",
  ])("accepts the canonical public client identifier %s", async (clientId) => {
    const { events, verifier } = harness();
    const token = await handSignedToken({ client_id: clientId });

    await expect(
      verifier(new Request(`${ORIGIN}/api/mcp`), token),
    ).resolves.toMatchObject({ clientId, extra: { clientId } });
    expect(events).toEqual([
      `revocation:${GRANT_ID}`,
      `provider:${INNER_TOKEN}`,
      `context:${USER_ID}:${INNER_TOKEN}`,
    ]);
  });

  it("rejects Supabase validation failure without creating a request context", async () => {
    const { events, providerUser, verifier } = harness();
    providerUser.value = undefined;

    await expect(
      verifier(new Request(`${ORIGIN}/api/mcp`), await validToken()),
    ).resolves.toBeUndefined();
    expect(events).toEqual([
      `revocation:${GRANT_ID}`,
      `provider:${INNER_TOKEN}`,
    ]);
  });

  it("requires exact inner and outer UUID equality", async () => {
    const { events, providerUser, verifier } = harness();
    providerUser.value = OTHER_USER_ID;

    await expect(
      verifier(new Request(`${ORIGIN}/api/mcp`), await validToken()),
    ).resolves.toBeUndefined();
    expect(events).toEqual([
      `revocation:${GRANT_ID}`,
      `provider:${INNER_TOKEN}`,
    ]);
  });

  it("reaches inner-user lookup for a B-issued token whose only subject change is A", async () => {
    const { events, providerUser, verifier } = harness();
    const userAToken = await validToken();
    const userBToken = await issueAccessToken({
      sub: OTHER_USER_ID,
      clientId: CLIENT_ID,
      grantId: GRANT_ID,
      supabaseToken: "inner-user-b",
      innerExpiresAt: NOW + 540,
    }, config(), NOW - 60);
    const userBPayload = decodeJwt(userBToken);
    expect(userBPayload.iat).not.toBe(decodeJwt(userAToken).iat);
    const mismatchToken = await handSignedToken({
      ...userBPayload,
      sub: USER_ID,
      jti: "z".repeat(43),
    });
    providerUser.value = OTHER_USER_ID;

    await expect(
      verifier(new Request(`${ORIGIN}/api/mcp`), mismatchToken),
    ).resolves.toBeUndefined();
    expect(events).toEqual([
      `revocation:${GRANT_ID}`,
      "provider:inner-user-b",
    ]);
  });

  it("collapses persistence failure to undefined without logging credentials or provider details", async () => {
    const token = await validToken();
    const providerDetail = "provider-secret-detail";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const persistence = {
      async isGrantRevoked() { throw new Error(`${providerDetail}:${token}`); },
    } as unknown as OAuthPersistence;
    const verifier = createTokenVerifier(config(), {
      persistence,
      now: () => NOW,
      verifySupabaseToken: async () => USER_ID,
    });

    await expect(
      verifier(new Request(`${ORIGIN}/api/mcp`), token),
    ).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});

describe("configured-project Supabase validation", () => {
  it("calls only the configured project's auth.getUser with the inner token", async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    const factory = vi.fn().mockReturnValue({ auth: { getUser } });
    const verifySupabaseToken = createSupabaseTokenVerifier(config(), factory);

    await expect(verifySupabaseToken(INNER_TOKEN)).resolves.toBe(USER_ID);
    expect(factory).toHaveBeenCalledWith(`${SUPABASE_URL}/`, "test-anon-key", {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
    expect(getUser).toHaveBeenCalledWith(INNER_TOKEN);
  });

  it.each([
    ["provider error", { data: { user: null }, error: { message: "provider detail" } }],
    ["missing user", { data: { user: null }, error: null }],
    ["invalid UUID", { data: { user: { id: "not-a-uuid" } }, error: null }],
  ])("returns undefined for %s", async (_name, result) => {
    const getUser = vi.fn().mockResolvedValue(result);
    const verifySupabaseToken = createSupabaseTokenVerifier(
      config(),
      vi.fn().mockReturnValue({ auth: { getUser } }),
    );

    await expect(verifySupabaseToken(INNER_TOKEN)).resolves.toBeUndefined();
  });

  it("returns undefined when the provider call throws and emits no provider details", async () => {
    const providerDetail = "provider-secret-detail";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const getUser = vi.fn().mockRejectedValue(new Error(providerDetail));
    const verifySupabaseToken = createSupabaseTokenVerifier(
      config(),
      vi.fn().mockReturnValue({ auth: { getUser } }),
    );

    await expect(verifySupabaseToken(INNER_TOKEN)).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
