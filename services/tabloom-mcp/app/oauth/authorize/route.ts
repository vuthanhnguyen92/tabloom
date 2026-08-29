import { loadFacadeAuthConfig } from "../../../src/auth/config";
import {
  AuthorizationRequestError,
  validateAuthorizationRequest,
} from "../../../src/oauth/authorization-request";
import { resolveClient } from "../../../src/oauth/client-metadata";
import {
  OAuthCookieTooLargeError,
  createUpstreamStateCookie,
} from "../../../src/oauth/cookies";
import { createOAuthPersistence } from "../../../src/oauth/persistence";
import { noStoreHeaders, oauthError, oauthJson } from "../../../src/oauth/responses";
import { createUpstreamSupabaseAuth } from "../../../src/oauth/upstream-supabase";

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
  let config;
  try {
    config = loadFacadeAuthConfig(process.env);
  } catch {
    return oauthError("server_error", 500);
  }
  if (!config.oauthEnabled) return oauthError("temporarily_unavailable", 503);

  let authorization;
  try {
    const persistence = createOAuthPersistence(config);
    authorization = await validateAuthorizationRequest(new URL(request.url).searchParams, {
      resource: config.resourceUrl.origin,
      resolveClient: (clientId) => resolveClient(clientId, persistence),
    });
  } catch (error) {
    if (error instanceof AuthorizationRequestError) {
      return error.redirectUri
        ? redirectError(error.redirectUri, error.error, error.state)
        : oauthJson({ error: error.error }, 400);
    }
    return oauthError("server_error", 500);
  }

  try {
    const callback = `${config.issuerUrl.origin}/oauth/callback/supabase`;
    const login = await createUpstreamSupabaseAuth(config).begin(callback);
    const cookie = await createUpstreamStateCookie({
      request: authorization,
      supabaseCodeVerifier: login.codeVerifier,
    }, config.encryptionKeys);
    return new Response(null, {
      status: 302,
      headers: noStoreHeaders({
        Location: login.providerUrl,
        "Set-Cookie": cookie,
      }),
    });
  } catch (error) {
    if (error instanceof OAuthCookieTooLargeError) {
      return oauthJson({ error: "invalid_request" }, 400);
    }
    return redirectError(
      authorization.redirectUri,
      "temporarily_unavailable",
      authorization.state,
    );
  }
}
