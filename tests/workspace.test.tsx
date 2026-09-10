import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "../app/app/WorkspaceClient";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";
import { CombinedWorkspaceRepository, type BookmarkRepository } from "../shared/bookmark-repository";
import { mergeBookmarkEntries, toBookmarkWorkspace } from "../shared/bookmarks";
import type { CollectionShareRepository } from "../shared/collection-sharing";

function shareRepository(): CollectionShareRepository {
  return {
    get: vi.fn(async () => null),
    enable: vi.fn(async (collectionId) => ({ collectionId, token: "a".repeat(43), createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z" })),
    regenerate: vi.fn(),
    disable: vi.fn(),
  };
}

function combinedFixture() {
  const normalSnapshot = createDemoSnapshot("demo-user");
  const bookmarkSnapshot = toBookmarkWorkspace("demo-user", mergeBookmarkEntries(
    [{ id: "mac", device_name: "Work Mac", last_synced_at: "2026-08-27T12:00:00.000Z" }],
    [{ id: "bookmark-entry", source_id: "mac", chrome_bookmark_id: "chrome-docs", url: "https://developer.chrome.com/docs", normalized_url: "https://developer.chrome.com/docs", title: "Chrome docs", folder_path: "Work / Design", syncing: false, position: 0 }],
  ));
  const normal = new MemoryWorkspaceRepository("demo-user", normalSnapshot);
  const bookmarks: BookmarkRepository = {
    beginSync: vi.fn(), appendBatch: vi.fn(), finalizeSync: vi.fn(),
    loadWorkspace: vi.fn(async () => bookmarkSnapshot), listSources: vi.fn(async () => []),
    renameSource: vi.fn(), forgetSource: vi.fn(),
  };
  return { normal, repository: new CombinedWorkspaceRepository(normal, bookmarks), snapshot: { spaces: [...normalSnapshot.spaces, ...bookmarkSnapshot.spaces], collections: [...normalSnapshot.collections, ...bookmarkSnapshot.collections], links: [...normalSnapshot.links, ...bookmarkSnapshot.links] } };
}

beforeEach(() => localStorage.clear());

describe("WorkspaceClient", () => {
  it("opens live sharing for mutable synced collections", async () => {
    const sharing = shareRepository();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="synced" initialSnapshot={createDemoSnapshot()} sharing={{ availability: "ready", repository: sharing, siteUrl: "https://tabloom.nickvu.dev", onRequestSignIn: vi.fn() }} />);

    await userEvent.click(await screen.findByRole("button", { name: "Share Plan" }));

    expect(await screen.findByRole("dialog", { name: "Share Plan" })).toBeVisible();
    expect(sharing.get).toHaveBeenCalledWith("collection-plan");
  });

  it("does not offer sharing for browser bookmark collections", async () => {
    const user = userEvent.setup();
    const { repository, snapshot } = combinedFixture();
    render(<WorkspaceClient repository={repository} mode="synced" initialSnapshot={snapshot} sharing={{ availability: "ready", repository: shareRepository(), siteUrl: "https://tabloom.nickvu.dev", onRequestSignIn: vi.fn() }} />);

    expect(await screen.findByRole("button", { name: "Share Plan" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /Browser Bookmarks/ }));
    expect(screen.queryByRole("button", { name: "Share Work / Design" })).not.toBeInTheDocument();
  });

  it("routes local-only collection sharing to sign in without a remote read", async () => {
    const onRequestSignIn = vi.fn();
    const sharing = shareRepository();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" initialSnapshot={createDemoSnapshot()} sharing={{ availability: "sign-in-required", repository: null, siteUrl: "https://tabloom.nickvu.dev", onRequestSignIn }} />);

    await userEvent.click(await screen.findByRole("button", { name: "Share Plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign in to sync" }));

    expect(onRequestSignIn).toHaveBeenCalledOnce();
    expect(sharing.get).not.toHaveBeenCalled();
  });

  it("renders Browser Bookmarks without mutation controls", async () => {
    const user = userEvent.setup();
    const { repository, snapshot } = combinedFixture();
    render(<WorkspaceClient repository={repository} mode="synced" initialSnapshot={snapshot} />);
    await user.click(await screen.findByRole("button", { name: /Browser Bookmarks/ }));
    expect(await screen.findByText("Only on Work Mac")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Delete Work \/ Design/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New collection" })).not.toBeInTheDocument();
  });

  it("keeps synced bookmarks read-only without browser copy controls", async () => {
    const { repository, snapshot } = combinedFixture();
    render(<WorkspaceClient repository={repository} mode="synced" initialSnapshot={snapshot} />);
    await userEvent.click(await screen.findByRole("button", { name: /Browser Bookmarks/ }));
    expect(await screen.findByText("Chrome docs")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Drag Chrome docs" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Plan copy target" })).toBeNull();
  });

  it("filters links from the global search field", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getByRole("button", { name: "Search all links" }));
    await user.type(screen.getByRole("searchbox"), "figma");
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Brand system")).toBeInTheDocument();
    expect(dialog.queryByText("Product roadmap")).not.toBeInTheDocument();
  });

  it("creates a valid link in the selected collection", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getByRole("button", { name: "Add link to Plan" }));
    await user.type(screen.getByLabelText("Title"), "Reference");
    await user.clear(screen.getByLabelText("URL"));
    await user.type(screen.getByLabelText("URL"), "https://example.com/reference");
    await user.click(screen.getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(screen.getByText("Reference")).toBeInTheDocument());
  });

  it("rejects unsupported link protocols", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getByRole("button", { name: "Add link to Plan" }));
    await user.type(screen.getByLabelText("Title"), "Unsafe");
    await user.clear(screen.getByLabelText("URL"));
    await user.type(screen.getByLabelText("URL"), "chrome://settings");
    await user.click(screen.getByRole("button", { name: "Save link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("http");
  });

  it("renames spaces and collections", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    await user.click(screen.getByRole("button", { name: "Edit Product launch" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Launch HQ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findAllByText("Launch HQ")).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Rename Plan" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Strategy");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: "Rename Strategy" })).toBeInTheDocument();
  });

  it("moves links between collections with accessible controls", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
    const user = userEvent.setup();
    render(<WorkspaceClient repository={repository} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.selectOptions(screen.getByRole("combobox", { name: "Move Product roadmap to collection" }), "collection-design");
    await waitFor(async () => {
      const snapshot = await repository.load();
      expect(snapshot.links.find((link) => link.title === "Product roadmap")?.collection_id).toBe("collection-design");
    });
  });
});
