import { randomBytes } from "node:crypto";
import { EncryptJWT, SignJWT, jwtVerify } from "jose";
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

function issuer(config: FacadeAuthConfig): string {
  return config.issuerUrl.origin;
}

function randomJti(): string {
  return randomBytes(32).toString("base64url");
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
