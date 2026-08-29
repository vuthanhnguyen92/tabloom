import { hkdfSync } from "node:crypto";
import { importJWK, type JWK } from "jose";

export type SigningKeyDefinition = {
  kid: string;
  active: boolean;
  privateJwk: JWK;
};

export type EncryptionKeyDefinition = {
  kid: string;
  active: boolean;
  rootKey: string;
};

export type SigningKeyRing = {
  active?: SigningKeyDefinition;
  keys: ReadonlyMap<string, SigningKeyDefinition>;
};

export type EncryptionKey = {
  kid: string;
  active: boolean;
  derived(purpose: string): Uint8Array;
};

export type EncryptionKeyRing = {
  active?: EncryptionKey;
  keys: ReadonlyMap<string, EncryptionKey>;
};

function requireKid(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error("OAuth key kid must be a non-empty string");
  }
  return value;
}

function requireActive(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("OAuth key active flag must be a boolean");
  }
  return value;
}

function decodeBase64Url(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("OAuth encryption root key must be base64url");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("OAuth encryption root key must be exactly 32 bytes");
  }
  return decoded;
}

export function createSigningKeyRing(
  values: readonly SigningKeyDefinition[],
): SigningKeyRing {
  const keys = new Map<string, SigningKeyDefinition>();
  let active: SigningKeyDefinition | undefined;

  for (const value of values) {
    const kid = requireKid(value?.kid);
    const isActive = requireActive(value?.active);
    if (!value.privateJwk || typeof value.privateJwk !== "object") {
      throw new Error("OAuth signing key must contain a private JWK");
    }
    if (value.privateJwk.kty !== "EC" || value.privateJwk.crv !== "P-256") {
      throw new Error("OAuth signing key must be an ES256 EC P-256 key");
    }
    if (value.privateJwk.alg && value.privateJwk.alg !== "ES256") {
      throw new Error("OAuth signing key algorithm must be ES256");
    }
    if (typeof value.privateJwk.d !== "string") {
      throw new Error("OAuth signing key must contain private key material");
    }
    if (keys.has(kid)) {
      throw new Error("OAuth signing key ids must be unique");
    }
    const key = { kid, active: isActive, privateJwk: { ...value.privateJwk, alg: "ES256", kid } };
    keys.set(kid, key);
    if (isActive) {
      if (active) throw new Error("OAuth signing keys must have exactly one active key");
      active = key;
    }
  }

  return { active, keys };
}

export function createEncryptionKeyRing(
  values: readonly EncryptionKeyDefinition[],
): EncryptionKeyRing {
  const keys = new Map<string, EncryptionKey>();
  let active: EncryptionKey | undefined;

  for (const value of values) {
    const kid = requireKid(value?.kid);
    const isActive = requireActive(value?.active);
    if (keys.has(kid)) throw new Error("OAuth encryption key ids must be unique");
    const root = decodeBase64Url(value.rootKey);
    const key: EncryptionKey = {
      kid,
      active: isActive,
      derived(purpose) {
        return Uint8Array.from(
          new Uint8Array(hkdfSync(
            "sha256",
            root,
            Buffer.alloc(0),
            Buffer.from(`tabloom-oauth:${purpose}`, "utf8"),
            32,
          )),
        );
      },
    };
    keys.set(kid, key);
    if (isActive) {
      if (active) throw new Error("OAuth encryption keys must have exactly one active key");
      active = key;
    }
  }

  return { active, keys };
}

export async function importSigningPrivateKey(key: SigningKeyDefinition) {
  return importJWK(key.privateJwk, "ES256");
}

export async function importSigningPublicKey(key: SigningKeyDefinition) {
  const { kty, crv, x, y, kid, alg } = key.privateJwk;
  return importJWK({ kty, crv, x, y, kid, alg }, "ES256");
}
