import type { WorkspaceSyncCoordinatorContract } from "./workspace-sync-coordinator";

type FocusRefresher = Pick<WorkspaceSyncCoordinatorContract, "refreshOnFocus">;

export function registerWorkspaceSyncLifecycle(
  coordinator: FocusRefresher,
  documentTarget: Document = document,
  windowTarget: Window = window,
): () => void {
  let active = documentTarget.visibilityState === "visible" && documentTarget.hasFocus();
  const reconcile = () => {
    const next = documentTarget.visibilityState === "visible" && documentTarget.hasFocus();
    if (next && !active) void coordinator.refreshOnFocus().catch(() => undefined);
    active = next;
  };
  const onInactive = () => { active = false; };

  windowTarget.addEventListener("focus", reconcile);
  windowTarget.addEventListener("blur", onInactive);
  documentTarget.addEventListener("visibilitychange", reconcile);

  return () => {
    windowTarget.removeEventListener("focus", reconcile);
    windowTarget.removeEventListener("blur", onInactive);
    documentTarget.removeEventListener("visibilitychange", reconcile);
  };
}
