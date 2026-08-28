import type { WorkspaceSnapshot } from "../shared/domain";
import type { WorkspaceRepository } from "../shared/repository";
import {
  isEffectivelyEmptyLocalWorkspace,
  isEmptyCloudWorkspace,
  planWorkspaceMerge,
  type VersionedWorkspaceSnapshot,
  type WorkspaceMergePlan,
} from "../shared/workspace-merge";
import {
  WorkspaceRevisionConflictError,
  type WorkspaceMergeResult,
  type WorkspaceSyncRepository,
} from "../shared/workspace-sync-repository";
import type { WorkspaceCache } from "./workspace-cache";

export type FirstSyncDecision =
  | { kind: "adopt-cloud"; cloud: VersionedWorkspaceSnapshot }
  | { kind: "auto-import"; preview: WorkspaceMergePlan }
  | { kind: "confirm"; preview: WorkspaceMergePlan };

export type AdvancedFirstSync =
  | { kind: "synced" }
  | {
      kind: "confirmation";
      coordinator: FirstSyncCoordinator;
      preview: WorkspaceMergePlan;
    };

export async function advanceFirstSync(
  coordinator: FirstSyncCoordinator,
): Promise<AdvancedFirstSync> {
  const decision = await coordinator.inspect();
  if (decision.kind === "confirm") {
    return { kind: "confirmation", coordinator, preview: decision.preview };
  }
  if (decision.kind === "auto-import") {
    await coordinator.confirm(decision.preview);
  }
  return { kind: "synced" };
}

export class FirstSyncPreviewChangedError extends WorkspaceRevisionConflictError {
  constructor(public readonly preview: WorkspaceMergePlan) {
    super("The synced workspace changed. Review the updated merge summary.");
    this.name = "FirstSyncPreviewChangedError";
  }
}

export class FirstSyncCoordinator {
  private pendingLocal: WorkspaceSnapshot | null = null;
  private pendingRevision = 0;

  constructor(
    private readonly dependencies: {
      userId: string;
      localRepository: WorkspaceRepository;
      cloudRepository: WorkspaceRepository;
      syncRepository: WorkspaceSyncRepository;
      cache: WorkspaceCache;
      activateCloud: (
        repository: WorkspaceRepository,
        snapshot: WorkspaceSnapshot,
      ) => Promise<void>;
    },
  ) {}

  async inspect(): Promise<FirstSyncDecision> {
    const [local, cloud] = await Promise.all([
      this.dependencies.localRepository.load(),
      this.dependencies.syncRepository.loadVersioned(),
    ]);
    this.pendingLocal = local;
    this.pendingRevision = cloud.revision;

    if (isEffectivelyEmptyLocalWorkspace(local)) {
      await this.activateCanonicalCloud(cloud);
      return { kind: "adopt-cloud", cloud };
    }

    const preview = planWorkspaceMerge(local, cloud.snapshot, cloud.revision);
    return isEmptyCloudWorkspace(cloud.snapshot)
      ? { kind: "auto-import", preview }
      : { kind: "confirm", preview };
  }

  async confirm(preview: WorkspaceMergePlan): Promise<WorkspaceMergeResult> {
    if (!this.pendingLocal) throw new Error("Inspect the workspace before syncing.");
    if (preview.expectedRevision !== this.pendingRevision) {
      throw new Error("The workspace sync preview is no longer current.");
    }

    try {
      const result = await this.dependencies.syncRepository.mergeLocal(
        this.pendingLocal,
        preview.expectedRevision,
      );
      await this.dependencies.cache.saveCloud(this.dependencies.userId, {
        snapshot: result.snapshot,
        revision: result.revision,
      });
      await this.dependencies.cache.saveSyncState(this.dependencies.userId, {
        status: "synced",
        revision: result.revision,
        lastSyncedAt: new Date().toISOString(),
      });
      await this.dependencies.activateCloud(
        this.dependencies.cloudRepository,
        result.snapshot,
      );
      this.pendingRevision = result.revision;
      return result;
    } catch (reason) {
      if (reason instanceof WorkspaceRevisionConflictError) {
        const cloud = await this.dependencies.syncRepository.loadVersioned();
        this.pendingRevision = cloud.revision;
        throw new FirstSyncPreviewChangedError(
          planWorkspaceMerge(this.pendingLocal, cloud.snapshot, cloud.revision),
        );
      }
      try {
        await this.dependencies.cache.saveSyncState(this.dependencies.userId, {
          status: "error",
          revision: this.pendingRevision,
          error:
            reason instanceof Error
              ? reason.message
              : "Workspace synchronization failed.",
        });
      } catch {
        // The original merge/cache failure remains the actionable error.
      }
      throw reason;
    }
  }

  async cancel(): Promise<void> {
    await this.dependencies.cache.saveSyncState(this.dependencies.userId, {
      status: "pending",
      revision: this.pendingRevision,
    });
  }

  private async activateCanonicalCloud(
    cloud: VersionedWorkspaceSnapshot,
  ): Promise<void> {
    await this.dependencies.cache.saveCloud(this.dependencies.userId, cloud);
    await this.dependencies.cache.saveSyncState(this.dependencies.userId, {
      status: "synced",
      revision: cloud.revision,
      lastSyncedAt: new Date().toISOString(),
    });
    await this.dependencies.activateCloud(
      this.dependencies.cloudRepository,
      cloud.snapshot,
    );
  }
}
