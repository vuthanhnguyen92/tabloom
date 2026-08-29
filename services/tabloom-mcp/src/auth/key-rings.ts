import { createPrivateKey, createPublicKey, hkdfSync, type KeyObject } from "node:crypto";
import type { JWK } from "jose";

export type SigningKeyInput = {
  kid: string;
  active: boolean;
  privateJwk: JWK;
};

export type EncryptionKeyDefinition = {
  kid: string;
  active: boolean;
  rootKey: string;
};

export type SigningKey = {
  kid: string;
  active: boolean;
  alg: "ES256";
};

export type SigningKeyRing = {
  active?: SigningKey;
  keys: ReadonlyMap<string, SigningKey>;
  toJSON(): { active?: SigningKey; keys: SigningKey[] };
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

type SigningKeyMaterial = {
  privateKey: KeyObject;
  publicKey: KeyObject;
};

const signingMaterials = new WeakMap<SigningKeyRing, ReadonlyMap<string, SigningKeyMaterial>>();

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

function isP256JwkParameter(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function importPrivateSigningKey(value: JWK, kid: string): SigningKeyMaterial {
  if (
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    (value.alg !== undefined && value.alg !== "ES256") ||
    !isP256JwkParameter(value.x) ||
    !isP256JwkParameter(value.y) ||
    !isP256JwkParameter(value.d)
  ) {
    throw new Error("OAuth signing key must be an ES256 private JWK");
  }
  try {
    const privateKey = createPrivateKey({
      key: { kty: value.kty, crv: value.crv, x: value.x, y: value.y, d: value.d },
      format: "jwk",
    });
    return { privateKey, publicKey: createPublicKey(privateKey) };
  } catch {
    throw new Error(`OAuth signing key ${kid} is invalid`);
  }
}

export function createSigningKeyRing(
  values: readonly SigningKeyInput[],
): SigningKeyRing {
  const keys = new Map<string, SigningKey>();
  const materials = new Map<string, SigningKeyMaterial>();
  let active: SigningKey | undefined;

  for (const value of values) {
    const kid = requireKid(value?.kid);
    const isActive = requireActive(value?.active);
    if (!value.privateJwk || typeof value.privateJwk !== "object") {
      throw new Error("OAuth signing key must contain a private JWK");
    }
    if (keys.has(kid)) {
      throw new Error("OAuth signing key ids must be unique");
    }
    const key: SigningKey = { kid, active: isActive, alg: "ES256" };
    keys.set(kid, key);
    materials.set(kid, importPrivateSigningKey(value.privateJwk, kid));
    if (isActive) {
      if (active) throw new Error("OAuth signing keys must have exactly one active key");
      active = key;
    }
  }

  const ring: SigningKeyRing = {
    active,
    keys,
    toJSON() {
      return { active, keys: [...keys.values()] };
    },
  };
  signingMaterials.set(ring, materials);
  return ring;
}

function signingMaterial(ring: SigningKeyRing, kid: string): SigningKeyMaterial {
  const material = signingMaterials.get(ring)?.get(kid);
  if (!material) throw new Error("Unknown OAuth signing key");
  return material;
}

export function signingPrivateKey(ring: SigningKeyRing, kid: string): KeyObject {
  return signingMaterial(ring, kid).privateKey;
}

export function signingPublicKey(ring: SigningKeyRing, kid: string): KeyObject {
  return signingMaterial(ring, kid).publicKey;
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
