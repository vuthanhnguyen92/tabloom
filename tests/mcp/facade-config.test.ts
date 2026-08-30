import { generateKeyPair, exportJWK } from "jose";
import { describe, expect, it } from "vitest";
import { loadFacadeAuthConfig } from "../../services/tabloom-mcp/src/auth/config";

const RESOURCE = "https://mcp.tabloom.app";
const DATABASE_SECRET = Buffer.alloc(32, 9).toString("base64url");
const NONCANONICAL_DATABASE_SECRET = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ";

async function signingKey(kid = "signing-a", active = true) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  return active
    ? { kid, active: true as const, privateJwk: { ...privateJwk, alg: "ES256" } }
    : { kid, active: false as const, publicJwk: { ...publicJwk, alg: "ES256" } };
}

function encryptionKey(kid = "encryption-a", active = true) {
  return {
    kid,
    active,
    rootKey: Buffer.alloc(32, kid).toString("base64url"),
  };
}

function env(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "test-anon-key",
    TABLOOM_MCP_RESOURCE_URL: RESOURCE,
    TABLOOM_OAUTH_ISSUER_URL: RESOURCE,
    TABLOOM_OAUTH_ENABLED: "false",
    ...overrides,
  };
}

describe("authorization facade configuration", () => {
  it("supports disabled mode without private facade keys", () => {
    const config = loadFacadeAuthConfig(env({
      TABLOOM_OAUTH_DATABASE_SECRET: undefined,
    }));

    expect(config.oauthEnabled).toBe(false);
    expect(config.issuerUrl.href).toBe(`${RESOURCE}/`);
    expect(config.signingKeys.active).toBeUndefined();
    expect(config.encryptionKeys.active).toBeUndefined();
    expect(config.databaseProofKey).toBeUndefined();
  });

  it("loads one active signing and encryption key while retaining inactive rotation keys", async () => {
    const config = loadFacadeAuthConfig(
      env({
        TABLOOM_OAUTH_ENABLED: "true",
        TABLOOM_OAUTH_SIGNING_KEYS: JSON.stringify([
          await signingKey("old", false),
          await signingKey("current", true),
        ]),
        TABLOOM_OAUTH_ENCRYPTION_KEYS: JSON.stringify([
          encryptionKey("old", false),
          encryptionKey("current", true),
        ]),
        TABLOOM_OAUTH_DATABASE_SECRET: DATABASE_SECRET,
      }),
    );

    expect(config.signingKeys.active?.kid).toBe("current");
    expect(config.encryptionKeys.active?.kid).toBe("current");
    expect([...config.signingKeys.keys.keys()]).toEqual(["old", "current"]);
    expect([...config.encryptionKeys.keys.keys()]).toEqual(["old", "current"]);
    expect(config.databaseProofKey).toBeDefined();
    const serialized = JSON.stringify(config.signingKeys);
    expect(serialized).toContain('"kid":"current"');
    expect(serialized).not.toContain('"d"');
    expect(JSON.stringify(config)).not.toContain(DATABASE_SECRET);
  });

  it("rejects private material on inactive entries and public-only active entries", async () => {
    const inactivePrivate = await signingKey("old", true);
    const activePublic = await signingKey("current", false);
    const currentPrivate = await signingKey("current", true);
    const encryption = JSON.stringify([encryptionKey()]);

    expect(() => loadFacadeAuthConfig(env({
      TABLOOM_OAUTH_ENABLED: "true",
      TABLOOM_OAUTH_DATABASE_SECRET: DATABASE_SECRET,
      TABLOOM_OAUTH_SIGNING_KEYS: JSON.stringify([
        { ...inactivePrivate, active: false },
        currentPrivate,
      ]),
      TABLOOM_OAUTH_ENCRYPTION_KEYS: encryption,
    }))).toThrow();
    expect(() => loadFacadeAuthConfig(env({
      TABLOOM_OAUTH_ENABLED: "true",
      TABLOOM_OAUTH_DATABASE_SECRET: DATABASE_SECRET,
      TABLOOM_OAUTH_SIGNING_KEYS: JSON.stringify([
        { ...activePublic, active: true },
      ]),
      TABLOOM_OAUTH_ENCRYPTION_KEYS: encryption,
    }))).toThrow();
  });

  it("requires one canonical 32-byte database proof secret only while enabled", async () => {
    const signing = JSON.stringify([await signingKey()]);
    const encryption = JSON.stringify([encryptionKey()]);
    const configured = (secret: string | undefined) => env({
      TABLOOM_OAUTH_ENABLED: "true",
      TABLOOM_OAUTH_SIGNING_KEYS: signing,
      TABLOOM_OAUTH_ENCRYPTION_KEYS: encryption,
      TABLOOM_OAUTH_DATABASE_SECRET: secret,
    });

    expect(() => loadFacadeAuthConfig(configured(undefined))).toThrow();
    expect(() => loadFacadeAuthConfig(configured("not base64url!"))).toThrow();
    expect(() => loadFacadeAuthConfig(configured(
      Buffer.alloc(31, 9).toString("base64url"),
    ))).toThrow();
    expect(NONCANONICAL_DATABASE_SECRET).toHaveLength(43);
    expect(Buffer.from(NONCANONICAL_DATABASE_SECRET, "base64url")).toHaveLength(32);
    expect(Buffer.from(NONCANONICAL_DATABASE_SECRET, "base64url").toString("base64url"))
      .not.toBe(NONCANONICAL_DATABASE_SECRET);
    expect(() => loadFacadeAuthConfig(configured(
      NONCANONICAL_DATABASE_SECRET,
    ))).toThrow();
    expect(() => loadFacadeAuthConfig(configured(DATABASE_SECRET))).not.toThrow();
  });

  it.each([
    ["missing enabled switch", { TABLOOM_OAUTH_ENABLED: undefined }],
    ["template issuer", { TABLOOM_OAUTH_ISSUER_URL: "${ISSUER}" }],
    ["issuer mismatch", { TABLOOM_OAUTH_ISSUER_URL: "https://other.tabloom.app" }],
    ["issuer path", { TABLOOM_OAUTH_ISSUER_URL: `${RESOURCE}/oauth` }],
    ["issuer query", { TABLOOM_OAUTH_ISSUER_URL: `${RESOURCE}?x=1` }],
    ["invalid enabled switch", { TABLOOM_OAUTH_ENABLED: "TRUE" }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => loadFacadeAuthConfig(env(overrides))).toThrow();
  });

  it.each([
    ["duplicate signing kid", async () => JSON.stringify([await signingKey("same"), await signingKey("same", false)]), JSON.stringify([encryptionKey()])],
    ["duplicate encryption kid", async () => JSON.stringify([await signingKey()]), JSON.stringify([encryptionKey("same"), encryptionKey("same", false)])],
    ["unknown signing algorithm", async () => {
      const key = await signingKey();
      return JSON.stringify([{ ...key, privateJwk: { ...key.privateJwk, alg: "RS256" } }]);
    }, JSON.stringify([encryptionKey()])],
    ["invalid encryption base64url", async () => JSON.stringify([await signingKey()]), JSON.stringify([{ ...encryptionKey(), rootKey: "not base64!" }])],
    ["short encryption root", async () => JSON.stringify([await signingKey()]), JSON.stringify([{ ...encryptionKey(), rootKey: Buffer.alloc(31).toString("base64url") }])],
    ["missing signing coordinate", async () => {
      const key = await signingKey();
      const privateJwk = { ...key.privateJwk };
      delete privateJwk.x;
      return JSON.stringify([{ ...key, privateJwk }]);
    }, JSON.stringify([encryptionKey()])],
    ["invalid signing private material", async () => {
      const key = await signingKey();
      return JSON.stringify([{ ...key, privateJwk: { ...key.privateJwk, d: "not-base64url!" } }]);
    }, JSON.stringify([encryptionKey()])],
  ])("rejects %s without disclosing key material", async (_name, signing, encryption) => {
    const signingJson = await signing();
    const encryptionJson = await encryption;
    const run = () => loadFacadeAuthConfig(env({ TABLOOM_OAUTH_ENABLED: "true", TABLOOM_OAUTH_DATABASE_SECRET: DATABASE_SECRET, TABLOOM_OAUTH_SIGNING_KEYS: signingJson, TABLOOM_OAUTH_ENCRYPTION_KEYS: encryptionJson }));

    expect(run).toThrow();
    expect(run).not.toThrow(signingJson);
    expect(run).not.toThrow(encryptionJson);
  });

  it("rejects oversized key JSON and configurations without exactly one active key of each kind", async () => {
    const signing = JSON.stringify([await signingKey()]);
    const encryption = JSON.stringify([encryptionKey()]);

    expect(() => loadFacadeAuthConfig(env({ TABLOOM_OAUTH_ENABLED: "true", TABLOOM_OAUTH_DATABASE_SECRET: DATABASE_SECRET, TABLOOM_OAUTH_SIGNING_KEYS: "[" + " ".repeat(65_536) + "]", TABLOOM_OAUTH_ENCRYPTION_KEYS: encryption }))).toThrow();
    expect(() => loadFacadeAuthConfig(env({ TABLOOM_OAUTH_ENABLED: "true", TABLOOM_OAUTH_DATABASE_SECRET: DATABASE_SECRET, TABLOOM_OAUTH_SIGNING_KEYS: signing, TABLOOM_OAUTH_ENCRYPTION_KEYS: JSON.stringify([{ ...encryptionKey(), active: false }] ) }))).toThrow();
  });
});
