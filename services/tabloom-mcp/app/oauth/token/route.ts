import { loadFacadeAuthConfig } from "../../../src/auth/config";
import {
  OAuthPersistenceUnavailableError,
  createOAuthPersistence,
} from "../../../src/oauth/persistence";
import { noStoreHeaders, oauthJson } from "../../../src/oauth/responses";
import { oauthError } from "../../../src/oauth/responses";
import {
  createOAuthAuditContext,
  emitOAuthAudit,
  type OAuthResultClass,
} from "../../../src/observability/oauth-audit";
import { checkOAuthRateLimit } from "../../../src/security/oauth-rate-limit";
import {
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  TokenServiceError,
  type AuthorizationCodeTokenRequest,
  type RefreshTokenRequest,
} from "../../../src/oauth/token-service";

const MAX_TOKEN_FORM_BODY_BYTES = 32 * 1024;
const AUTHORIZATION_CODE_FORM_KEYS = new Set([
  "grant_type",
  "code",
  "client_id",
  "redirect_uri",
  "resource",
  "code_verifier",
]);
const REFRESH_TOKEN_REQUIRED_FORM_KEYS = new Set([
  "grant_type",
  "refresh_token",
  "client_id",
  "resource",
]);
const REFRESH_TOKEN_FORM_KEYS = new Set([
  ...REFRESH_TOKEN_REQUIRED_FORM_KEYS,
  "scope",
]);
const TOKEN_CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };
type TokenRequest = AuthorizationCodeTokenRequest | RefreshTokenRequest;

class TokenRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly error: "invalid_request" | "invalid_client") {
    super(error);
    this.name = "TokenRequestError";
  }
}

function errorResponse(
  error: "invalid_request" | "invalid_client" | "invalid_grant" | "invalid_scope" | "server_error" | "temporarily_unavailable",
  status: 400 | 401 | 405 | 413 | 429 | 500 | 503,
  headers: HeadersInit = {},
  serverErrorCorrelationId?: string,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  return error === "server_error"
    ? oauthError(error, status, responseHeaders, serverErrorCorrelationId)
    : oauthJson({ error }, status, responseHeaders);
}

function unsupportedMethod(): Response {
  return errorResponse("invalid_request", 405, { Allow: "POST" });
}

export const GET = unsupportedMethod;
export const HEAD = unsupportedMethod;
export const PUT = unsupportedMethod;
export const PATCH = unsupportedMethod;
export const DELETE = unsupportedMethod;

function isFormContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/x-www-form-urlencoded";
}

function declaredBodyTooLarge(value: string | null): boolean {
  if (value === null) return false;
  if (!/^\d+$/.test(value)) throw new TokenRequestError(400, "invalid_request");
  return BigInt(value) > BigInt(MAX_TOKEN_FORM_BODY_BYTES);
}

async function readBoundedBody(request: Request): Promise<string> {
  if (!isFormContentType(request.headers.get("Content-Type")) || !request.body) {
    throw new TokenRequestError(400, "invalid_request");
  }
  if (declaredBodyTooLarge(request.headers.get("Content-Length"))) {
    throw new TokenRequestError(413, "invalid_request");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_TOKEN_FORM_BODY_BYTES) {
        await reader.cancel();
        throw new TokenRequestError(413, "invalid_request");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TokenRequestError) throw error;
    throw new TokenRequestError(400, "invalid_request");
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TokenRequestError(400, "invalid_request");
  }
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    throw new TokenRequestError(400, "invalid_request");
  }
}

function parseFormEntries(text: string): Array<[string, string]> {
  return text.split("&").map((entry) => {
    const separator = entry.indexOf("=");
    const key = separator === -1 ? entry : entry.slice(0, separator);
    const value = separator === -1 ? "" : entry.slice(separator + 1);
    return [decodeFormComponent(key), decodeFormComponent(value)];
  });
}

function hasExactKeys(values: Record<string, string>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(values);
  return keys.length === expected.size &&
    keys.every((key) => expected.has(key)) &&
    keys.every((key) => values[key]!.length > 0);
}

