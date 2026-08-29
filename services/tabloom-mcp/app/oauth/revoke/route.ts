import { loadFacadeAuthConfig } from "../../../src/auth/config";
import {
  createOAuthPersistence,
  OAuthPersistenceUnavailableError,
} from "../../../src/oauth/persistence";
import { revokeOAuthToken } from "../../../src/oauth/revocation-service";
import { noStoreHeaders, oauthJson } from "../../../src/oauth/responses";

const MAX_REVOCATION_FORM_BODY_BYTES = 32 * 1024;
const ALLOWED_FORM_KEYS = new Set(["token", "token_type_hint"]);

class RevocationRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly error: "invalid_request" | "invalid_client") {
    super(error);
    this.name = "RevocationRequestError";
  }
}

function errorResponse(
  error: "invalid_request" | "invalid_client" | "server_error" | "temporarily_unavailable",
  status: 400 | 401 | 405 | 413 | 500 | 503,
  headers: HeadersInit = {},
): Response {
  return oauthJson({ error }, status, headers);
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
  if (!/^\d+$/.test(value)) throw new RevocationRequestError(400, "invalid_request");
  return BigInt(value) > BigInt(MAX_REVOCATION_FORM_BODY_BYTES);
}

async function readBoundedBody(request: Request): Promise<string> {
  if (!isFormContentType(request.headers.get("Content-Type")) || !request.body) {
    throw new RevocationRequestError(400, "invalid_request");
  }
  if (declaredBodyTooLarge(request.headers.get("Content-Length"))) {
    throw new RevocationRequestError(413, "invalid_request");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REVOCATION_FORM_BODY_BYTES) {
        await reader.cancel();
        throw new RevocationRequestError(413, "invalid_request");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RevocationRequestError) throw error;
    throw new RevocationRequestError(400, "invalid_request");
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
    throw new RevocationRequestError(400, "invalid_request");
  }
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    throw new RevocationRequestError(400, "invalid_request");
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

async function readRevocationToken(request: Request): Promise<string> {
  if (request.headers.has("Authorization")) {
    throw new RevocationRequestError(400, "invalid_client");
  }
  const text = await readBoundedBody(request);
  if (!text) throw new RevocationRequestError(400, "invalid_request");

  const entries = parseFormEntries(text);
  if (entries.some(([key]) => key === "client_secret" ||
      key === "client_assertion" || key === "client_assertion_type")) {
    throw new RevocationRequestError(400, "invalid_client");
  }

  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of entries) {
    if (Object.hasOwn(values, key)) {
      throw new RevocationRequestError(400, "invalid_request");
    }
    values[key] = value;
  }
  const keys = Object.keys(values);
  if (
    keys.some((key) => !ALLOWED_FORM_KEYS.has(key)) ||
    keys.length < 1 ||
    keys.length > ALLOWED_FORM_KEYS.size ||
    typeof values.token !== "string" ||
    values.token.length === 0 ||
    (Object.hasOwn(values, "token_type_hint") && values.token_type_hint!.length === 0)
  ) {
    throw new RevocationRequestError(400, "invalid_request");
  }
  return values.token;
}

export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = loadFacadeAuthConfig(process.env);
  } catch {
    return errorResponse("server_error", 500);
  }
  if (!config.oauthEnabled) return errorResponse("temporarily_unavailable", 503);

  let token: string;
  try {
    token = await readRevocationToken(request);
  } catch (error) {
    if (error instanceof RevocationRequestError) {
      return errorResponse(
        error.error,
        error.error === "invalid_client" ? 401 : error.status,
      );
    }
    return errorResponse("server_error", 500);
  }

  try {
    await revokeOAuthToken(token, config, createOAuthPersistence(config));
    return new Response(null, { status: 200, headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof OAuthPersistenceUnavailableError) {
      return errorResponse("temporarily_unavailable", 503);
    }
    return errorResponse("server_error", 500);
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
