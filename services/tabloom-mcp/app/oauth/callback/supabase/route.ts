import { randomBytes } from "node:crypto";

import { loadFacadeAuthConfig } from "../../../../src/auth/config";
import {
  MAX_OAUTH_COOKIE_AGE_SECONDS,
  clearUpstreamStateCookie,
  createConsentCookie,
  readUpstreamLoginState,
  type UpstreamLoginState,
} from "../../../../src/oauth/cookies";
import { noStoreHeaders, oauthError, oauthJson } from "../../../../src/oauth/responses";
import { createUpstreamSupabaseAuth } from "../../../../src/oauth/upstream-supabase";

type CallbackError = "access_denied" | "invalid_request" | "temporarily_unavailable";

function clientError(state: UpstreamLoginState, error: CallbackError): Response {
  const location = new URL(state.request.redirectUri);
  location.searchParams.set("error", error);
  location.searchParams.set("state", state.request.state);
  return new Response(null, {
    status: 302,
    headers: noStoreHeaders({
      Location: location.href,
      "Set-Cookie": clearUpstreamStateCookie(),
    }),
  });
}

export async function GET(request: Request): Promise<Response> {
  let config;
  try {
    config = loadFacadeAuthConfig(process.env);
  } catch {
    return oauthError("server_error", 500);
  }
  if (!config.oauthEnabled) return oauthError("temporarily_unavailable", 503);

  let state: UpstreamLoginState;
  try {
    state = await readUpstreamLoginState(request, config.encryptionKeys);
    if (state.request.resource !== config.resourceUrl.origin) throw new Error();
  } catch {
    return oauthJson({ error: "invalid_request" }, 400);
  }

  const params = new URL(request.url).searchParams;
  if (params.has("error")) return clientError(state, "access_denied");
  const codes = params.getAll("code");
  if (codes.length !== 1 || !codes[0]) return clientError(state, "invalid_request");

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
    }, config.encryptionKeys, lifetimeSeconds, now);

    const headers = noStoreHeaders({
      Location: `${config.issuerUrl.origin}/oauth/consent`,
    });
    headers.append("Set-Cookie", clearUpstreamStateCookie());
    headers.append("Set-Cookie", consentCookie);
    return new Response(null, { status: 302, headers });
  } catch {
    return clientError(state, "temporarily_unavailable");
  }
}
