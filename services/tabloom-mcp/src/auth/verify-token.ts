import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { McpAuthConfig } from "./config";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CLAIM_NAMES = [
  "iss",
  "aud",
  "sub",
  "client_id",
  "scope",
  "iat",
  "exp",
] as const;

function safeClaims(payload: JWTPayload): Record<string, unknown> {
  return Object.fromEntries(
    SAFE_CLAIM_NAMES.flatMap((name) =>
      payload[name] === undefined ? [] : [[name, payload[name]]],
    ),
  );
}

export function createTokenVerifier(
  config: McpAuthConfig,
  jwks: JWTVerifyGetKey = createRemoteJWKSet(config.jwksUrl),
) {
  const resource = new URL(config.resourceUrl.origin);

  return async function verifyToken(
    _request: Request,
    bearerToken?: string,
  ): Promise<AuthInfo | undefined> {
    if (!bearerToken) {
      return undefined;
    }

    try {
      const { payload } = await jwtVerify(bearerToken, jwks, {
        algorithms: ["ES256"],
        issuer: config.issuer,
        audience: resource.href.replace(/\/$/, ""),
      });

      if (
        typeof payload.sub !== "string" ||
        !UUID.test(payload.sub) ||
        typeof payload.client_id !== "string" ||
        !payload.client_id.trim() ||
        payload.client_id !== payload.client_id.trim() ||
        typeof payload.exp !== "number" ||
        !Number.isFinite(payload.exp) ||
        payload.exp <= Math.floor(Date.now() / 1000)
      ) {
        return undefined;
      }

      return {
        token: bearerToken,
        clientId: payload.client_id,
        scopes:
          typeof payload.scope === "string"
            ? payload.scope.split(/\s+/).filter(Boolean)
            : [],
        expiresAt: payload.exp,
        resource,
        extra: {
          userId: payload.sub,
          claims: safeClaims(payload),
        },
      };
    } catch {
      return undefined;
    }
  };
}
