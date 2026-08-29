import { createHash } from "node:crypto";
import { CompactEncrypt, compactDecrypt } from "jose";
import type { EncryptionKeyRing } from "./key-rings";

export type OAuthArtifactPurpose =
  | "upstream_state"
  | "consent_session"
  | "authorization_code"
  | "inner_access_token"
  | "refresh_token";

const MAX_ARTIFACT_PAYLOAD_BYTES = 16 * 1024;
const MAX_COMPACT_ARTIFACT_BYTES = 32 * 1024;
const MAX_ARTIFACT_LIFETIMES: Record<OAuthArtifactPurpose, number> = {
  upstream_state: 10 * 60,
  consent_session: 10 * 60,
  authorization_code: 2 * 60,
  inner_access_token: 10 * 60,
  refresh_token: 30 * 24 * 60 * 60,
};

type ArtifactEnvelope = {
  payload: unknown;
  iat: number;
  nbf: number;
  exp: number;
};

function invalidArtifact(): Error {
  return new Error("Invalid encrypted artifact");
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export async function sealArtifact(
  purpose: OAuthArtifactPurpose,
  payload: unknown,
  lifetimeSeconds: number,
  keys: EncryptionKeyRing,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (
    !keys.active ||
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds <= 0 ||
    lifetimeSeconds > MAX_ARTIFACT_LIFETIMES[purpose]
  ) {
    throw invalidArtifact();
  }
  const envelope: ArtifactEnvelope = { payload, iat: now, nbf: now, exp: now + lifetimeSeconds };
  const plaintext = Uint8Array.from(Buffer.from(JSON.stringify(envelope), "utf8"));
  if (plaintext.byteLength > MAX_ARTIFACT_PAYLOAD_BYTES) throw invalidArtifact();

  return new CompactEncrypt(plaintext)
    .setProtectedHeader({
      alg: "dir",
      enc: "A256GCM",
      kid: keys.active.kid,
      typ: `tabloom+${purpose}`,
    })
    .encrypt(keys.active.derived(purpose));
}

export async function openArtifact<T>(
  purpose: OAuthArtifactPurpose,
  compactJwe: string,
  keys: EncryptionKeyRing,
  now = Math.floor(Date.now() / 1000),
): Promise<T> {
  try {
    if (Buffer.byteLength(compactJwe, "utf8") > MAX_COMPACT_ARTIFACT_BYTES) {
      throw invalidArtifact();
    }
    const headerSegment = compactJwe.split(".")[0];
    if (!headerSegment) throw invalidArtifact();
    const header = JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      header.alg !== "dir" ||
      header.enc !== "A256GCM" ||
      header.typ !== `tabloom+${purpose}` ||
      typeof header.kid !== "string"
    ) throw invalidArtifact();
    const key = keys.keys.get(header.kid);
    if (!key) throw invalidArtifact();
    const { plaintext } = await compactDecrypt(compactJwe, key.derived(purpose));
    if (plaintext.byteLength > MAX_ARTIFACT_PAYLOAD_BYTES) throw invalidArtifact();
    const envelope = JSON.parse(Buffer.from(plaintext).toString("utf8")) as ArtifactEnvelope;
    if (
      !validTimestamp(envelope.iat) ||
      !validTimestamp(envelope.nbf) ||
      !validTimestamp(envelope.exp) ||
      envelope.exp <= envelope.nbf ||
      now < envelope.nbf ||
      now >= envelope.exp
    ) throw invalidArtifact();
    return envelope.payload as T;
  } catch {
    throw invalidArtifact();
  }
}

export function hashOpaqueIdentifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
