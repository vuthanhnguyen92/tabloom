import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBootstrapResult } from "../extension/workspace-bootstrap";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

const mocks = vi.hoisted(() => ({
  bootstrapWorkspace: vi.fn(),
  openAndInspect: vi.fn(),
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
    tabChanges: { subscribe: vi.fn(() => () => undefined) },
    identity: {
      getRedirectURL: vi.fn((path = "") => `https://stable-id.chromiumapp.org/${path}`),
      launchWebAuthFlow: vi.fn(),
    },
    bookmarks: { getTree: vi.fn(async () => []) },
    favicons: { resolve: vi.fn(() => null) },
    permissions: { request: vi.fn(async () => false) },
    tabs: {
      listCurrentWindow: vi.fn(async () => []),
      openAndInspect: mocks.openAndInspect,
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
    mocks.openAndInspect.mockReset();
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

  it("leaves saved-card clicks to native current-tab and modifier-key browser behavior", async () => {
    const snapshot = createDemoSnapshot();
    mocks.bootstrapWorkspace.mockResolvedValue({
      mode: "local-only",
      localRepository: new MemoryWorkspaceRepository("local-user", snapshot),
      session: null,
      recoverySuggested: false,
    });

    render(<ExtensionApp />);
    const card = await screen.findByRole("link", { name: /Product roadmap/i });
    let regularClickWasPrevented = false;
    document.addEventListener("click", (event) => {
      regularClickWasPrevented = event.defaultPrevented;
      event.preventDefault();
    }, { once: true });
    const regularClick = createEvent.click(card, { button: 0 });
    fireEvent(card, regularClick);
    let commandClickWasPrevented = false;
    document.addEventListener("click", (event) => {
      commandClickWasPrevented = event.defaultPrevented;
      event.preventDefault();
    }, { once: true });
    const commandClick = createEvent.click(card, { button: 0, metaKey: true });
    fireEvent(card, commandClick);

    expect(regularClickWasPrevented).toBe(false);
    expect(commandClickWasPrevented).toBe(false);
    expect(mocks.openAndInspect).not.toHaveBeenCalled();
  });

  it("routes sharing from a local collection into the existing sign-in modal", async () => {
    const snapshot = createDemoSnapshot();
    mocks.bootstrapWorkspace.mockResolvedValue({
      mode: "local-only",
      localRepository: new MemoryWorkspaceRepository("local-user", snapshot),
      session: null,
      recoverySuggested: false,
    });

    render(<ExtensionApp />);
    await userEvent.click(await screen.findByRole("button", { name: "Share Plan" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Share Plan" })).getByRole("button", { name: "Sign in to sync" }));

    expect(screen.getByRole("dialog", { name: "Sync with Tabloom" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Share Plan" })).not.toBeInTheDocument();
  });
});
