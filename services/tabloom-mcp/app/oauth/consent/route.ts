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
import {
  createOAuthAuditContext,
  emitOAuthAudit,
  type OAuthResultClass,
} from "../../../src/observability/oauth-audit";

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

type ConsentRedirectError = "access_denied" | "invalid_request" | "server_error";

function terminalError(
  error: "invalid_request" | "server_error" | "temporarily_unavailable",
  status: 400 | 500 | 503,
  correlationId?: string,
): Response {
  return oauthError(
    error,
    status,
    { "Set-Cookie": clearConsentCookie() },
    correlationId,
  );
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
  correlationId?: string,
): Response {
  const location = new URL(session.request.redirectUri);
  location.searchParams.delete("code");
  location.searchParams.delete("error");
  if ("code" in result) location.searchParams.set("code", result.code);
  else location.searchParams.set("error", result.error);
  location.searchParams.set("state", session.request.state);
  if (correlationId) location.searchParams.set("correlation_id", correlationId);
  return new Response(null, {
    status: 302,
    headers: noStoreHeaders({
      Location: location.href,
      "Set-Cookie": clearConsentCookie(),
    }),
  });
}

function loadEnabledConfig(correlationId: string):
  | { config: FacadeAuthConfig }
  | { response: Response; resultClass: OAuthResultClass } {
  let config: FacadeAuthConfig;
  try {
    config = loadFacadeAuthConfig(process.env);
  } catch {
    return {
      response: terminalError("server_error", 500, correlationId),
      resultClass: "server_error",
    };
  }
  if (!config.oauthEnabled) {
    return {
      response: terminalError("temporarily_unavailable", 503),
      resultClass: "dependency_error",
    };
  }
  return { config };
}

export async function GET(request: Request): Promise<Response> {
  const audit = createOAuthAuditContext("consent");
  const respond = (response: Response, resultClass: OAuthResultClass, clientId?: string) => {
    emitOAuthAudit(audit, { resultClass, clientId });
    return response;
  };
  const loaded = loadEnabledConfig(audit.correlationId);
  if ("response" in loaded) return respond(loaded.response, loaded.resultClass);
  const { config } = loaded;

  let session: ConsentSession;
  try {
    session = await validSession(request, config);
  } catch {
    return respond(terminalError("invalid_request", 400), "client_error");
  }

  return respond(new Response(renderConsentPage(session), {
    status: 200,
    headers: noStoreHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    }),
  }), "success", session.request.client.clientId);
}

export async function POST(request: Request): Promise<Response> {
  const audit = createOAuthAuditContext("consent");
  const respond = (response: Response, resultClass: OAuthResultClass, clientId?: string) => {
    emitOAuthAudit(audit, { resultClass, clientId });
    return response;
  };
  const loaded = loadEnabledConfig(audit.correlationId);
  if ("response" in loaded) return respond(loaded.response, loaded.resultClass);
  const { config } = loaded;

  let session: ConsentSession;
  try {
    session = await validSession(request, config);
  } catch {
    return respond(terminalError("invalid_request", 400), "client_error");
  }
  const clientId = session.request.client.clientId;

  let submission;
  try {
    submission = await readConsentSubmission(request);
  } catch {
    return respond(clientRedirect(session, { error: "invalid_request" }), "client_error", clientId);
  }
  if (!consentNonceMatches(submission.csrfNonce, session.csrfNonce)) {
    return respond(clientRedirect(session, { error: "invalid_request" }), "client_error", clientId);
  }
  if (submission.action === "deny") {
    return respond(clientRedirect(session, { error: "access_denied" }), "client_error", clientId);
  }

  try {
    const code = await sealAuthorizationCode(session, config.encryptionKeys);
    return respond(clientRedirect(session, { code }), "success", clientId);
  } catch {
    return respond(
      clientRedirect(session, { error: "server_error" }, audit.correlationId),
      "server_error",
      clientId,
    );
  }
}
