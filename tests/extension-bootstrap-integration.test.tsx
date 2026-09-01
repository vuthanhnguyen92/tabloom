import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBootstrapResult } from "../extension/workspace-bootstrap";

const mocks = vi.hoisted(() => ({
  bootstrapWorkspace: vi.fn(),
  storageState: {} as Record<string, unknown>,
}));

vi.mock("../extension/workspace-bootstrap", async (importOriginal) => ({
  ...await importOriginal<typeof import("../extension/workspace-bootstrap")>(),
  bootstrapWorkspace: mocks.bootstrapWorkspace,
}));

vi.mock("../extension/supabase", () => ({
  extensionSupabase: null,
  recoverExtensionSessionSilently: vi.fn(),
  signInExtensionWithGoogle: vi.fn(),
}));

vi.mock("../extension/browser", () => ({
  browserTarget: "chromium",
  browserAdapter: {
    target: "chromium",
    capabilities: { bookmarks: false, identity: true, tabGroups: false },
    storage: {
      get: vi.fn(async (key: string) => ({ [key]: mocks.storageState[key] })),
      set: vi.fn(async (value: Record<string, unknown>) => {
        Object.assign(mocks.storageState, value);
      }),
      remove: vi.fn(async (key: string) => {
        delete mocks.storageState[key];
      }),
    },
    storageChanges: { subscribe: vi.fn(() => () => undefined) },
    identity: {
      getRedirectURL: vi.fn((path = "") => `https://stable-id.chromiumapp.org/${path}`),
      launchWebAuthFlow: vi.fn(),
    },
    bookmarks: { getTree: vi.fn(async () => []) },
    favicons: { resolve: vi.fn(() => null) },
    permissions: { request: vi.fn(async () => false) },
    tabs: {
      listCurrentWindow: vi.fn(async () => []),
      openAndInspect: vi.fn(),
      activateExisting: vi.fn(),
      close: vi.fn(),
      openCollection: vi.fn(),
    },
  },
}));

import { ExtensionApp } from "../extension/src";

describe("ExtensionApp bootstrap", () => {
  beforeEach(() => {
    mocks.bootstrapWorkspace.mockReset();
    for (const key of Object.keys(mocks.storageState)) delete mocks.storageState[key];
  });

  it("keeps the boot boundary mounted until clean-install recovery resolves", async () => {
    const deferred = Promise.withResolvers<WorkspaceBootstrapResult>();
    mocks.bootstrapWorkspace.mockReturnValue(deferred.promise);

    render(<ExtensionApp />);

    expect(screen.getByRole("main", { name: "Restoring workspace" })).toBeVisible();
    expect(screen.queryByText("My Collection")).not.toBeInTheDocument();

    deferred.resolve({
      mode: "recovered",
      localRepository: null,
      session: { user: { id: "user-1" } },
      recoverySuggested: false,
    });

    await waitFor(() => {
      expect(screen.queryByRole("main", { name: "Restoring workspace" })).not.toBeInTheDocument();
    });
  });
});
