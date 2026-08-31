export class WorkspaceSyncError extends Error {
  constructor(message: string, readonly operationId?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WorkspaceWriteFailedError extends WorkspaceSyncError {}
export class WorkspaceWriteBlockedError extends WorkspaceSyncError {}
export class WorkspaceAuthenticationError extends WorkspaceSyncError {}
export class WorkspaceConflictActionRequiredError extends WorkspaceSyncError {}
export class WorkspaceOfflineError extends WorkspaceSyncError {}
