import { CompactEncrypt, generateKeyPair, exportJWK, importJWK, jwtDecrypt, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { issueAccessToken, verifyAccessToken } from "../../services/tabloom-mcp/src/auth/access-token";
import { sealArtifact, openArtifact, hashOpaqueIdentifier } from "../../services/tabloom-mcp/src/auth/artifacts";
import {
  createEncryptionKeyRing,
  createSigningKeyRing,
  signingPrivateKey,
} from "../../services/tabloom-mcp/src/auth/key-rings";

const NOW = 1_750_000_000;
const ISSUER = "https://mcp.tabloom.app";
const RESOURCE = `${ISSUER}/mcp`;
const USER_ID = "2f1c5393-46b8-4d79-a12b-b4624b1bc54c";

async function signing(kid: string, active: true) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return { kid, active, privateJwk: { ...(await exportJWK(privateKey)), alg: "ES256" } };
}

function encryption(kid: string, active: boolean) {
  return { kid, active, rootKey: Buffer.alloc(32, kid).toString("base64url") };
}

async function config() {
  return {
    supabaseUrl: new URL("https://example.supabase.co"),
    issuer: "https://example.supabase.co/auth/v1",
    jwksUrl: new URL("https://example.supabase.co/auth/v1/.well-known/jwks.json"),
    anonKey: "test-anon-key",
    oauthEnabled: true,
    issuerUrl: new URL(ISSUER),
    resourceUrl: new URL(RESOURCE),
    signingKeys: await createSigningKeyRing([await signing("current", true)]),
    encryptionKeys: createEncryptionKeyRing([encryption("current", true)]),
  };
}

describe("purpose-separated encrypted artifacts", () => {
  it("round trips a payload and rejects a different purpose", async () => {
    const keys = createEncryptionKeyRing([encryption("current", true)]);
    const sealed = await sealArtifact("authorization_code", { code: "opaque" }, 120, keys, NOW);

    await expect(openArtifact("authorization_code", sealed, keys, NOW)).resolves.toEqual({ code: "opaque" });
    await expect(openArtifact("refresh_token", sealed, keys, NOW)).rejects.toThrow();
  });

  it("rejects wrong keys, invalid timing, malformed JWE, and oversized payloads", async () => {
    const keys = createEncryptionKeyRing([encryption("current", true)]);
    const sealed = await sealArtifact("consent_session", { value: "ok" }, 60, keys, NOW);

    await expect(openArtifact("consent_session", sealed, createEncryptionKeyRing([encryption("other", true)]), NOW)).rejects.toThrow();
    await expect(openArtifact("consent_session", sealed, keys, NOW + 61)).rejects.toThrow();
    await expect(openArtifact("consent_session", "invalid.compact.jwe", keys, NOW)).rejects.toThrow();
    await expect(openArtifact("consent_session", "x".repeat(32 * 1024 + 1), keys, NOW)).rejects.toThrow();
    await expect(sealArtifact("consent_session", { value: "x".repeat(16 * 1024 + 1) }, 60, keys, NOW)).rejects.toThrow();
  });

  it("rejects an artifact before its not-before time and oversized decrypted plaintext", async () => {
    const keys = createEncryptionKeyRing([encryption("current", true)]);
    const encrypted = await new CompactEncrypt(
      Uint8Array.from(Buffer.from(JSON.stringify({ payload: { value: "ok" }, iat: NOW, nbf: NOW + 1, exp: NOW + 60 }), "utf8")),
    )
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: "current", typ: "tabloom+consent_session" })
      .encrypt(keys.active!.derived("consent_session"));
    const oversized = await new CompactEncrypt(Uint8Array.from(Buffer.alloc(16 * 1024 + 1)))
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: "current", typ: "tabloom+consent_session" })
      .encrypt(keys.active!.derived("consent_session"));

    await expect(openArtifact("consent_session", encrypted, keys, NOW)).rejects.toThrow();
    await expect(openArtifact("consent_session", oversized, keys, NOW)).rejects.toThrow();
  });

  it("enforces authorization-code and refresh-token lifetime ceilings", async () => {
    const keys = createEncryptionKeyRing([encryption("current", true)]);

    await expect(sealArtifact("authorization_code", { jti: "code" }, 120, keys, NOW)).resolves.toEqual(expect.any(String));
    await expect(sealArtifact("authorization_code", { jti: "code" }, 121, keys, NOW)).rejects.toThrow();
    await expect(sealArtifact("refresh_token", { jti: "refresh" }, 30 * 24 * 60 * 60, keys, NOW)).resolves.toEqual(expect.any(String));
    await expect(sealArtifact("refresh_token", { jti: "refresh" }, 30 * 24 * 60 * 60 + 1, keys, NOW)).rejects.toThrow();
  });

  it("keeps inactive keys valid during rotation and rejects them after removal", async () => {
    const old = encryption("old", false);
    const keysWithOldActive = createEncryptionKeyRing([{ ...old, active: true }]);
    const sealed = await sealArtifact("refresh_token", { jti: "old" }, 60, keysWithOldActive, NOW);
    const overlap = createEncryptionKeyRing([old, encryption("new", true)]);

    await expect(openArtifact("refresh_token", sealed, overlap, NOW)).resolves.toEqual({ jti: "old" });
    await expect(openArtifact("refresh_token", sealed, createEncryptionKeyRing([encryption("new", true)]), NOW)).rejects.toThrow();
  });

  it("hashes opaque identifiers as lowercase SHA-256 hex", () => {
    expect(hashOpaqueIdentifier("grant-family")).toBe("3894fd1f306d7bd5bfd29595a6f8a329622a02c2d734bf0bebf0fba266691e11");
  });
});

