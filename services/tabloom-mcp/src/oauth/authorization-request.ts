import { createHash, timingSafeEqual } from "node:crypto";

import type { ValidatedClient } from "./client-metadata";

export type ValidatedAuthorizationRequest = {
  client: ValidatedClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  scope: "tabloom:workspace";
};

export type OAuthAuthorizationError = "invalid_request" | "invalid_client" | "invalid_scope";

export class AuthorizationRequestError extends Error {
  constructor(
    readonly error: OAuthAuthorizationError,
    readonly redirectUri?: string,
    readonly state?: string,
  ) {
    super(error);
    this.name = "AuthorizationRequestError";
  }
}

export type AuthorizationRequestOptions = {
  resolveClient: (clientId: string) => Promise<ValidatedClient>;
  resource: string;
};

const AUTHORIZATION_KEYS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "resource",
  "response_type",
  "scope",
  "state",
]);
const PKCE_VALUE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function unsafeError(error: OAuthAuthorizationError): AuthorizationRequestError {
  return new AuthorizationRequestError(error);
}

function safeError(
  error: OAuthAuthorizationError,
  redirectUri: string,
  state: string | undefined,
): AuthorizationRequestError {
  return new AuthorizationRequestError(error, redirectUri, state);
}

export async function validateAuthorizationRequest(
  params: URLSearchParams,
  options: AuthorizationRequestOptions,
): Promise<ValidatedAuthorizationRequest> {
  const record: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of params) {
    if (Object.hasOwn(record, key)) throw unsafeError("invalid_request");
    record[key] = value;
  }

  const clientId = record.client_id;
  const redirectUri = record.redirect_uri;
  if (!clientId || !redirectUri) throw unsafeError("invalid_request");

  let client: ValidatedClient;
  try {
    client = await options.resolveClient(clientId);
  } catch {
    throw unsafeError("invalid_client");
  }
  if (client.clientId !== clientId) throw unsafeError("invalid_client");
  if (!client.redirectUris.includes(redirectUri)) throw unsafeError("invalid_request");

  const state = record.state;
  const fail = (error: OAuthAuthorizationError): never => {
    throw safeError(error, redirectUri, state);
  };
  const keys = Object.keys(record);
  if (keys.length !== AUTHORIZATION_KEYS.size || keys.some((key) => !AUTHORIZATION_KEYS.has(key))) {
    fail("invalid_request");
  }
  if (record.response_type !== "code") fail("invalid_request");
  if (!state || Buffer.byteLength(state, "utf8") > 512) fail("invalid_request");
  if (!record.code_challenge || !PKCE_CHALLENGE_PATTERN.test(record.code_challenge)) fail("invalid_request");
  if (record.code_challenge_method !== "S256") fail("invalid_request");
  if (record.resource !== options.resource) fail("invalid_request");
  if (record.scope !== "tabloom:workspace") fail("invalid_scope");

  return Object.freeze({
    client,
    redirectUri,
    state,
    codeChallenge: record.code_challenge,
    resource: options.resource,
    scope: "tabloom:workspace" as const,
  });
}

export function verifyS256(codeVerifier: string, expectedChallenge: string): boolean {
  if (!PKCE_VALUE_PATTERN.test(codeVerifier) || !PKCE_CHALLENGE_PATTERN.test(expectedChallenge)) {
    return false;
  }
  const actual = createHash("sha256").update(codeVerifier, "ascii").digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedChallenge, "base64url");
  } catch {
    return false;
  }
  return expected.byteLength === actual.byteLength && timingSafeEqual(actual, expected);
}
