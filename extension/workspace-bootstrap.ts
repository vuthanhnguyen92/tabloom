import type { WorkspaceRepository } from "../shared/repository";
import type { VersionedWorkspaceSnapshot } from "../shared/workspace-merge";
import { isSilentOAuthMiss } from "./auth/oauth";

export interface BootstrapSession {
  user: { id: string };
}

export type WorkspaceBootstrapResult<
  TSession extends BootstrapSession = BootstrapSession,
> =
  | {
      mode: "local-session";
      localRepository: WorkspaceRepository;
      session: TSession;
      recoverySuggested: false;
    }
  | {
      mode: "local-only";
      localRepository: WorkspaceRepository;
      session: null;
      recoverySuggested: boolean;
    }
  | {
      mode: "recovered";
      localRepository: null;
      session: TSession;
      recoverySuggested: false;
    }
  | {
      mode: "reconnect-required";
      localRepository: WorkspaceRepository;
      session: null;
      recoverySuggested: true;
    }
  | {
      mode: "offline";
      localRepository: WorkspaceRepository;
      session: TSession | null;
      recoverySuggested: true;
    };

export interface WorkspaceBootstrapDependencies<
  TSession extends BootstrapSession = BootstrapSession,
> {
  openLocal(): Promise<WorkspaceRepository | null>;
  createLocal(): Promise<WorkspaceRepository>;
  getStoredSession(): Promise<TSession | null>;
  recoverSession(): Promise<TSession>;
  loadRemote(): Promise<VersionedWorkspaceSnapshot>;
  saveRemote(userId: string, value: VersionedWorkspaceSnapshot): Promise<void>;
  recoveryState(): Promise<"pending" | "suppressed" | null>;
  markRecoveryPending(): Promise<void>;
  clearRecoveryState(): Promise<void>;
  canRecover(): boolean;
  isOnline(): boolean;
}

export async function bootstrapWorkspace<TSession extends BootstrapSession>(
  dependencies: WorkspaceBootstrapDependencies<TSession>,
): Promise<WorkspaceBootstrapResult<TSession>> {
  const [localRepository, storedSession, recoveryState] = await Promise.all([
    dependencies.openLocal(),
    dependencies.getStoredSession(),
    dependencies.recoveryState(),
  ]);

  if (localRepository) {
    return storedSession
      ? {
          mode: "local-session",
          localRepository,
          session: storedSession,
          recoverySuggested: false,
        }
      : {
          mode: "local-only",
          localRepository,
          session: null,
          recoverySuggested: recoveryState === "pending",
        };
  }

  if (!dependencies.canRecover()) {
    return {
      mode: "local-only",
      localRepository: await dependencies.createLocal(),
      session: null,
      recoverySuggested: false,
    };
  }

  if (!dependencies.isOnline()) {
    await dependencies.markRecoveryPending();
    return {
      mode: "offline",
      localRepository: await dependencies.createLocal(),
      session: storedSession,
      recoverySuggested: true,
    };
  }

  if (recoveryState === "suppressed") {
    return {
      mode: "local-only",
      localRepository: await dependencies.createLocal(),
      session: null,
      recoverySuggested: false,
    };
  }

  try {
    const recoveredSession = storedSession ?? await dependencies.recoverSession();
    const versioned = await dependencies.loadRemote();
    await dependencies.saveRemote(recoveredSession.user.id, versioned);
    await dependencies.clearRecoveryState();
    return {
      mode: "recovered",
      localRepository: null,
      session: recoveredSession,
      recoverySuggested: false,
    };
  } catch (reason) {
    await dependencies.markRecoveryPending();
    const fallback = await dependencies.createLocal();
    if (isSilentOAuthMiss(reason)) {
      return {
        mode: "reconnect-required",
        localRepository: fallback,
        session: null,
        recoverySuggested: true,
      };
    }
    return {
      mode: "offline",
      localRepository: fallback,
      session: storedSession,
      recoverySuggested: true,
    };
  }
}
