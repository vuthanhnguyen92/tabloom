import { randomUUID } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { TabloomRequestContext } from "../auth/request-context";
import type { VerifiedFacadeAuthInfo } from "../auth/verify-token";
import { commandError, mapWorkspaceCommandError, WorkspaceCommandError } from "./errors";

export function toolResult<T extends Record<string, unknown>>(summary: string, value: T) {
  return { content: [{ type: "text" as const, text: summary }], structuredContent: value };
}

export function requireWorkspaceContext(authInfo: AuthInfo | undefined): TabloomRequestContext {
  const context = (authInfo as VerifiedFacadeAuthInfo | undefined)?.extra?.requestContext;
  if (!context || context.scope !== "tabloom:workspace" || !context.userId || !context.clientId || !context.supabase) {
    throw commandError("validation_failed");
  }
  return context;
}

export type WorkspaceToolLog = {
  action: string;
  targetType: "workspace" | "space" | "collection" | "link" | "trash";
  targetId: string | null;
  userId: string | null;
  clientId: string | null;
};

export function workspaceToolError(error: unknown, metadata?: WorkspaceToolLog) {
  if (error instanceof WorkspaceCommandError) {
    const safe = mapWorkspaceCommandError(error);
    return { ...toolResult(safe.message, { error: { code: safe.code, message: safe.message, details: safe.details } }), isError: true };
  }
  const correlationId = randomUUID();
  if (metadata) {
    // Enumerate the allowlist: never log arguments, auth objects, or provider errors.
    console.error({ action: metadata.action, targetType: metadata.targetType, targetId: metadata.targetId,
      userId: metadata.userId, clientId: metadata.clientId, outcome: "internal_error" });
  }
  const message = "The workspace command failed. Try again or share the correlation ID with support.";
  return { ...toolResult(message, { error: { code: "internal_error", message, correlationId } }), isError: true };
}
