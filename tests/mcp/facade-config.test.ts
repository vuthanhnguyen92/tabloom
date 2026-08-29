import { generateKeyPair, exportJWK } from "jose";
import { describe, expect, it } from "vitest";
import { loadFacadeAuthConfig } from "../../services/tabloom-mcp/src/auth/config";

const RESOURCE = "https://mcp.tabloom.app";

async function signingKey(kid = "signing-a", active = true) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  return { kid, active, privateJwk: { ...privateJwk, alg: "ES256" } };
}

function encryptionKey(kid = "encryption-a", active = true) {
  return {
    kid,
    active,
    rootKey: Buffer.alloc(32, kid).toString("base64url"),
  };
}

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
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
    const config = loadFacadeAuthConfig(env());

    expect(config.oauthEnabled).toBe(false);
    expect(config.issuerUrl.href).toBe(`${RESOURCE}/`);
    expect(config.signingKeys.active).toBeUndefined();
    expect(config.encryptionKeys.active).toBeUndefined();
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
      }),
    );

    expect(config.signingKeys.active?.kid).toBe("current");
    expect(config.encryptionKeys.active?.kid).toBe("current");
    expect([...config.signingKeys.keys.keys()]).toEqual(["old", "current"]);
    expect([...config.encryptionKeys.keys.keys()]).toEqual(["old", "current"]);
    const serialized = JSON.stringify(config.signingKeys);
    expect(serialized).toContain('"kid":"current"');
    expect(serialized).not.toContain('"d"');
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
      const { x: _x, ...privateJwk } = key.privateJwk;
      return JSON.stringify([{ ...key, privateJwk }]);
    }, JSON.stringify([encryptionKey()])],
    ["invalid signing private material", async () => {
      const key = await signingKey();
      return JSON.stringify([{ ...key, privateJwk: { ...key.privateJwk, d: "not-base64url!" } }]);
    }, JSON.stringify([encryptionKey()])],
  ])("rejects %s without disclosing key material", async (_name, signing, encryption) => {
    const signingJson = await signing();
    const encryptionJson = await encryption;
    const run = () => loadFacadeAuthConfig(env({ TABLOOM_OAUTH_ENABLED: "true", TABLOOM_OAUTH_SIGNING_KEYS: signingJson, TABLOOM_OAUTH_ENCRYPTION_KEYS: encryptionJson }));

    expect(run).toThrow();
    expect(run).not.toThrow(signingJson);
    expect(run).not.toThrow(encryptionJson);
  });

  it("rejects oversized key JSON and configurations without exactly one active key of each kind", async () => {
    const signing = JSON.stringify([await signingKey()]);
    const encryption = JSON.stringify([encryptionKey()]);

    expect(() => loadFacadeAuthConfig(env({ TABLOOM_OAUTH_ENABLED: "true", TABLOOM_OAUTH_SIGNING_KEYS: "[" + " ".repeat(65_536) + "]", TABLOOM_OAUTH_ENCRYPTION_KEYS: encryption }))).toThrow();
    expect(() => loadFacadeAuthConfig(env({ TABLOOM_OAUTH_ENABLED: "true", TABLOOM_OAUTH_SIGNING_KEYS: signing, TABLOOM_OAUTH_ENCRYPTION_KEYS: JSON.stringify([{ ...encryptionKey(), active: false }] ) }))).toThrow();
  });
});
