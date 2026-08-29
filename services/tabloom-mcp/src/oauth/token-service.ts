import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { openArtifact, sealArtifact } from "../auth/artifacts";
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

export type RefreshTokenRequest = {
  grantType: "refresh_token";
  refreshToken: string;
  clientId: string;
  resource: string;
  scope: string;
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
const OPAQUE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REFRESH_PAYLOAD_KEYS = [
  "clientId",
  "expiresAt",
  "grantId",
  "issuedAt",
  "jti",
  "resource",
  "scope",
  "supabaseRefreshToken",
  "userId",
];

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

function isRefreshTokenPayload(value: unknown, now: number): value is RefreshTokenPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  return (
    keys.length === REFRESH_PAYLOAD_KEYS.length &&
    keys.every((key, index) => key === REFRESH_PAYLOAD_KEYS[index]) &&
    typeof payload.supabaseRefreshToken === "string" &&
    payload.supabaseRefreshToken.length > 0 &&
    typeof payload.userId === "string" &&
    UUID_PATTERN.test(payload.userId) &&
    typeof payload.clientId === "string" &&
    payload.clientId.length > 0 &&
    typeof payload.resource === "string" &&
    payload.scope === "tabloom:workspace" &&
    typeof payload.grantId === "string" &&
    OPAQUE_IDENTIFIER_PATTERN.test(payload.grantId) &&
    typeof payload.jti === "string" &&
    OPAQUE_IDENTIFIER_PATTERN.test(payload.jti) &&
    Number.isSafeInteger(payload.issuedAt) &&
    Number.isSafeInteger(payload.expiresAt) &&
    (payload.issuedAt as number) <= now &&
    (payload.expiresAt as number) > now &&
    (payload.expiresAt as number) - (payload.issuedAt as number) <= REFRESH_TOKEN_LIFETIME_SECONDS
  );
}

export async function openRefreshToken(
  token: string,
  config: FacadeAuthConfig,
  now = Math.floor(Date.now() / 1000),
): Promise<RefreshTokenPayload> {
  const payload = await openArtifact<unknown>(
    "refresh_token",
    token,
    config.encryptionKeys,
    now,
  );
  if (!isRefreshTokenPayload(payload, now)) throw new Error("Invalid refresh token");
  return payload;
}

type RefreshedSupabaseSession = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
};

async function refreshSupabaseSession(
  refreshToken: string,
  expectedUserId: string,
  config: FacadeAuthConfig,
  now: number,
): Promise<RefreshedSupabaseSession> {
  let result: Awaited<ReturnType<ReturnType<typeof createClient>["auth"]["refreshSession"]>>;
  try {
    const client = createClient(config.supabaseUrl.href, config.anonKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
    result = await client.auth.refreshSession({ refresh_token: refreshToken });
  } catch {
    throw new TokenServiceError("temporarily_unavailable");
  }

  const userId = result.data.user?.id;
  const session = result.data.session;
  if (
    result.error ||
    typeof userId !== "string" ||
    !UUID_PATTERN.test(userId) ||
    userId !== expectedUserId ||
    typeof session?.access_token !== "string" ||
    session.access_token.length === 0 ||
    typeof session.refresh_token !== "string" ||
    session.refresh_token.length === 0 ||
    !Number.isSafeInteger(session.expires_at) ||
    session.expires_at! <= now
  ) {
    throw invalidGrant();
  }

  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    accessTokenExpiresAt: session.expires_at!,
  };
}

async function issueTokenPair(
  input: {
    userId: string;
    clientId: string;
    resource: string;
    scope: "tabloom:workspace";
    grantId: string;
    supabaseAccessToken: string;
    supabaseRefreshToken: string;
    supabaseAccessTokenExpiresAt: number;
  },
  config: FacadeAuthConfig,
  now: number,
): Promise<OAuthTokenResponse> {
  const expiresIn = Math.min(10 * 60, input.supabaseAccessTokenExpiresAt - now);
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0) throw invalidGrant();

  const [accessToken, refreshToken] = await Promise.all([
    issueAccessToken({
      sub: input.userId,
      clientId: input.clientId,
      grantId: input.grantId,
      supabaseToken: input.supabaseAccessToken,
      innerExpiresAt: input.supabaseAccessTokenExpiresAt,
    }, config, now),
    issueRefreshToken({
      supabaseRefreshToken: input.supabaseRefreshToken,
      userId: input.userId,
      clientId: input.clientId,
      resource: input.resource,
      scope: input.scope,
      grantId: input.grantId,
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

  return issueTokenPair({
    userId: code.userId,
    clientId: code.clientId,
    resource: code.resource,
    scope: code.scope,
    grantId: code.grantId,
    supabaseAccessToken: code.supabaseAccessToken,
    supabaseRefreshToken: code.supabaseRefreshToken,
    supabaseAccessTokenExpiresAt: code.supabaseAccessTokenExpiresAt,
  }, config, now);
}

export async function exchangeRefreshToken(
  request: RefreshTokenRequest,
  config: FacadeAuthConfig,
  persistence: OAuthPersistence,
  now = Math.floor(Date.now() / 1000),
): Promise<OAuthTokenResponse> {
  let refresh: RefreshTokenPayload;
  try {
    refresh = await openRefreshToken(request.refreshToken, config, now);
  } catch {
    throw invalidGrant();
  }

  if (
    request.grantType !== "refresh_token" ||
    request.clientId !== refresh.clientId ||
    request.resource !== refresh.resource ||
    request.resource !== config.resourceUrl.origin ||
    request.scope !== refresh.scope
  ) {
    throw invalidGrant();
  }

  if (await persistence.isGrantRevoked(refresh.grantId)) throw invalidGrant();
  const consumed = await persistence.consume(
    "refresh_token",
    refresh.jti,
    new Date(refresh.expiresAt * 1000),
  );
  if (!consumed) throw invalidGrant();

  const rotated = await refreshSupabaseSession(
    refresh.supabaseRefreshToken,
    refresh.userId,
    config,
    now,
  );
  if (await persistence.isGrantRevoked(refresh.grantId)) throw invalidGrant();

  return issueTokenPair({
    userId: refresh.userId,
    clientId: refresh.clientId,
    resource: refresh.resource,
    scope: refresh.scope,
    grantId: refresh.grantId,
    supabaseAccessToken: rotated.accessToken,
    supabaseRefreshToken: rotated.refreshToken,
    supabaseAccessTokenExpiresAt: rotated.accessTokenExpiresAt,
  }, config, now);
}
