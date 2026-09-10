import { loadFacadeAuthConfig } from "../../../src/auth/config";
import {
  AuthorizationRequestError,
  type OAuthAuthorizationFailureReason,
  validateAuthorizationRequest,
} from "../../../src/oauth/authorization-request";
import { resolveClient } from "../../../src/oauth/client-metadata";
import { CimdUnavailableError } from "../../../src/oauth/cimd-errors";
import {
  OAuthCookieTooLargeError,
  createUpstreamStateCookie,
} from "../../../src/oauth/cookies";
import {
  createOAuthPersistence,
  OAuthPersistenceUnavailableError,
} from "../../../src/oauth/persistence";
import { noStoreHeaders, oauthError, oauthJson } from "../../../src/oauth/responses";
import {
  createUpstreamSupabaseAuth,
  UpstreamSupabaseAuthError,
} from "../../../src/oauth/upstream-supabase";
import {
  createOAuthAuditContext,
  emitOAuthAudit,
  type OAuthResultClass,
} from "../../../src/observability/oauth-audit";
import { checkOAuthRateLimit } from "../../../src/security/oauth-rate-limit";

function redirectError(
  redirectUri: string,
  error: "invalid_request" | "invalid_client" | "invalid_scope" | "temporarily_unavailable",
  state?: string,
): Response {
  const location = new URL(redirectUri);
  location.searchParams.set("error", error);
  if (state) location.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: noStoreHeaders({ Location: location.href }),
  });
}

export async function GET(request: Request): Promise<Response> {
  const audit = createOAuthAuditContext("authorize");
  const respond = (
    response: Response,
    resultClass: OAuthResultClass,
    clientId?: string,
    authorizationFailure?: OAuthAuthorizationFailureReason,
  ): Response => {
    emitOAuthAudit(audit, { resultClass, clientId, authorizationFailure });
    return response;
  };
  let config;
  try {
    config = loadFacadeAuthConfig(process.env);
  } catch {
    return respond(
      oauthError("server_error", 500, {}, audit.correlationId),
      "server_error",
    );
  }
  if (!config.oauthEnabled) {
    return respond(oauthError("temporarily_unavailable", 503), "dependency_error");
  }

  const rateLimit = await checkOAuthRateLimit({ route: "authorize", request });
  if (!rateLimit.allowed) {
    return respond(oauthError("temporarily_unavailable", 429, {
      "Retry-After": String(rateLimit.retryAfterSeconds),
    }), "rate_limited");
  }

  let authorization;
  try {
    const persistence = createOAuthPersistence(config);
    authorization = await validateAuthorizationRequest(new URL(request.url).searchParams, {
      resource: config.resourceUrl.href,
      resolveClient: (clientId) => resolveClient(clientId, persistence),
    });
  } catch (error) {
    if (error instanceof AuthorizationRequestError) {
      return respond(error.redirectUri
        ? redirectError(error.redirectUri, error.error, error.state)
        : oauthJson({ error: error.error }, 400), "client_error", undefined, error.reason);
    }
    if (error instanceof OAuthPersistenceUnavailableError ||
        error instanceof CimdUnavailableError) {
      return respond(
        oauthError("temporarily_unavailable", 503),
        "dependency_error",
      );
    }
    return respond(
      oauthError("server_error", 500, {}, audit.correlationId),
      "server_error",
    );
  }

  try {
    const callback = `${config.issuerUrl.origin}/oauth/callback/supabase`;
    const login = await createUpstreamSupabaseAuth(config).begin(callback);
    const cookie = await createUpstreamStateCookie({
      request: authorization,
      supabaseCodeVerifier: login.codeVerifier,
    }, config.encryptionKeys);
    return respond(new Response(null, {
      status: 302,
      headers: noStoreHeaders({
        Location: login.providerUrl,
        "Set-Cookie": cookie,
      }),
    }), "success", authorization.client.clientId);
  } catch (error) {
    if (error instanceof OAuthCookieTooLargeError) {
      return respond(
        oauthJson({ error: "invalid_request" }, 400),
        "client_error",
        authorization.client.clientId,
      );
    }
    if (error instanceof UpstreamSupabaseAuthError) {
      return respond(redirectError(
        authorization.redirectUri,
        "temporarily_unavailable",
        authorization.state,
      ), "dependency_error", authorization.client.clientId);
    }
    return respond(
      oauthError("server_error", 500, {}, audit.correlationId),
      "server_error",
      authorization.client.clientId,
    );
  }
}
