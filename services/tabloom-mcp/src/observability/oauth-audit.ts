import { createHash, randomUUID } from "node:crypto";

import type { OAuthAuthorizationFailureReason } from "../oauth/authorization-request";

export type OAuthRouteCategory =
  | "register"
  | "authorize"
  | "callback"
  | "consent"
  | "token"
  | "revoke";
export type OAuthResultClass =
  | "success"
  | "client_error"
  | "rate_limited"
  | "dependency_error"
  | "server_error";
export type OAuthLatencyBucket = "<10ms" | "10-99ms" | "100-999ms" | ">=1000ms";

export type OAuthAuditEvent = {
  routeCategory: OAuthRouteCategory;
  latencyBucket: OAuthLatencyBucket;
  resultClass: OAuthResultClass;
  correlationId: string;
  clientHash?: string;
  grantHash?: string;
  authorizationFailure?: OAuthAuthorizationFailureReason;
};

export type OAuthAuditSink = (event: OAuthAuditEvent) => void;

export type OAuthAuditContext = {
  routeCategory: OAuthRouteCategory;
  startedAtMs: number;
  correlationId: string;
};

export function createOAuthAuditContext(
  routeCategory: OAuthRouteCategory,
  startedAtMs = Date.now(),
  correlationId = randomUUID(),
): OAuthAuditContext {
  return { routeCategory, startedAtMs, correlationId };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function latencyBucket(milliseconds: number): OAuthLatencyBucket {
  if (milliseconds < 10) return "<10ms";
  if (milliseconds < 100) return "10-99ms";
  if (milliseconds < 1_000) return "100-999ms";
  return ">=1000ms";
}

const defaultSink: OAuthAuditSink = (event) => console.info(event);

export function emitOAuthAudit(
  context: OAuthAuditContext,
  result: {
    resultClass: OAuthResultClass;
    clientId?: string;
    grantId?: string;
    nowMs?: number;
    authorizationFailure?: OAuthAuthorizationFailureReason;
  },
  sink: OAuthAuditSink = defaultSink,
): void {
  const event: OAuthAuditEvent = {
    routeCategory: context.routeCategory,
    latencyBucket: latencyBucket(Math.max(0, (result.nowMs ?? Date.now()) - context.startedAtMs)),
    resultClass: result.resultClass,
    correlationId: context.correlationId,
  };
  if (result.authorizationFailure) event.authorizationFailure = result.authorizationFailure;
  if (result.clientId) event.clientHash = digest(result.clientId);
  if (result.grantId) event.grantHash = digest(result.grantId);
  try {
    sink(event);
  } catch {
    // Observability must never change the OAuth result.
  }
}
