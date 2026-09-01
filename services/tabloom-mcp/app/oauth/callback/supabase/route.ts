import { randomBytes } from "node:crypto";

import { loadFacadeAuthConfig } from "../../../../src/auth/config";
import {
  MAX_OAUTH_COOKIE_AGE_SECONDS,
  OAuthCookieTooLargeError,
  clearUpstreamStateCookie,
  createConsentCookie,
  readUpstreamLoginState,
  type UpstreamLoginState,
} from "../../../../src/oauth/cookies";
import { noStoreHeaders, oauthError } from "../../../../src/oauth/responses";
import {
  createUpstreamSupabaseAuth,
  UpstreamSupabaseAuthError,
} from "../../../../src/oauth/upstream-supabase";
import {
  createOAuthAuditContext,
  emitOAuthAudit,
  type OAuthResultClass,
} from "../../../../src/observability/oauth-audit";

type CallbackError = "access_denied" | "invalid_request" | "temporarily_unavailable";

function terminalError(
  error: "invalid_request" | "server_error" | "temporarily_unavailable",
  status: 400 | 500 | 503,
  correlationId?: string,
): Response {
  return oauthError(
    error,
    status,
    { "Set-Cookie": clearUpstreamStateCookie() },
    correlationId,
  );
}

function clientError(
  state: UpstreamLoginState,
  error: CallbackError | "server_error",
  correlationId?: string,
): Response {
  const location = new URL(state.request.redirectUri);
  location.searchParams.set("error", error);
  location.searchParams.set("state", state.request.state);
  if (correlationId) location.searchParams.set("correlation_id", correlationId);
  return new Response(null, {
    status: 302,
    headers: noStoreHeaders({
      Location: location.href,
      "Set-Cookie": clearUpstreamStateCookie(),
    }),
  });
}

export async function GET(request: Request): Promise<Response> {
  const audit = createOAuthAuditContext("callback");
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
      terminalError("server_error", 500, audit.correlationId),
      "server_error",
    );
  }
  if (!config.oauthEnabled) {
    return respond(terminalError("temporarily_unavailable", 503), "dependency_error");
  }

  let state: UpstreamLoginState;
  try {
    state = await readUpstreamLoginState(request, config.encryptionKeys);
    if (state.request.resource !== config.resourceUrl.href) throw new Error();
  } catch {
    return respond(terminalError("invalid_request", 400), "client_error");
  }
  const clientId = state.request.client.clientId;

  const params = new URL(request.url).searchParams;
  if (params.has("error")) {
    return respond(clientError(state, "access_denied"), "client_error", clientId);
  }
  const codes = params.getAll("code");
  if (codes.length !== 1 || !codes[0]) {
    return respond(clientError(state, "invalid_request"), "client_error", clientId);
  }

  try {
    const session = await createUpstreamSupabaseAuth(config).exchange(
      codes[0],
      state.supabaseCodeVerifier,
    );
    const now = Math.floor(Date.now() / 1000);
    const lifetimeSeconds = Math.min(
      MAX_OAUTH_COOKIE_AGE_SECONDS,
      session.accessTokenExpiresAt - now,
    );
    if (lifetimeSeconds <= 0) throw new Error();
    const consentCookie = await createConsentCookie({
      request: state.request,
      userId: session.userId,
      supabaseAccessToken: session.accessToken,
      supabaseRefreshToken: session.refreshToken,
      supabaseAccessTokenExpiresAt: session.accessTokenExpiresAt,
      csrfNonce: randomBytes(32).toString("base64url"),
      authorizationCodeJti: randomBytes(32).toString("base64url"),
      grantId: randomBytes(32).toString("base64url"),
    }, config.encryptionKeys, lifetimeSeconds, now);

    const headers = noStoreHeaders({
      Location: `${config.issuerUrl.origin}/oauth/consent`,
    });
    headers.append("Set-Cookie", clearUpstreamStateCookie());
    headers.append("Set-Cookie", consentCookie);
    return respond(new Response(null, { status: 302, headers }), "success", clientId);
  } catch (error) {
    if (error instanceof OAuthCookieTooLargeError) {
      return respond(terminalError("invalid_request", 400), "client_error", clientId);
    }
    if (error instanceof UpstreamSupabaseAuthError) {
      return error.kind === "unavailable"
        ? respond(
          clientError(state, "temporarily_unavailable"),
          "dependency_error",
          clientId,
        )
        : respond(clientError(state, "access_denied"), "client_error", clientId);
    }
    return respond(
      clientError(state, "server_error", audit.correlationId),
      "server_error",
      clientId,
    );
  }
}
