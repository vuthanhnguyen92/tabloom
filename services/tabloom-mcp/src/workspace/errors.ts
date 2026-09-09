import { ZodError } from "zod";
import { TrashDecodeError, WorkspaceCommandError, type WorkspaceCommandErrorCode } from "../../../../shared/trash";

export { WorkspaceCommandError };

const messages: Record<WorkspaceCommandErrorCode, string> = {
  not_found: "The workspace item was not found.",
  read_only: "This workspace item is read-only.",
  conflict: "The workspace changed. Read the current state and try again.",
  validation_failed: "The workspace command or response is invalid.",
  destination_required: "Choose a destination to restore this item.",
  confirmation_required: "Confirm this deletion before continuing.",
  confirmation_expired: "The deletion confirmation has expired.",
};

export function commandError(code: WorkspaceCommandErrorCode, details: Record<string, unknown> = {}): WorkspaceCommandError {
  return new WorkspaceCommandError(code, messages[code], details);
}

/** Classify known failures; preserve unexpected ones for boundary correlation. */
export function mapWorkspaceCommandError<T>(error: T): WorkspaceCommandError | T {
  if (error instanceof WorkspaceCommandError) {
    const details: Record<string, unknown> = {};
    if (typeof error.details.id === "string" && /^[0-9a-f-]{36}$/i.test(error.details.id)) details.id = error.details.id;
    if (typeof error.details.updatedAt === "string" && Number.isFinite(Date.parse(error.details.updatedAt))) details.updatedAt = error.details.updatedAt;
    if (Number.isSafeInteger(error.details.revision) && Number(error.details.revision) >= 0) details.revision = error.details.revision;
    if (error.details.destinationType === "space" || error.details.destinationType === "collection") details.destinationType = error.details.destinationType;
    return commandError(error.code, details);
  }
  if (error instanceof ZodError || error instanceof TrashDecodeError) return commandError("validation_failed");
  const candidate = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
  if (["22023", "22P02", "22007", "22008", "22003", "23502", "23514"].includes(String(candidate.code))) return commandError("validation_failed");
  if (candidate.code === "40001" || candidate.code === "23505") return commandError("conflict");
  if (candidate.code === "42501" && candidate.message === "read_only") return commandError("read_only");
  if (["P0002", "PGRST116", "23503", "42501", "28000", "PGRST301", "401"].includes(String(candidate.code))) return commandError("not_found");
  if (candidate.code === "P0001" && ["confirmation_required", "confirmation_expired", "destination_required"].includes(String(candidate.message))) {
    return commandError(candidate.message as WorkspaceCommandErrorCode);
  }
  return error;
}

export async function workspaceCommand<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { throw mapWorkspaceCommandError(error); }
}
