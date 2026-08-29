import { loadFacadeAuthConfig } from "../../../src/auth/config";
import { validateDcrClientMetadata } from "../../../src/oauth/client-metadata";
import {
  OAuthPersistenceUnavailableError,
  createOAuthPersistence,
} from "../../../src/oauth/persistence";
import {
  OAuthRequestError,
  noStoreHeaders,
  oauthError,
  oauthJson,
  readJsonPostBody,
} from "../../../src/oauth/responses";

const REGISTRATION_CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = loadFacadeAuthConfig(process.env);
  } catch {
    return oauthError("server_error", 500, REGISTRATION_CORS_HEADERS);
  }
  if (!config.oauthEnabled) {
    return oauthError("temporarily_unavailable", 503, REGISTRATION_CORS_HEADERS);
  }

  let payload: unknown;
  try {
    payload = await readJsonPostBody(request);
  } catch (error) {
    if (error instanceof OAuthRequestError) {
      return oauthError(
        "invalid_request",
        error.status,
        error.status === 405
          ? { ...REGISTRATION_CORS_HEADERS, Allow: "POST, OPTIONS" }
          : REGISTRATION_CORS_HEADERS,
      );
    }
    return oauthError("server_error", 500, REGISTRATION_CORS_HEADERS);
  }

  let registration;
  try {
    registration = validateDcrClientMetadata(payload);
  } catch {
    return oauthError("invalid_client_metadata", 400, REGISTRATION_CORS_HEADERS);
  }

  try {
    const stored = await createOAuthPersistence(config).registerClient({
      clientName: registration.clientName,
      redirectUris: [...registration.redirectUris],
      expiresAt: null,
    });
    return oauthJson({
      client_id: stored.clientId,
      client_name: registration.clientName,
      redirect_uris: registration.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201, REGISTRATION_CORS_HEADERS);
  } catch (error) {
    if (error instanceof OAuthPersistenceUnavailableError) {
      return oauthError("temporarily_unavailable", 503, REGISTRATION_CORS_HEADERS);
    }
    return oauthError("server_error", 500, REGISTRATION_CORS_HEADERS);
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