function hasRefreshKeys(values: Record<string, string>): boolean {
  const keys = Object.keys(values);
  return keys.length >= REFRESH_TOKEN_REQUIRED_FORM_KEYS.size &&
    keys.length <= REFRESH_TOKEN_FORM_KEYS.size &&
    keys.every((key) => REFRESH_TOKEN_FORM_KEYS.has(key)) &&
    [...REFRESH_TOKEN_REQUIRED_FORM_KEYS].every((key) =>
      typeof values[key] === "string" && values[key]!.length > 0
    ) &&
    (!Object.hasOwn(values, "scope") || values.scope!.length > 0);
}

async function readTokenRequest(request: Request): Promise<TokenRequest> {
  if (request.headers.has("Authorization")) {
    throw new TokenRequestError(400, "invalid_client");
  }
  const text = await readBoundedBody(request);
  if (!text) {
    throw new TokenRequestError(400, "invalid_request");
  }

  const entries = parseFormEntries(text);
  if (entries.some(([key]) => key === "client_secret" ||
      key === "client_assertion" || key === "client_assertion_type")) {
    throw new TokenRequestError(400, "invalid_client");
  }

  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of entries) {
    if (Object.hasOwn(values, key)) throw new TokenRequestError(400, "invalid_request");
    values[key] = value;
  }
  if (values.grant_type === "authorization_code" &&
      hasExactKeys(values, AUTHORIZATION_CODE_FORM_KEYS)) {
    return {
      grantType: "authorization_code",
      code: values.code!,
      clientId: values.client_id!,
      redirectUri: values.redirect_uri!,
      resource: values.resource!,
      codeVerifier: values.code_verifier!,
    };
  }
  if (values.grant_type === "refresh_token" &&
      hasRefreshKeys(values)) {
    return {
      grantType: "refresh_token",
      refreshToken: values.refresh_token!,
      clientId: values.client_id!,
      resource: values.resource!,
      scope: values.scope,
    };
  }
  throw new TokenRequestError(400, "invalid_request");
}

export async function POST(request: Request): Promise<Response> {
  const audit = createOAuthAuditContext("token");
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
      errorResponse("server_error", 500, {}, audit.correlationId),
      "server_error",
    );
  }
  if (!config.oauthEnabled) {
    return respond(errorResponse("temporarily_unavailable", 503), "dependency_error");
  }

  let tokenRequest: TokenRequest;
  try {
    tokenRequest = await readTokenRequest(request);
  } catch (error) {
    if (error instanceof TokenRequestError) {
      return respond(errorResponse(
        error.error,
        error.error === "invalid_client" ? 401 : error.status,
      ), "client_error");
    }
    return respond(
      errorResponse("server_error", 500, {}, audit.correlationId),
      "server_error",
    );
  }

  const rateLimit = await checkOAuthRateLimit({
    route: "token",
    request,
    clientId: tokenRequest.clientId,
  });
  if (!rateLimit.allowed) {
    return respond(errorResponse("temporarily_unavailable", 429, {
      "Retry-After": String(rateLimit.retryAfterSeconds),
    }), "rate_limited", tokenRequest.clientId);
  }

  try {
    const persistence = createOAuthPersistence(config);
    const response = tokenRequest.grantType === "authorization_code"
      ? await exchangeAuthorizationCode(tokenRequest, config, persistence)
      : await exchangeRefreshToken(tokenRequest, config, persistence);
    return respond(oauthJson(response, 200, TOKEN_CORS_HEADERS), "success", tokenRequest.clientId);
  } catch (error) {
    if (error instanceof TokenServiceError) {
      return respond(errorResponse(
        error.error,
        error.error === "temporarily_unavailable" ? 503 : 400,
      ), error.error === "temporarily_unavailable" ? "dependency_error" : "client_error",
      tokenRequest.clientId);
    }
    if (error instanceof OAuthPersistenceUnavailableError) {
      return respond(
        errorResponse("temporarily_unavailable", 503),
        "dependency_error",
        tokenRequest.clientId,
      );
    }
    return respond(
      errorResponse("server_error", 500, {}, audit.correlationId),
      "server_error",
      tokenRequest.clientId,
    );
  }
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: noStoreHeaders({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }),
  });
}
