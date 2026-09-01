import { describe, expect, it, vi } from "vitest";
import { ExtensionOAuthError } from "../extension/auth/oauth";
import {
  bootstrapWorkspace,
  type WorkspaceBootstrapDependencies,
} from "../extension/workspace-bootstrap";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

const session = { user: { id: "user-1" } };
const localRepository = new MemoryWorkspaceRepository("local-user", createDemoSnapshot());
const remote = {
  revision: 42,
  snapshot: { spaces: [], collections: [], links: [] },
};

function dependencies(
  overrides: Partial<WorkspaceBootstrapDependencies<typeof session>> = {},
): WorkspaceBootstrapDependencies<typeof session> {
  return {
    openLocal: vi.fn(async () => null),
    createLocal: vi.fn(async () => localRepository),
    getStoredSession: vi.fn(async () => null),
    recoverSession: vi.fn(async () => session),
    loadRemote: vi.fn(async () => remote),
    saveRemote: vi.fn(async () => undefined),
    recoveryState: vi.fn(async () => null),
    markRecoveryPending: vi.fn(async () => undefined),
    clearRecoveryState: vi.fn(async () => undefined),
    canRecover: () => true,
    isOnline: () => true,
    ...overrides,
  };
}

describe("bootstrapWorkspace", () => {
  it("returns existing local data without running silent OAuth", async () => {
    const deps = dependencies({ openLocal: vi.fn(async () => localRepository) });

    const result = await bootstrapWorkspace(deps);

    expect(result).toMatchObject({
      mode: "local-only",
      localRepository,
      recoverySuggested: false,
    });
    expect(deps.recoverSession).not.toHaveBeenCalled();
  });

  it("restores remote data before creating defaults on an empty install", async () => {
    const deps = dependencies();

    const result = await bootstrapWorkspace(deps);

    expect(result).toMatchObject({
      mode: "recovered",
      session,
      recoverySuggested: false,
    });
    expect(deps.saveRemote).toHaveBeenCalledWith("user-1", remote);
    expect(deps.createLocal).not.toHaveBeenCalled();
  });

  it("creates local defaults after an expected silent recovery miss", async () => {
    const miss = new ExtensionOAuthError("interaction_required", "interaction required");
    const deps = dependencies({
      recoverSession: vi.fn(async () => {
        throw miss;
      }),
    });

    const result = await bootstrapWorkspace(deps);

    expect(result).toMatchObject({
      mode: "reconnect-required",
      localRepository,
      recoverySuggested: true,
    });
    expect(deps.markRecoveryPending).toHaveBeenCalled();
  });

  it("does not silently recover after logout suppression", async () => {
    const deps = dependencies({ recoveryState: vi.fn(async () => "suppressed" as const) });

    const result = await bootstrapWorkspace(deps);

    expect(result).toMatchObject({
      mode: "local-only",
      recoverySuggested: false,
    });
    expect(deps.recoverSession).not.toHaveBeenCalled();
  });

  it("keeps a pending recovery eligible on a later focused launch", async () => {
    const deps = dependencies({
      openLocal: vi.fn(async () => localRepository),
      recoveryState: vi.fn(async () => "pending" as const),
    });

    const result = await bootstrapWorkspace(deps);

    expect(result).toMatchObject({
      mode: "local-only",
      recoverySuggested: true,
    });
  });

  it("uses normal local mode when Supabase is not configured", async () => {
    const deps = dependencies({ canRecover: () => false });

    const result = await bootstrapWorkspace(deps);

    expect(result).toMatchObject({
      mode: "local-only",
      recoverySuggested: false,
    });
    expect(deps.recoverSession).not.toHaveBeenCalled();
  });

  it("falls back locally while offline", async () => {
    const deps = dependencies({ isOnline: () => false });

    const result = await bootstrapWorkspace(deps);

    expect(result).toMatchObject({
      mode: "offline",
      localRepository,
      recoverySuggested: true,
    });
    expect(deps.recoverSession).not.toHaveBeenCalled();
  });

  it("retains a stored session when the first remote read fails", async () => {
    const deps = dependencies({
      getStoredSession: vi.fn(async () => session),
      loadRemote: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });

    const result = await bootstrapWorkspace(deps);

    expect(result).toMatchObject({ mode: "offline", session });
  });
});
