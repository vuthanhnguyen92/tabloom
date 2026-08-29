import { randomBytes } from "node:crypto";
import { EncryptJWT, SignJWT, jwtDecrypt, jwtVerify } from "jose";
import type { FacadeAuthConfig } from "./config";
import {
  signingPrivateKey,
  signingPublicKey,
} from "./key-rings";

export type TabloomAccessClaims = {
  sub: string;
  client_id: string;
  scope: "tabloom:workspace";
  grant_id: string;
  supabase_token: string;
};

export type AccessTokenInput = {
  sub: string;
  clientId: string;
  grantId: string;
  supabaseToken: string;
  innerExpiresAt: number;
};

const MAX_BEARER_TOKEN_BYTES = 32 * 1024;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 10 * 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DCR_CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ACCESS_TOKEN_HEADER_KEYS = ["alg", "kid", "typ"];
const ACCESS_TOKEN_CLAIM_KEYS = [
  "aud",
  "client_id",
  "exp",
  "grant_id",
  "iat",
  "iss",
  "jti",
  "nbf",
  "scope",
  "sub",
  "supabase_token",
];
const INNER_TOKEN_HEADER_KEYS = ["alg", "enc", "kid", "typ"];
const INNER_TOKEN_CLAIM_KEYS = ["exp", "iat", "nbf", "token"];

function issuer(config: FacadeAuthConfig): string {
  return config.issuerUrl.origin;
}

function randomJti(): string {
  return randomBytes(32).toString("base64url");
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function isCanonicalPublicClientId(clientId: string): boolean {
  if (DCR_CLIENT_ID_PATTERN.test(clientId)) return true;
  if (clientId.trim() !== clientId || clientId.includes("#") || clientId.includes("*")) {
    return false;
  }
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && !url.username && !url.password &&
      Boolean(url.hostname) && url.href === clientId;
  } catch {
    return false;
  }
}

export async function issueAccessToken(
  input: AccessTokenInput,
  config: FacadeAuthConfig,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const signingKey = config.signingKeys.active;
  const encryptionKey = config.encryptionKeys.active;
  const exp = Math.min(now + MAX_ACCESS_TOKEN_LIFETIME_SECONDS, input.innerExpiresAt);
  if (!signingKey || !encryptionKey || !Number.isSafeInteger(exp) || exp <= now) {
    throw new Error("OAuth facade keys or token lifetime are invalid");
  }
  const supabaseToken = await new EncryptJWT({ token: input.supabaseToken })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: encryptionKey.kid, typ: "tabloom+inner_access_token" })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(input.innerExpiresAt)
    .encrypt(encryptionKey.derived("inner_access_token"));

  return new SignJWT({
    sub: input.sub,
    client_id: input.clientId,
    scope: "tabloom:workspace",
    grant_id: input.grantId,
    supabase_token: supabaseToken,
  })
    .setProtectedHeader({ alg: "ES256", kid: signingKey.kid, typ: "at+jwt" })
    .setIssuer(issuer(config))
    .setAudience(config.resourceUrl.origin)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(exp)
    .setJti(randomJti())
    .sign(signingPrivateKey(config.signingKeys, signingKey.kid));
}

export async function verifyAccessToken(
  token: string,
  config: FacadeAuthConfig,
  now = Math.floor(Date.now() / 1000),
) {
  if (Buffer.byteLength(token, "utf8") > MAX_BEARER_TOKEN_BYTES) {
    throw new Error("Bearer token exceeds maximum size");
  }
  const result = await jwtVerify(
    token,
    async (header) => {
      if (header.alg !== "ES256" || header.typ !== "at+jwt" || typeof header.kid !== "string") {
        throw new Error("Invalid access token header");
      }
      const key = config.signingKeys.keys.get(header.kid);
      if (!key) throw new Error("Unknown access token signing key");
      return signingPublicKey(config.signingKeys, key.kid);
    },
    {
      algorithms: ["ES256"],
      issuer: issuer(config),
      audience: config.resourceUrl.origin,
      currentDate: new Date(now * 1000),
    },
  );
  const { payload } = result;
  if (
    payload.aud !== config.resourceUrl.origin ||
    typeof payload.sub !== "string" ||
    typeof payload.client_id !== "string" ||
    payload.scope !== "tabloom:workspace" ||
    typeof payload.grant_id !== "string" ||
    typeof payload.supabase_token !== "string" ||
    typeof payload.jti !== "string" ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.nbf) ||
    !Number.isSafeInteger(payload.exp)
  ) throw new Error("Invalid access token claims");
  return result as typeof result & { payload: typeof payload & TabloomAccessClaims };
}

export async function verifyRevocableAccessToken(
  token: string,
  config: FacadeAuthConfig,
  now = Math.floor(Date.now() / 1000),
) {
  const result = await verifyAccessToken(token, config, now);
  const { payload, protectedHeader } = result;
  if (
    !hasExactKeys(protectedHeader, ACCESS_TOKEN_HEADER_KEYS) ||
    !hasExactKeys(payload, ACCESS_TOKEN_CLAIM_KEYS) ||
    !UUID_PATTERN.test(payload.sub) ||
    !isCanonicalPublicClientId(payload.client_id) ||
    !OPAQUE_IDENTIFIER_PATTERN.test(payload.grant_id) ||
    typeof payload.jti !== "string" ||
    !OPAQUE_IDENTIFIER_PATTERN.test(payload.jti) ||
    typeof payload.iat !== "number" ||
    typeof payload.nbf !== "number" ||
    typeof payload.exp !== "number" ||
    payload.iat !== payload.nbf ||
    payload.iat > now ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_ACCESS_TOKEN_LIFETIME_SECONDS ||
    payload.supabase_token.length === 0
  ) {
    throw new Error("Invalid revocable access token");
  }

  const inner = await jwtDecrypt(
    payload.supabase_token,
    async (header) => {
      if (
        !hasExactKeys(header, INNER_TOKEN_HEADER_KEYS) ||
        header.alg !== "dir" ||
        header.enc !== "A256GCM" ||
        header.typ !== "tabloom+inner_access_token" ||
        typeof header.kid !== "string"
      ) {
        throw new Error("Invalid inner access credential header");
      }
      const key = config.encryptionKeys.keys.get(header.kid);
      if (!key) throw new Error("Unknown inner access credential key");
      return key.derived("inner_access_token");
    },
    { currentDate: new Date(now * 1000) },
  );
  if (
    !hasExactKeys(inner.payload, INNER_TOKEN_CLAIM_KEYS) ||
    typeof inner.payload.token !== "string" ||
    inner.payload.token.length === 0 ||
    !Number.isSafeInteger(inner.payload.iat) ||
    !Number.isSafeInteger(inner.payload.nbf) ||
    !Number.isSafeInteger(inner.payload.exp) ||
    inner.payload.iat !== payload.iat ||
    inner.payload.nbf !== payload.nbf ||
    inner.payload.exp! < payload.exp
  ) {
    throw new Error("Invalid inner access credential claims");
  }
  return result;
}
