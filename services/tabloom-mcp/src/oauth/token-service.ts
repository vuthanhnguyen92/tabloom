import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { sealArtifact } from "../auth/artifacts";
import type { FacadeAuthConfig } from "../auth/config";
import { issueAccessToken } from "../auth/access-token";
import { verifyS256 } from "./authorization-request";
import { openAuthorizationCode } from "./consent";
import type { OAuthPersistence } from "./persistence";

export const REFRESH_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export type OAuthTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: "tabloom:workspace";
};

export type AuthorizationCodeTokenRequest = {
  grantType: "authorization_code";
  code: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeVerifier: string;
};

export type RefreshTokenPayload = {
  supabaseRefreshToken: string;
  userId: string;
  clientId: string;
  resource: string;
  scope: "tabloom:workspace";
  grantId: string;
  jti: string;
  issuedAt: number;
  expiresAt: number;
};

export type TokenServiceErrorCode = "invalid_grant" | "temporarily_unavailable";

export class TokenServiceError extends Error {
  constructor(readonly error: TokenServiceErrorCode) {
    super(error);
    this.name = "TokenServiceError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidGrant(): TokenServiceError {
  return new TokenServiceError("invalid_grant");
}

function randomIdentifier(): string {
  return randomBytes(32).toString("base64url");
}

async function revalidateSupabaseUser(
  accessToken: string,
  expectedUserId: string,
  config: FacadeAuthConfig,
): Promise<void> {
  let result: Awaited<ReturnType<ReturnType<typeof createClient>["auth"]["getUser"]>>;
  try {
    const client = createClient(config.supabaseUrl.href, config.anonKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
    result = await client.auth.getUser(accessToken);
  } catch {
    throw new TokenServiceError("temporarily_unavailable");
  }

  const userId = result.data.user?.id;
  if (result.error || typeof userId !== "string" ||
      !UUID_PATTERN.test(userId) || userId !== expectedUserId) {
    throw invalidGrant();
  }
}

async function issueRefreshToken(
  payload: Omit<RefreshTokenPayload, "jti" | "issuedAt" | "expiresAt">,
  config: FacadeAuthConfig,
  now: number,
): Promise<string> {
  const refresh: RefreshTokenPayload = {
    ...payload,
    jti: randomIdentifier(),
    issuedAt: now,
    expiresAt: now + REFRESH_TOKEN_LIFETIME_SECONDS,
  };
  return sealArtifact(
    "refresh_token",
    refresh,
    REFRESH_TOKEN_LIFETIME_SECONDS,
    config.encryptionKeys,
    now,
  );
}

export async function exchangeAuthorizationCode(
  request: AuthorizationCodeTokenRequest,
  config: FacadeAuthConfig,
  persistence: OAuthPersistence,
  now = Math.floor(Date.now() / 1000),
): Promise<OAuthTokenResponse> {
  let code;
  try {
    code = await openAuthorizationCode(request.code, config.encryptionKeys, now);
  } catch {
    throw invalidGrant();
  }

  if (
    request.grantType !== "authorization_code" ||
    code.clientId !== request.clientId ||
    code.redirectUri !== request.redirectUri ||
    code.resource !== request.resource ||
    code.resource !== config.resourceUrl.origin ||
    !verifyS256(request.codeVerifier, code.codeChallenge)
  ) {
    throw invalidGrant();
  }

  if (await persistence.isGrantRevoked(code.grantId)) throw invalidGrant();
  const consumed = await persistence.consume(
    "authorization_code",
    code.jti,
    new Date(code.expiresAt * 1000),
  );
  if (!consumed) throw invalidGrant();

  await revalidateSupabaseUser(code.supabaseAccessToken, code.userId, config);

  const expiresIn = Math.min(10 * 60, code.supabaseAccessTokenExpiresAt - now);
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0) throw invalidGrant();

  const [accessToken, refreshToken] = await Promise.all([
    issueAccessToken({
      sub: code.userId,
      clientId: code.clientId,
      grantId: code.grantId,
      supabaseToken: code.supabaseAccessToken,
      innerExpiresAt: code.supabaseAccessTokenExpiresAt,
    }, config, now),
    issueRefreshToken({
      supabaseRefreshToken: code.supabaseRefreshToken,
      userId: code.userId,
      clientId: code.clientId,
      resource: code.resource,
      scope: code.scope,
      grantId: code.grantId,
    }, config, now),
  ]);

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    refresh_token: refreshToken,
    scope: "tabloom:workspace",
  };
}
