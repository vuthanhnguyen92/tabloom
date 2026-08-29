import { createHash, timingSafeEqual } from "node:crypto";

import { openArtifact, sealArtifact } from "../auth/artifacts";
import type { EncryptionKeyRing } from "../auth/key-rings";
import type { ConsentSession } from "./cookies";

export const AUTHORIZATION_CODE_LIFETIME_SECONDS = 2 * 60;
export const MAX_CONSENT_FORM_BODY_BYTES = 32 * 1024;

export type ConsentAction = "approve" | "deny";

export type ConsentSubmission = {
  action: ConsentAction;
  csrfNonce: string;
};

export type AuthorizationCodePayload = {
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: "tabloom:workspace";
  codeChallenge: string;
  userId: string;
  supabaseAccessToken: string;
  supabaseRefreshToken: string;
  supabaseAccessTokenExpiresAt: number;
  jti: string;
  grantId: string;
  issuedAt: number;
  expiresAt: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RANDOM_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MALFORMED_PERCENT_ENCODING = /%(?![0-9a-f]{2})/i;

function invalidConsentForm(): Error {
  return new Error("Invalid consent submission");
}

function invalidAuthorizationCode(): Error {
  return new Error("Invalid authorization code");
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

function isAuthorizationCodePayload(value: unknown): value is AuthorizationCodePayload {
  if (!isRecord(value) || !hasExactKeys(value, [
    "clientId",
    "redirectUri",
    "resource",
    "scope",
    "codeChallenge",
    "userId",
    "supabaseAccessToken",
    "supabaseRefreshToken",
    "supabaseAccessTokenExpiresAt",
    "jti",
    "grantId",
    "issuedAt",
    "expiresAt",
  ])) return false;

  return isBoundedString(value.clientId, 2048) &&
    isBoundedString(value.redirectUri, 2048) &&
    isBoundedString(value.resource, 2048) &&
    value.scope === "tabloom:workspace" &&
    typeof value.codeChallenge === "string" && RANDOM_IDENTIFIER_PATTERN.test(value.codeChallenge) &&
    typeof value.userId === "string" && UUID_PATTERN.test(value.userId) &&
    isBoundedString(value.supabaseAccessToken) &&
    isBoundedString(value.supabaseRefreshToken) &&
    typeof value.supabaseAccessTokenExpiresAt === "number" &&
    Number.isSafeInteger(value.supabaseAccessTokenExpiresAt) &&
    typeof value.jti === "string" && RANDOM_IDENTIFIER_PATTERN.test(value.jti) &&
    typeof value.grantId === "string" && RANDOM_IDENTIFIER_PATTERN.test(value.grantId) &&
    value.jti !== value.grantId &&
    typeof value.issuedAt === "number" && Number.isSafeInteger(value.issuedAt) &&
    typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt === value.issuedAt + AUTHORIZATION_CODE_LIFETIME_SECONDS &&
    value.supabaseAccessTokenExpiresAt > value.issuedAt;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

export function renderConsentPage(session: ConsentSession): string {
  const clientName = escapeHtml(session.request.client.clientName);
  const redirectUri = escapeHtml(session.request.redirectUri);
  const csrfNonce = escapeHtml(session.csrfNonce);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Tabloom</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { box-sizing: border-box; width: min(42rem, calc(100% - 2rem)); padding: 2rem; border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); border-radius: 1rem; }
    h1 { margin-top: 0; }
    code { overflow-wrap: anywhere; }
    .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
    button { padding: .7rem 1rem; font: inherit; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize ${clientName}</h1>
    <p><strong>${clientName}</strong> is requesting the <code>tabloom:workspace</code> permission.</p>
    <section aria-labelledby="permission-heading">
      <h2 id="permission-heading">Read and organize your synchronized Tabloom workspace</h2>
      <p>This includes synchronized spaces, collections, and saved links.</p>
      <p>Current browser tabs and device-only bookmarks are not included.</p>
    </section>
    <p>After your choice, Tabloom will return you to <code>${redirectUri}</code>.</p>
    <form method="post" action="/oauth/consent">
      <input type="hidden" name="csrf_nonce" value="${csrfNonce}">
      <div class="actions">
        <button type="submit" name="action" value="approve">Approve</button>
        <button type="submit" name="action" value="deny">Deny</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

function contentLengthTooLarge(value: string | null): boolean {
  return value !== null && (!/^\d+$/.test(value) || BigInt(value) > BigInt(MAX_CONSENT_FORM_BODY_BYTES));
}

export async function readConsentSubmission(request: Request): Promise<ConsentSubmission> {
  if (request.method !== "POST" ||
      request.headers.get("Content-Type")?.trim().toLowerCase() !== "application/x-www-form-urlencoded" ||
      contentLengthTooLarge(request.headers.get("Content-Length")) ||
      !request.body) {
    throw invalidConsentForm();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONSENT_FORM_BODY_BYTES) {
        await reader.cancel();
        throw invalidConsentForm();
      }
      chunks.push(value);
    }
  } catch {
    throw invalidConsentForm();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidConsentForm();
  }
  if (!text || MALFORMED_PERCENT_ENCODING.test(text)) throw invalidConsentForm();

  const params = new URLSearchParams(text);
  const entries = [...params];
  const actions = params.getAll("action");
  const nonces = params.getAll("csrf_nonce");
  if (entries.length !== 2 || actions.length !== 1 || nonces.length !== 1 ||
      (actions[0] !== "approve" && actions[0] !== "deny") || !nonces[0]) {
    throw invalidConsentForm();
  }
  return { action: actions[0], csrfNonce: nonces[0] };
}

export function consentNonceMatches(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export async function sealAuthorizationCode(
  session: ConsentSession,
  keys: EncryptionKeyRing,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: AuthorizationCodePayload = {
    clientId: session.request.client.clientId,
    redirectUri: session.request.redirectUri,
    resource: session.request.resource,
    scope: session.request.scope,
    codeChallenge: session.request.codeChallenge,
    userId: session.userId,
    supabaseAccessToken: session.supabaseAccessToken,
    supabaseRefreshToken: session.supabaseRefreshToken,
    supabaseAccessTokenExpiresAt: session.supabaseAccessTokenExpiresAt,
    jti: session.authorizationCodeJti,
    grantId: session.grantId,
    issuedAt: now,
    expiresAt: now + AUTHORIZATION_CODE_LIFETIME_SECONDS,
  };
  if (!isAuthorizationCodePayload(payload)) throw invalidAuthorizationCode();
  return sealArtifact("authorization_code", payload, AUTHORIZATION_CODE_LIFETIME_SECONDS, keys, now);
}

export async function openAuthorizationCode(
  code: string,
  keys: EncryptionKeyRing,
  now = Math.floor(Date.now() / 1000),
): Promise<AuthorizationCodePayload> {
  try {
    const payload = await openArtifact<unknown>("authorization_code", code, keys, now);
    if (!isAuthorizationCodePayload(payload) || payload.issuedAt > now || now >= payload.expiresAt) {
      throw invalidAuthorizationCode();
    }
    return payload;
  } catch {
    throw invalidAuthorizationCode();
  }
}
