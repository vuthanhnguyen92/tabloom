import { loadFacadeAuthConfig } from "../../../src/auth/config";
import { validateDcrClientMetadata } from "../../../src/oauth/client-metadata";
import {
  OAuthInvalidClientMetadataError,
  OAuthPersistenceUnavailableError,
  OAuthRegistrationCapacityError,
  createOAuthPersistence,
} from "../../../src/oauth/persistence";
import {
  OAuthRequestError,
  noStoreHeaders,
  oauthError,
  oauthJson,
  readJsonPostBody,
} from "../../../src/oauth/responses";
import {
  createOAuthAuditContext,
  emitOAuthAudit,
  type OAuthResultClass,
} from "../../../src/observability/oauth-audit";
import { checkOAuthRateLimit } from "../../../src/security/oauth-rate-limit";

const REGISTRATION_CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };
const UNSUPPORTED_METHOD_HEADERS = {
  ...REGISTRATION_CORS_HEADERS,
  Allow: "POST, OPTIONS",
};

function rejectUnsupportedMethod(): Response {
  return oauthError("invalid_request", 405, UNSUPPORTED_METHOD_HEADERS);
}

export const GET = rejectUnsupportedMethod;
export const HEAD = rejectUnsupportedMethod;
export const PUT = rejectUnsupportedMethod;
export const PATCH = rejectUnsupportedMethod;
export const DELETE = rejectUnsupportedMethod;

export async function POST(request: Request): Promise<Response> {
  const audit = createOAuthAuditContext("register");
  const respond = (
    response: Response,
    resultClass: OAuthResultClass,
    clientId?: string,
  ): Response => {
    emitOAuthAudit(audit, { resultClass, clientId });
    return response;
  };
  let config;
  try {
    config = loadFacadeAuthConfig(process.env);
  } catch {
    return respond(
      oauthError("server_error", 500, REGISTRATION_CORS_HEADERS, audit.correlationId),
      "server_error",
    );
  }
  if (!config.oauthEnabled) {
    return respond(
      oauthError("temporarily_unavailable", 503, REGISTRATION_CORS_HEADERS),
      "dependency_error",
    );
  }

  const rateLimit = await checkOAuthRateLimit({ route: "register", request });
  if (!rateLimit.allowed) {
    return respond(oauthError("temporarily_unavailable", 429, {
      ...REGISTRATION_CORS_HEADERS,
      "Retry-After": String(rateLimit.retryAfterSeconds),
    }), "rate_limited");
  }

  let payload: unknown;
  try {
    payload = await readJsonPostBody(request);
  } catch (error) {
    if (error instanceof OAuthRequestError) {
      return respond(oauthError(
        "invalid_request",
        error.status,
        error.status === 405
          ? UNSUPPORTED_METHOD_HEADERS
          : REGISTRATION_CORS_HEADERS,
      ), "client_error");
    }
    return respond(
      oauthError("server_error", 500, REGISTRATION_CORS_HEADERS, audit.correlationId),
      "server_error",
    );
  }

  let registration;
  try {
    registration = validateDcrClientMetadata(payload);
  } catch {
    return respond(
      oauthError("invalid_client_metadata", 400, REGISTRATION_CORS_HEADERS),
      "client_error",
    );
  }

  try {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const stored = await createOAuthPersistence(config).registerClient({
      clientName: registration.clientName,
      redirectUris: [...registration.redirectUris],
      expiresAt,
    });
    return respond(oauthJson({
      client_id: stored.clientId,
      client_name: registration.clientName,
      redirect_uris: registration.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201, REGISTRATION_CORS_HEADERS), "success", stored.clientId);
  } catch (error) {
    if (error instanceof OAuthInvalidClientMetadataError) {
      return respond(
        oauthError("invalid_client_metadata", 400, REGISTRATION_CORS_HEADERS),
        "client_error",
      );
    }
    if (error instanceof OAuthRegistrationCapacityError) {
      return respond(
        oauthError("temporarily_unavailable", 429, {
          ...REGISTRATION_CORS_HEADERS,
          "Retry-After": String(error.retryAfterSeconds),
        }),
        "rate_limited",
      );
    }
    if (error instanceof OAuthPersistenceUnavailableError) {
      return respond(
        oauthError("temporarily_unavailable", 503, REGISTRATION_CORS_HEADERS),
        "dependency_error",
      );
    }
    return respond(
      oauthError("server_error", 500, REGISTRATION_CORS_HEADERS, audit.correlationId),
      "server_error",
    );
  }
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: noStoreHeaders({
      ...REGISTRATION_CORS_HEADERS,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }),
  });
}
