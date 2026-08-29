import { randomUUID } from "node:crypto";

export const MAX_OAUTH_JSON_BODY_BYTES = 32 * 1024;

export type OAuthErrorCode =
  | "invalid_client_metadata"
  | "invalid_request"
  | "server_error"
  | "temporarily_unavailable";

type JsonValue = Record<string, unknown>;

export class OAuthRequestError extends Error {
  constructor(readonly status: 400 | 405 | 413) {
    super("Invalid OAuth request");
    this.name = "OAuthRequestError";
  }
}

export function correlationId(): string {
  return randomUUID();
}

export function noStoreHeaders(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  result.set("Pragma", "no-cache");
  return result;
}

export function publicMetadataHeaders(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.set("Access-Control-Allow-Origin", "*");
  result.set("Cache-Control", "public, max-age=300");
  return result;
}

export function corsOptions(methods: string, headers: HeadersInit = {}): Response {
  const responseHeaders = publicMetadataHeaders(headers);
  responseHeaders.set("Access-Control-Allow-Methods", methods);
  responseHeaders.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(null, { status: 204, headers: responseHeaders });
}

export function oauthJson(
  body: JsonValue,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return Response.json(body, { status, headers: noStoreHeaders(headers) });
}

export function oauthError(
  error: OAuthErrorCode,
  status: 400 | 405 | 413 | 500 | 503,
  headers: HeadersInit = {},
): Response {
  const body: JsonValue = { error };
  if (error === "server_error") body.correlation_id = correlationId();
  return oauthJson(body, status, headers);
}

export function oauthRedirectError(
  redirectUri: string,
  error: OAuthErrorCode,
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

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function declaredBodyIsTooLarge(value: string | null): boolean {
  return value !== null && /^\d+$/.test(value) && BigInt(value) > BigInt(MAX_OAUTH_JSON_BODY_BYTES);
}

export async function readJsonPostBody(request: Request): Promise<unknown> {
  if (request.method !== "POST") throw new OAuthRequestError(405);
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    throw new OAuthRequestError(400);
  }
  if (declaredBodyIsTooLarge(request.headers.get("Content-Length"))) {
    throw new OAuthRequestError(413);
  }
  if (!request.body) throw new OAuthRequestError(400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OAUTH_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new OAuthRequestError(413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OAuthRequestError) throw error;
    throw new OAuthRequestError(400);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new OAuthRequestError(400);
  }
}
