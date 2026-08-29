import { openArtifact, sealArtifact } from "../auth/artifacts";
import type { EncryptionKeyRing } from "../auth/key-rings";
import type { ValidatedAuthorizationRequest } from "./authorization-request";

export const OAUTH_STATE_COOKIE_NAME = "__Host-tabloom_oauth_state";
export const CONSENT_COOKIE_NAME = "__Host-tabloom_consent";
export const MAX_OAUTH_COOKIE_AGE_SECONDS = 10 * 60;

export type UpstreamLoginState = {
  request: ValidatedAuthorizationRequest;
  supabaseCodeVerifier: string;
};

export type ConsentSession = {
  request: ValidatedAuthorizationRequest;
  userId: string;
  supabaseAccessToken: string;
  supabaseRefreshToken: string;
  supabaseAccessTokenExpiresAt: number;
  csrfNonce: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function invalidCookie(): Error {
  return new Error("Invalid OAuth cookie");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isBoundedString(value: unknown, maxBytes = 16 * 1024): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isAuthorizationRequest(value: unknown): value is ValidatedAuthorizationRequest {
  if (!isRecord(value) || !hasExactKeys(value, [
    "client",
    "redirectUri",
    "state",
    "codeChallenge",
    "resource",
    "scope",
  ])) return false;
  const client = value.client;
  return isRecord(client) && hasExactKeys(client, ["clientId", "clientName", "redirectUris", "source"]) &&
    isBoundedString(client.clientId, 2048) &&
    isBoundedString(client.clientName, 512) &&
    Array.isArray(client.redirectUris) && client.redirectUris.length >= 1 && client.redirectUris.length <= 10 &&
    client.redirectUris.every((uri) => isBoundedString(uri, 2048)) &&
    (client.source === "dcr" || client.source === "cimd") &&
    isBoundedString(value.redirectUri, 2048) &&
    client.redirectUris.includes(value.redirectUri) &&
    isBoundedString(value.state, 512) &&
    typeof value.codeChallenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.codeChallenge) &&
    isBoundedString(value.resource, 2048) &&
    value.scope === "tabloom:workspace";
}

function isUpstreamLoginState(value: unknown): value is UpstreamLoginState {
  return isRecord(value) && hasExactKeys(value, ["request", "supabaseCodeVerifier"]) &&
    isAuthorizationRequest(value.request) &&
    typeof value.supabaseCodeVerifier === "string" &&
    PKCE_VERIFIER_PATTERN.test(value.supabaseCodeVerifier);
}

function isConsentSession(value: unknown): value is ConsentSession {
  return isRecord(value) && hasExactKeys(value, [
    "request",
    "userId",
    "supabaseAccessToken",
    "supabaseRefreshToken",
    "supabaseAccessTokenExpiresAt",
    "csrfNonce",
  ]) &&
    isAuthorizationRequest(value.request) &&
    typeof value.userId === "string" && UUID_PATTERN.test(value.userId) &&
    isBoundedString(value.supabaseAccessToken) &&
    isBoundedString(value.supabaseRefreshToken) &&
    Number.isSafeInteger(value.supabaseAccessTokenExpiresAt) &&
    typeof value.csrfNonce === "string" && NONCE_PATTERN.test(value.csrfNonce);
}

function serializeCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function cookieValue(request: Request, name: string): string {
  const matches: string[] = [];
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const segment = part.trim();
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    if (segment.slice(0, separator) === name) matches.push(segment.slice(separator + 1));
  }
  if (matches.length !== 1 || !matches[0]) throw invalidCookie();
  return matches[0];
}

export async function createUpstreamStateCookie(
  state: UpstreamLoginState,
  keys: EncryptionKeyRing,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!isUpstreamLoginState(state)) throw invalidCookie();
  const value = await sealArtifact("upstream_state", state, MAX_OAUTH_COOKIE_AGE_SECONDS, keys, now);
  return serializeCookie(OAUTH_STATE_COOKIE_NAME, value, MAX_OAUTH_COOKIE_AGE_SECONDS);
}

export async function readUpstreamLoginState(
  request: Request,
  keys: EncryptionKeyRing,
  now = Math.floor(Date.now() / 1000),
): Promise<UpstreamLoginState> {
  try {
    const state = await openArtifact<unknown>(
      "upstream_state",
      cookieValue(request, OAUTH_STATE_COOKIE_NAME),
      keys,
      now,
    );
    if (!isUpstreamLoginState(state)) throw invalidCookie();
    return state;
  } catch {
    throw invalidCookie();
  }
}

export async function createConsentCookie(
  session: ConsentSession,
  keys: EncryptionKeyRing,
  lifetimeSeconds = MAX_OAUTH_COOKIE_AGE_SECONDS,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!isConsentSession(session) || !Number.isSafeInteger(lifetimeSeconds) ||
      lifetimeSeconds <= 0 || lifetimeSeconds > MAX_OAUTH_COOKIE_AGE_SECONDS) {
    throw invalidCookie();
  }
  const value = await sealArtifact("consent_session", session, lifetimeSeconds, keys, now);
  return serializeCookie(CONSENT_COOKIE_NAME, value, lifetimeSeconds);
}

export async function readConsentSession(
  request: Request,
  keys: EncryptionKeyRing,
  now = Math.floor(Date.now() / 1000),
): Promise<ConsentSession> {
  try {
    const session = await openArtifact<unknown>(
      "consent_session",
      cookieValue(request, CONSENT_COOKIE_NAME),
      keys,
      now,
    );
    if (!isConsentSession(session) || session.supabaseAccessTokenExpiresAt <= now) {
      throw invalidCookie();
    }
    return session;
  } catch {
    throw invalidCookie();
  }
}

export function clearUpstreamStateCookie(): string {
  return serializeCookie(OAUTH_STATE_COOKIE_NAME, "", 0);
}

export function clearConsentCookie(): string {
  return serializeCookie(CONSENT_COOKIE_NAME, "", 0);
}
