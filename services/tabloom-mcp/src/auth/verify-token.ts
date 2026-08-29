import type { AuthInfo } from "@modelcontextprotocol/server";
import { jwtDecrypt } from "jose";

import { isValidCimdClientId } from "../oauth/client-metadata";
import {
  createOAuthPersistence,
  type OAuthPersistence,
} from "../oauth/persistence";
import { verifyAccessToken } from "./access-token";
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

const MAX_BEARER_TOKEN_BYTES = 32 * 1024;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 10 * 60;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function isValidPublicClientId(clientId: string): boolean {
  return UUID_PATTERN.test(clientId) || isValidCimdClientId(clientId);
}

function hasStrictOuterClaims(
  result: Awaited<ReturnType<typeof verifyAccessToken>>,
  now: number,
): boolean {
  const { payload, protectedHeader } = result;
  return (
    hasExactKeys(protectedHeader, ACCESS_TOKEN_HEADER_KEYS) &&
    hasExactKeys(payload, ACCESS_TOKEN_CLAIM_KEYS) &&
    UUID_PATTERN.test(payload.sub) &&
    isValidPublicClientId(payload.client_id) &&
    OPAQUE_IDENTIFIER_PATTERN.test(payload.grant_id) &&
    typeof payload.jti === "string" &&
    OPAQUE_IDENTIFIER_PATTERN.test(payload.jti) &&
    typeof payload.iat === "number" &&
    typeof payload.nbf === "number" &&
    typeof payload.exp === "number" &&
    payload.iat === payload.nbf &&
    payload.iat <= now &&
    payload.exp > payload.iat &&
    payload.exp - payload.iat <= MAX_ACCESS_TOKEN_LIFETIME_SECONDS &&
    payload.supabase_token.length > 0
  );
}

async function openInnerAccessToken(
  compactJwe: string,
  outer: Awaited<ReturnType<typeof verifyAccessToken>>["payload"],
  config: FacadeAuthConfig,
  now: number,
): Promise<string> {
  const inner = await jwtDecrypt(
    compactJwe,
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
    inner.payload.iat !== outer.iat ||
    inner.payload.nbf !== outer.nbf ||
    inner.payload.exp! < outer.exp!
  ) {
    throw new Error("Invalid inner access credential claims");
  }

  return inner.payload.token;
}

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
      const verified = await verifyAccessToken(bearerToken, config, now);
      if (!hasStrictOuterClaims(verified, now)) return undefined;

      const { payload } = verified;
      if (await persistence.isGrantRevoked(payload.grant_id)) return undefined;

      const innerAccessToken = await openInnerAccessToken(
        payload.supabase_token,
        payload,
        config,
        now,
      );
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
