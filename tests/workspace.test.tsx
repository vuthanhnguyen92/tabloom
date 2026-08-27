import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "../app/app/WorkspaceClient";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";
import { CombinedWorkspaceRepository, type BookmarkRepository } from "../shared/bookmark-repository";
import { mergeBookmarkEntries, toBookmarkWorkspace } from "../shared/bookmarks";

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

describe("WorkspaceClient", () => {
  it("renders Browser Bookmarks without mutation controls", async () => {
    const user = userEvent.setup();
    const { repository, snapshot } = combinedFixture();
    render(<WorkspaceClient repository={repository} mode="synced" initialSnapshot={snapshot} />);
    await user.click(screen.getByRole("button", { name: /Browser Bookmarks/ }));
    expect(await screen.findByText("Only on Work Mac")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Delete Work \/ Design/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New collection" })).not.toBeInTheDocument();
  });

  it("copies a dragged bookmark into a normal collection", async () => {
    const user = userEvent.setup();
    const { normal, repository, snapshot } = combinedFixture();
    render(<WorkspaceClient repository={repository} mode="synced" initialSnapshot={snapshot} />);
    await user.click(screen.getByRole("button", { name: /Browser Bookmarks/ }));
    const bookmark = await screen.findByText("Chrome docs");
    fireEvent.dragStart(bookmark.closest(".link-card")!);
    const target = screen.getByRole("group", { name: "Plan copy target" });
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    await waitFor(async () => {
      expect((await normal.load()).links.some((link) => link.collection_id === "collection-plan" && link.title === "Chrome docs")).toBe(true);
    });
  });

  it("filters links from the global search field", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.type(screen.getByLabelText("Search your links"), "figma");
    expect(screen.getByText("Brand system")).toBeInTheDocument();
    expect(screen.queryByText("Product roadmap")).not.toBeInTheDocument();
  });

  it("creates a valid link in the selected collection", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getAllByRole("button", { name: "Add link" })[0]);
    await user.type(screen.getByLabelText("Link title"), "Reference");
    await user.type(screen.getByLabelText("Link URL"), "https://example.com/reference");
    await user.click(screen.getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(screen.getByText("Reference")).toBeInTheDocument());
  });

  it("rejects unsupported link protocols", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getAllByRole("button", { name: "Add link" })[0]);
    await user.type(screen.getByLabelText("Link title"), "Unsafe");
    await user.clear(screen.getByLabelText("Link URL"));
    await user.type(screen.getByLabelText("Link URL"), "chrome://settings");
    await user.click(screen.getByRole("button", { name: "Save link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("http");
  });

  it("renames spaces and collections", async () => {
    const user = userEvent.setup();
    render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getByRole("button", { name: "Rename Product launch space" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Launch HQ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findAllByText("Launch HQ")).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Rename Plan collection" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Strategy");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Strategy")).toBeInTheDocument();
  });

  it("moves links between collections with accessible controls", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
    const user = userEvent.setup();
    render(<WorkspaceClient repository={repository} mode="demo" />);
    await screen.findByText("Product roadmap");
    await user.click(screen.getByRole("button", { name: "Move Product roadmap to next collection" }));
    await waitFor(async () => {
      const snapshot = await repository.load();
      expect(snapshot.links.find((link) => link.title === "Product roadmap")?.collection_id).toBe("collection-design");
    });
  });
});
