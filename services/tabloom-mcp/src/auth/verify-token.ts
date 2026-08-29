import type { AuthInfo } from "@modelcontextprotocol/server";

import {
  createOAuthPersistence,
  type OAuthPersistence,
} from "../oauth/persistence";
import {
  MAX_BEARER_TOKEN_BYTES,
  openStrictInnerAccessToken,
  verifyStrictAccessTokenOuter,
} from "./access-token";
import type { FacadeAuthConfig } from "./config";
import {
  createTabloomRequestContext,
  type AuthenticatedContextInput,
  type TabloomRequestContext,
} from "./request-context";
import { createSupabaseTokenVerifier } from "./verify-supabase-token";

export type VerifiedFacadeAuthInfo = AuthInfo & {
  extra: {
    userId: string;
    clientId: string;
    requestContext: TabloomRequestContext;
  };
};

type VerifySupabaseToken = (innerAccessToken: string) => Promise<string | undefined>;
type CreateRequestContext = (
  input: AuthenticatedContextInput,
  config: FacadeAuthConfig,
) => TabloomRequestContext;

export type TokenVerifierDependencies = {
  persistence?: OAuthPersistence;
  verifySupabaseToken?: VerifySupabaseToken;
  createRequestContext?: CreateRequestContext;
  now?: () => number;
};

export function createTokenVerifier(
  config: FacadeAuthConfig,
  dependencies: TokenVerifierDependencies = {},
) {
  const persistence = dependencies.persistence ?? createOAuthPersistence(config);
  const verifySupabaseToken = dependencies.verifySupabaseToken ??
    createSupabaseTokenVerifier(config);
  const createRequestContext = dependencies.createRequestContext ??
    createTabloomRequestContext;
  const currentTime = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const resource = new URL(config.resourceUrl.origin);

  return async function verifyToken(
    _request: Request,
    bearerToken?: string,
  ): Promise<VerifiedFacadeAuthInfo | undefined> {
    if (
      !bearerToken ||
      Buffer.byteLength(bearerToken, "utf8") > MAX_BEARER_TOKEN_BYTES
    ) {
      return undefined;
    }

    try {
      const now = currentTime();
      const verified = await verifyStrictAccessTokenOuter(bearerToken, config, now);

      const { payload } = verified;
      if (await persistence.isGrantRevoked(payload.grant_id)) return undefined;

      const innerAccessToken = await openStrictInnerAccessToken(verified, config, now);
      const innerUserId = await verifySupabaseToken(innerAccessToken);
      if (innerUserId !== payload.sub) return undefined;

      const requestContext = createRequestContext({
        authenticatedUserId: payload.sub,
        authenticatedClientId: payload.client_id,
        innerAccessToken,
      }, config);

      return {
        token: bearerToken,
        clientId: payload.client_id,
        scopes: ["tabloom:workspace"],
        expiresAt: payload.exp,
        resource,
        extra: {
          userId: payload.sub,
          clientId: payload.client_id,
          requestContext,
        },
      };
    } catch {
      return undefined;
    }
  };
}
