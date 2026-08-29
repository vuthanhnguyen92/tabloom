import { createHmac } from "node:crypto";

export type OAuthDatabaseProofKey = Readonly<{
  configured: true;
  toJSON(): { configured: true };
}>;

export type OAuthMutationProof = Readonly<{
  proof_timestamp: number;
  proof_nonce: string;
  proof_signature: string;
}>;

const proofKeyMaterial = new WeakMap<OAuthDatabaseProofKey, Uint8Array>();

function decodeSecret(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("OAuth database proof secret must be base64url");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("OAuth database proof secret must be exactly 32 bytes");
  }
  return Uint8Array.from(decoded);
}

export function createOAuthDatabaseProofKey(value: unknown): OAuthDatabaseProofKey {
  const material = decodeSecret(value);
  const key: OAuthDatabaseProofKey = Object.freeze({
    configured: true,
    toJSON() {
      return { configured: true };
    },
  });
  proofKeyMaterial.set(key, material);
  return key;
}

export function signOAuthMutationProof(
  key: OAuthDatabaseProofKey,
  action: string,
  canonicalPayload: string,
  timestamp: number,
  nonce: string,
): OAuthMutationProof {
  const material = proofKeyMaterial.get(key);
  if (!material) throw new Error("OAuth database proof key is unavailable");
  if (!/^[a-z_]{1,64}$/.test(action) ||
      !Number.isSafeInteger(timestamp) || timestamp < 0 ||
      !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
    throw new Error("OAuth database mutation proof input is invalid");
  }
  const envelope = [
    "tabloom-oauth-rpc-v1",
    action,
    canonicalPayload,
    String(timestamp),
    nonce,
  ].join("\n");
  const proof = createHmac("sha256", material)
    .update(envelope, "utf8")
    .digest("base64url");
  return Object.freeze({
    proof_timestamp: timestamp,
    proof_nonce: nonce,
    proof_signature: proof,
  });
}
