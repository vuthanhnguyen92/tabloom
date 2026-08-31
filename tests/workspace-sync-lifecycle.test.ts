import { describe, expect, it, vi } from "vitest";
import { registerWorkspaceSyncLifecycle } from "../extension/workspace-sync-lifecycle";

function lifecycleTargets() {
  let visible = false;
  let focused = false;
  const documentTarget = new EventTarget() as Document;
  const windowTarget = new EventTarget() as Window;
  Object.defineProperty(documentTarget, "visibilityState", { get: () => visible ? "visible" : "hidden" });
  Object.defineProperty(documentTarget, "hasFocus", { value: () => focused });
  return {
    documentTarget,
    windowTarget,
    setActive(next: boolean) {
      visible = next;
      focused = next;
    },
  };
}

describe("workspace sync lifecycle", () => {
  it("coalesces visibility and focus events into one genuine focus transition", () => {
    const refreshOnFocus = vi.fn(async () => undefined);
    const targets = lifecycleTargets();
    const cleanup = registerWorkspaceSyncLifecycle({ refreshOnFocus }, targets.documentTarget, targets.windowTarget);

    targets.setActive(true);
    targets.documentTarget.dispatchEvent(new Event("visibilitychange"));
    targets.windowTarget.dispatchEvent(new Event("focus"));
    targets.windowTarget.dispatchEvent(new Event("focus"));

    expect(refreshOnFocus).toHaveBeenCalledOnce();
    cleanup();
  });

  it("runs once again only after the page becomes inactive", () => {
    const refreshOnFocus = vi.fn(async () => undefined);
    const targets = lifecycleTargets();
    const cleanup = registerWorkspaceSyncLifecycle({ refreshOnFocus }, targets.documentTarget, targets.windowTarget);

    targets.setActive(true);
    targets.windowTarget.dispatchEvent(new Event("focus"));
    targets.setActive(false);
    targets.windowTarget.dispatchEvent(new Event("blur"));
    targets.documentTarget.dispatchEvent(new Event("visibilitychange"));
    targets.setActive(true);
    targets.windowTarget.dispatchEvent(new Event("focus"));

    expect(refreshOnFocus).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("does not sync on online events and removes every listener on cleanup", () => {
    const refreshOnFocus = vi.fn(async () => undefined);
    const targets = lifecycleTargets();
    const cleanup = registerWorkspaceSyncLifecycle({ refreshOnFocus }, targets.documentTarget, targets.windowTarget);

    targets.windowTarget.dispatchEvent(new Event("online"));
    cleanup();
    targets.setActive(true);
    targets.windowTarget.dispatchEvent(new Event("focus"));
    targets.documentTarget.dispatchEvent(new Event("visibilitychange"));

    expect(refreshOnFocus).not.toHaveBeenCalled();
  });
});