describe("resource-bound Tabloom access tokens", () => {
  function input(overrides: Record<string, unknown> = {}) {
    return {
      sub: USER_ID,
      clientId: "https://client.example/metadata.json",
      grantId: "grant-family",
      supabaseToken: "inner-supabase-token",
      innerExpiresAt: NOW + 600,
      ...overrides,
    };
  }

  it("issues exact outer claims and encrypts the inner Supabase token", async () => {
    const facade = await config();
    const token = await issueAccessToken(input(), facade, NOW);
    const { payload, protectedHeader } = await verifyAccessToken(token, facade, NOW);

    expect(protectedHeader).toMatchObject({ alg: "ES256", kid: "current", typ: "at+jwt" });
    expect(payload).toMatchObject({ iss: ISSUER, aud: RESOURCE, sub: USER_ID, client_id: "https://client.example/metadata.json", scope: "tabloom:workspace", iat: NOW, nbf: NOW, exp: NOW + 600, grant_id: "grant-family" });
    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.supabase_token).not.toBe("inner-supabase-token");
    const inner = await jwtDecrypt(payload.supabase_token, facade.encryptionKeys.active!.derived("inner_access_token"), { currentDate: new Date(NOW * 1000) });
    expect(inner.payload).toMatchObject({ token: "inner-supabase-token", exp: NOW + 600 });
  });

  it("never extends the outer token beyond the inner Supabase expiry", async () => {
    const facade = await config();
    const token = await issueAccessToken(input({ innerExpiresAt: NOW + 90 }), facade, NOW);
    const { payload } = await verifyAccessToken(token, facade, NOW);
    expect(payload.exp).toBe(NOW + 90);
  });

  it("rejects oversized bearer tokens before JWT parsing", async () => {
    await expect(verifyAccessToken("x".repeat(32 * 1024 + 1), await config(), NOW)).rejects.toThrow();
  });

  it("signs only with the active private key and verifies retained public keys", async () => {
    const oldActive = await signing("old", true);
    const newActive = await signing("current", true);
    const oldPublicJwk = { ...oldActive.privateJwk };
    delete oldPublicJwk.d;
    const oldFacade = {
      ...(await config()),
      signingKeys: createSigningKeyRing([oldActive]),
    };
    const oldToken = await issueAccessToken(input(), oldFacade, NOW);
    const overlap = createSigningKeyRing([
      { kid: "old", active: false, publicJwk: oldPublicJwk },
      newActive,
    ]);
    const rotatedFacade = { ...(await config()), signingKeys: overlap };

    await expect(verifyAccessToken(oldToken, rotatedFacade, NOW)).resolves.toBeDefined();
    expect(() => signingPrivateKey(overlap, "old")).toThrow();
    const newToken = await issueAccessToken(input(), rotatedFacade, NOW);
    await expect(verifyAccessToken(newToken, rotatedFacade, NOW)).resolves.toBeDefined();
  });

  it("rejects a token whose audience includes the resource but is not exactly the resource", async () => {
    const signingKey = await signing("current", true);
    const facade = {
      ...(await config()),
      signingKeys: await createSigningKeyRing([signingKey]),
    };
    const token = await new SignJWT({
      sub: USER_ID,
      client_id: "https://client.example/metadata.json",
      scope: "tabloom:workspace",
      grant_id: "grant-family",
      supabase_token: "opaque-inner-token",
    })
      .setProtectedHeader({ alg: "ES256", kid: "current", typ: "at+jwt" })
      .setIssuer(ISSUER)
      .setAudience([ISSUER, "https://other.example"])
      .setIssuedAt(NOW)
      .setNotBefore(NOW)
      .setExpirationTime(NOW + 60)
      .setJti("jti")
      .sign(await importJWK(signingKey.privateJwk, "ES256"));

    await expect(verifyAccessToken(token, facade, NOW)).rejects.toThrow();
  });
});
