import { loadFacadeAuthConfig, type FacadeAuthConfig } from "../../../src/auth/config";
import {
  clearConsentCookie,
  readConsentSession,
  type ConsentSession,
} from "../../../src/oauth/cookies";
import {
  consentNonceMatches,
  readConsentSubmission,
  renderConsentPage,
  sealAuthorizationCode,
} from "../../../src/oauth/consent";
import { noStoreHeaders, oauthError } from "../../../src/oauth/responses";

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

type ConsentRedirectError = "access_denied" | "invalid_request" | "server_error";

function terminalError(
  error: "invalid_request" | "server_error" | "temporarily_unavailable",
  status: 400 | 500 | 503,
): Response {
  return oauthError(error, status, { "Set-Cookie": clearConsentCookie() });
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

async function validSession(request: Request, config: FacadeAuthConfig): Promise<ConsentSession> {
  const session = await readConsentSession(request, config.encryptionKeys);
  if (session.request.resource !== config.resourceUrl.origin ||
      !session.request.client.redirectUris.includes(session.request.redirectUri) ||
      !isAllowedRedirectUri(session.request.redirectUri)) {
    throw new Error("Invalid consent session");
  }
  return session;
}

function clientRedirect(
  session: ConsentSession,
  result: { code: string } | { error: ConsentRedirectError },
): Response {
  const location = new URL(session.request.redirectUri);
  location.searchParams.delete("code");
  location.searchParams.delete("error");
  if ("code" in result) location.searchParams.set("code", result.code);
  else location.searchParams.set("error", result.error);
  location.searchParams.set("state", session.request.state);
  return new Response(null, {
    status: 302,
    headers: noStoreHeaders({
      Location: location.href,
      "Set-Cookie": clearConsentCookie(),
    }),
  });
}

function loadEnabledConfig(): FacadeAuthConfig | Response {
  let config: FacadeAuthConfig;
  try {
    config = loadFacadeAuthConfig(process.env);
  } catch {
    return terminalError("server_error", 500);
  }
  if (!config.oauthEnabled) return terminalError("temporarily_unavailable", 503);
  return config;
}

export async function GET(request: Request): Promise<Response> {
  const config = loadEnabledConfig();
  if (config instanceof Response) return config;

  let session: ConsentSession;
  try {
    session = await validSession(request, config);
  } catch {
    return terminalError("invalid_request", 400);
  }

  return new Response(renderConsentPage(session), {
    status: 200,
    headers: noStoreHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    }),
  });
}

export async function POST(request: Request): Promise<Response> {
  const config = loadEnabledConfig();
  if (config instanceof Response) return config;

  let session: ConsentSession;
  try {
    session = await validSession(request, config);
  } catch {
    return terminalError("invalid_request", 400);
  }

  let submission;
  try {
    submission = await readConsentSubmission(request);
  } catch {
    return clientRedirect(session, { error: "invalid_request" });
  }
  if (!consentNonceMatches(submission.csrfNonce, session.csrfNonce)) {
    return clientRedirect(session, { error: "invalid_request" });
  }
  if (submission.action === "deny") {
    return clientRedirect(session, { error: "access_denied" });
  }

  try {
    const code = await sealAuthorizationCode(session, config.encryptionKeys);
    return clientRedirect(session, { code });
  } catch {
    return clientRedirect(session, { error: "server_error" });
  }
}
