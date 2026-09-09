import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CollectionRows } from "../extension/CollectionRows";
import { createDemoSnapshot } from "../shared/domain";
import { mergeBookmarkEntries, toBookmarkWorkspace } from "../shared/bookmarks";
import { MemoryWorkspaceRepository } from "../shared/repository";
import type { CollectionShareRepository } from "../shared/collection-sharing";
import type { FaviconResolver } from "../extension/browser/types";
const extensionStyles = readFileSync("shared/organizer/organizer.css", "utf8") + readFileSync("extension/style.css", "utf8");

let styleElement: HTMLStyleElement;
beforeAll(() => {
  styleElement = document.createElement("style");
  styleElement.textContent = extensionStyles;
  document.head.appendChild(styleElement);
});
afterAll(() => styleElement.remove());

function setup() {
  const snapshot = createDemoSnapshot();
  const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
  const onReload = vi.fn(async () => undefined);
  const view = render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} />);
  return { repository, onReload, container: view.container };
}

function shareRepository(): CollectionShareRepository {
  return {
    get: vi.fn(async () => null),
    enable: vi.fn(async () => ({
      collectionId: "collection-plan",
      token: "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
    })),
    regenerate: vi.fn(),
    disable: vi.fn(),
  };
}

const createDataTransfer = (types: string[] = []) => ({ effectAllowed: "none", dropEffect: "none", types, getData: () => "" });

describe("CollectionRows", () => {
  it("does not paint expanded collections before stored collapse state is ready", async () => {
    const snapshot = createDemoSnapshot();
    let restore: (value: Set<string>) => void = () => undefined;
    const collapsePreference = {
      reconcile: vi.fn(() => new Promise<Set<string>>((resolve) => { restore = resolve; })),
      setCollapsed: vi.fn(async () => undefined),
    };
    render(<CollectionRows
      collapsePreference={collapsePreference}
      collapseScope="account:user-1"
      collections={snapshot.collections}
      links={snapshot.links}
      repository={new MemoryWorkspaceRepository("demo-user", snapshot)}
      onReload={vi.fn(async () => undefined)}
    />);

    expect(screen.queryByRole("group", { name: "Plan collection" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Restoring collection layout" })).toBeInTheDocument();

    restore(new Set(["collection-plan"]));

    expect(await screen.findByRole("button", { name: "Expand Plan" })).toBeVisible();
  });

  it("shows a saved-card favicon and falls back to its first letter when loading fails", () => {
    const snapshot = createDemoSnapshot();
    snapshot.links[0].favicon_url = "https://linear.app/favicon.ico";
    const resolveFavicon: FaviconResolver = vi.fn(({ pageUrl }) => `native-favicon:${pageUrl ?? ""}`);
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={new MemoryWorkspaceRepository("demo-user", snapshot)} onReload={vi.fn(async () => undefined)} resolveFavicon={resolveFavicon} />);

    const card = screen.getByRole("link", { name: /Product roadmap/i });
    const favicon = card.querySelector("img");
    expect(favicon).toHaveAttribute("src", "native-favicon:https://linear.app/roadmap");
    expect(resolveFavicon).toHaveBeenCalledWith({ pageUrl: "https://linear.app/roadmap", capturedUrl: "https://linear.app/favicon.ico", size: 32 });
    fireEvent.error(favicon!);
    expect(card.querySelector("img")).not.toBeInTheDocument();
    expect(within(card).getByText("P", { exact: true })).toBeVisible();
  });

  it("keeps saved-link cards click-first while showing a compact drag affordance", () => {
    setup();

    const card = screen.getByRole("link", { name: /Product roadmap/i });
    const indicator = screen.getByRole("button", { name: "Drag Product roadmap" });
    expect(getComputedStyle(card).cursor).toBe("pointer");
    expect(indicator).toBeInTheDocument();
    expect(getComputedStyle(indicator).pointerEvents).toBe("auto");
    expect(getComputedStyle(indicator).cursor).toBe("grab");
  });

  it("shows grabbing only on the handle after a saved-link drag starts", () => {
    setup();
    const card = screen.getByRole("link", { name: /Product roadmap/i });

    expect(getComputedStyle(card).cursor).toBe("pointer");
    const handle = screen.getByRole("button", { name: "Drag Product roadmap" });
    fireEvent.dragStart(handle, { dataTransfer: createDataTransfer() });

    expect(card).toHaveClass("dragging");
    expect(getComputedStyle(card).cursor).toBe("pointer");
    expect(getComputedStyle(handle).cursor).toBe("grabbing");
  });

  it("restores and toggles a collection's locally remembered collapsed state", async () => {
    const snapshot = createDemoSnapshot();
    const collapsePreference = {
      reconcile: vi.fn(async () => new Set(["collection-plan"])),
      setCollapsed: vi.fn(async () => undefined),
    };
    render(<CollectionRows
      collapsePreference={collapsePreference}
      collapseScope="account:user-1"
      collections={snapshot.collections}
      links={snapshot.links}
      repository={new MemoryWorkspaceRepository("demo-user", snapshot)}
      onReload={vi.fn(async () => undefined)}
    />);

    const toggle = await screen.findByRole("button", { name: "Expand Plan" });
    const collection = screen.getByRole("group", { name: "Plan collection" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.querySelector("svg")).toBeInTheDocument();
    expect(collection).toHaveClass("is-collapsed");
    expect(getComputedStyle(collection.querySelector(".collection-body")!).gridTemplateRows).toBe("0fr");

    await userEvent.click(toggle);

    expect(screen.getByRole("button", { name: "Collapse Plan" })).toHaveAttribute("aria-expanded", "true");
    expect(collection).not.toHaveClass("is-collapsed");
    expect(getComputedStyle(collection.querySelector(".collection-body")!).gridTemplateRows).toBe("1fr");
    expect(collapsePreference.setCollapsed).toHaveBeenCalledWith("account:user-1", "collection-plan", false);
  });

  it("renames an editable collection inline and persists the trimmed label", async () => {
    const { repository, onReload } = setup();

    await userEvent.click(screen.getByRole("button", { name: "Rename Plan" }));
    const input = screen.getByRole("textbox", { name: "Collection name for Plan" });
    await userEvent.clear(input);
    await userEvent.type(input, "  Product planning  {Enter}");

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    expect((await repository.load()).collections.find((item) => item.id === "collection-plan")?.name).toBe("Product planning");
  });

  it("updates the visible collection label optimistically while persistence is pending", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    let releaseUpdate: () => void = () => undefined;
    repository.updateCollection = vi.fn(() => new Promise<void>((resolve) => { releaseUpdate = resolve; }));
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={vi.fn(async () => undefined)} />);

    await userEvent.click(screen.getByRole("button", { name: "Rename Plan" }));
    const input = screen.getByRole("textbox", { name: "Collection name for Plan" });
    await userEvent.clear(input);
    await userEvent.type(input, "Product planning{Enter}");

    expect(screen.getByRole("group", { name: "Product planning collection" })).toBeInTheDocument();
    releaseUpdate();
  });

  it("cancels collection renaming with Escape and rejects an empty label", async () => {
    const { repository, onReload } = setup();

    await userEvent.click(screen.getByRole("button", { name: "Rename Plan" }));
    let input = screen.getByRole("textbox", { name: "Collection name for Plan" });
    await userEvent.clear(input);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Collection name for Plan" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Rename Plan" }));
    input = screen.getByRole("textbox", { name: "Collection name for Plan" });
    await userEvent.clear(input);
    await userEvent.keyboard("{Enter}");

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Collection name is required")).toBeVisible();
    expect(onReload).not.toHaveBeenCalled();
    expect((await repository.load()).collections.find((item) => item.id === "collection-plan")?.name).toBe("Plan");
  });

  it("keeps bookmark collections read-only instead of offering rename", () => {
    const normal = createDemoSnapshot();
    const bookmark = toBookmarkWorkspace("demo-user", mergeBookmarkEntries(
      [{ id: "mac", device_name: "Work Mac", last_synced_at: null }],
      [{ id: "entry", source_id: "mac", chrome_bookmark_id: "one", url: "https://example.com", normalized_url: "https://example.com/", title: "Browser example", folder_path: "Imported", syncing: false, position: 0 }],
    ));
    render(<CollectionRows collections={[normal.collections[0], bookmark.collections[0]]} links={[...normal.links, ...bookmark.links]} repository={new MemoryWorkspaceRepository("demo-user", normal)} onReload={vi.fn(async () => undefined)} />);

    expect(screen.getByRole("button", { name: "Rename Plan" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename Imported" })).not.toBeInTheDocument();
  });

  it("opens sharing from a mutable collection without changing its collapsed state", async () => {
    const snapshot = createDemoSnapshot();
    const repository = shareRepository();
    render(<CollectionRows
      collections={snapshot.collections}
      links={snapshot.links}
      repository={new MemoryWorkspaceRepository("demo-user", snapshot)}
      onReload={vi.fn(async () => undefined)}
      share={{
        availability: "ready",
        repository,
        siteUrl: "https://tabloom.nickvu.dev",
        onRequestSignIn: vi.fn(),
        onRequestSyncRetry: vi.fn(),
        onToast: vi.fn(),
      }}
    />);

    const shareButton = screen.getByRole("button", { name: "Share Plan" });
    expect(shareButton).toHaveAttribute("draggable", "false");
    await userEvent.click(shareButton);

    expect(await screen.findByRole("dialog", { name: "Share Plan" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse Plan" })).toHaveAttribute("aria-expanded", "true");
    expect(repository.get).toHaveBeenCalledWith("collection-plan");
  });

  it("keeps sharing visible without overlapping the collection controls", () => {
    const snapshot = createDemoSnapshot();
    render(<CollectionRows
      collections={snapshot.collections}
      links={snapshot.links}
      repository={new MemoryWorkspaceRepository("demo-user", snapshot)}
      onReload={vi.fn(async () => undefined)}
      share={{
        availability: "ready",
        repository: shareRepository(),
        siteUrl: "https://tabloom.nickvu.dev",
        onRequestSignIn: vi.fn(),
        onRequestSyncRetry: vi.fn(),
        onToast: vi.fn(),
      }}
    />);

    const shareButton = screen.getByRole("button", { name: "Share Plan" });
    const metadata = shareButton.closest<HTMLElement>(".ext-col-meta")!;
    const reorderActions = screen.getByRole("button", { name: "Move Plan down" }).closest<HTMLElement>(".collection-reorder-actions")!;

    expect(getComputedStyle(shareButton).position).toBe("static");
    expect(getComputedStyle(shareButton).opacity).toBe("1");
    expect(metadata).toContainElement(reorderActions);
    expect(getComputedStyle(reorderActions).right).toBe("calc(100% + 8px)");
  });

  it("never offers sharing for browser-bookmark collections", () => {
    const normal = createDemoSnapshot();
    const bookmark = toBookmarkWorkspace("demo-user", mergeBookmarkEntries(
      [{ id: "mac", device_name: "Work Mac", last_synced_at: null }],
      [{ id: "entry", source_id: "mac", chrome_bookmark_id: "one", url: "https://example.com", normalized_url: "https://example.com/", title: "Browser example", folder_path: "Imported", syncing: false, position: 0 }],
    ));
    render(<CollectionRows
      collections={[normal.collections[0], bookmark.collections[0]]}
      links={[normal.links[0], ...bookmark.links]}
      repository={new MemoryWorkspaceRepository("demo-user", normal)}
      onReload={vi.fn(async () => undefined)}
      share={{
        availability: "ready",
        repository: shareRepository(),
        siteUrl: "https://tabloom.nickvu.dev",
        onRequestSignIn: vi.fn(),
        onRequestSyncRetry: vi.fn(),
        onToast: vi.fn(),
      }}
    />);

    expect(screen.getByRole("button", { name: "Share Plan" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share Imported" })).not.toBeInTheDocument();
  });

  it("routes local-only sharing to sign-in without reading remote share state", async () => {
    const snapshot = createDemoSnapshot();
    const repository = shareRepository();
    const onRequestSignIn = vi.fn();
    render(<CollectionRows
      collections={[snapshot.collections[0]]}
      links={snapshot.links}
      repository={new MemoryWorkspaceRepository("demo-user", snapshot)}
      onReload={vi.fn(async () => undefined)}
      share={{
        availability: "sign-in-required",
        repository,
        siteUrl: "https://tabloom.nickvu.dev",
        onRequestSignIn,
        onRequestSyncRetry: vi.fn(),
        onToast: vi.fn(),
      }}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Share Plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign in to sync" }));

    expect(onRequestSignIn).toHaveBeenCalledOnce();
    expect(repository.get).not.toHaveBeenCalled();
  });

  it("keeps the optimistic collection label and reports a failed rename", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    repository.updateCollection = vi.fn(async () => { throw new Error("Failed to sync"); });
    const onError = vi.fn();
    const onReload = vi.fn(async () => undefined);
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onError={onError} onReload={onReload} />);

    await userEvent.click(screen.getByRole("button", { name: "Rename Plan" }));
    const input = screen.getByRole("textbox", { name: "Collection name for Plan" });
    await userEvent.clear(input);
    await userEvent.type(input, "Product planning{Enter}");

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Failed to sync"));
    expect(screen.getByRole("group", { name: "Product planning collection" })).toBeInTheDocument();
    expect(onReload).not.toHaveBeenCalled();
  });

  it("keeps the hidden collection delete action out of the header layout", () => {
    setup();

    const deleteButton = screen.getByRole("button", { name: "Delete Plan" });
    const metadata = deleteButton.closest(".ext-col-meta");

    expect(getComputedStyle(metadata!).position).toBe("relative");
    expect(getComputedStyle(deleteButton).position).toBe("absolute");
    expect(getComputedStyle(deleteButton).right).toBe("0px");
  });

  it("edits a saved-link title and subtitle with an optimistic card update", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    let releaseUpdate: () => void = () => undefined;
    repository.updateLink = vi.fn(() => new Promise<void>((resolve) => { releaseUpdate = resolve; }));
    const onReload = vi.fn(async () => undefined);
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} />);

    await userEvent.hover(screen.getByRole("link", { name: /Product roadmap/i }).closest(".ext-link-card")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit Product roadmap" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Product roadmap" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    const subtitle = within(dialog).getByRole("textbox", { name: "Subtitle" });
    expect(title).toHaveValue("Product roadmap");
    expect(subtitle).toHaveValue("");

    await userEvent.clear(title);
    await userEvent.type(title, "  Product direction  ");
    await userEvent.type(subtitle, "  Q4 priorities  ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(screen.queryByRole("dialog", { name: "Edit Product roadmap" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Product direction/i })).toHaveTextContent("Q4 priorities");
    expect(repository.updateLink).toHaveBeenCalledWith("link-0", { title: "Product direction", description: "Q4 priorities" });
    expect(onReload).not.toHaveBeenCalled();

    releaseUpdate();
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
  });

  it("falls back to the hostname when a saved-link subtitle is blank", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    let releaseUpdate: () => void = () => undefined;
    repository.updateLink = vi.fn(() => new Promise<void>((resolve) => { releaseUpdate = resolve; }));
    const onReload = vi.fn(async () => undefined);
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} />);

    await userEvent.hover(screen.getByRole("link", { name: /Brand system/i }).closest(".ext-link-card")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit Brand system" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Brand system" });
    const subtitle = within(dialog).getByRole("textbox", { name: "Subtitle" });
    expect(subtitle).toHaveValue("Figma assets for launch");
    await userEvent.clear(subtitle);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(screen.getByRole("link", { name: /Brand system/i })).toHaveTextContent("figma.com");
    releaseUpdate();
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
  });

  it("rejects an empty saved-link title and cancels editing with Escape", async () => {
    const { repository, onReload } = setup();

    await userEvent.hover(screen.getByRole("link", { name: /Product roadmap/i }).closest(".ext-link-card")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit Product roadmap" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Product roadmap" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    await userEvent.clear(title);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByText("Title is required")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Edit Product roadmap" })).not.toBeInTheDocument();
    expect(onReload).not.toHaveBeenCalled();
    expect((await repository.load()).links.find((item) => item.id === "link-0")?.title).toBe("Product roadmap");
  });

  it("offers card editing only for mutable saved links", () => {
    const normal = createDemoSnapshot();
    const bookmark = toBookmarkWorkspace("demo-user", mergeBookmarkEntries(
      [{ id: "mac", device_name: "Work Mac", last_synced_at: null }],
      [{ id: "entry", source_id: "mac", chrome_bookmark_id: "one", url: "https://example.com", normalized_url: "https://example.com/", title: "Browser example", folder_path: "Imported", syncing: false, position: 0 }],
    ));
    render(<CollectionRows collections={[normal.collections[0], bookmark.collections[0]]} links={[normal.links[0], ...bookmark.links]} repository={new MemoryWorkspaceRepository("demo-user", normal)} onReload={vi.fn(async () => undefined)} />);

    expect(screen.getByRole("button", { name: "Edit Product roadmap" })).toHaveAttribute("draggable", "false");
    expect(screen.queryByRole("button", { name: "Edit Browser example" })).not.toBeInTheDocument();
  });

  it("keeps an optimistic card edit visible when persistence fails", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    repository.updateLink = vi.fn(async () => { throw new Error("Failed to sync"); });
    const onError = vi.fn();
    const onReload = vi.fn(async () => undefined);
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onError={onError} onReload={onReload} />);

    await userEvent.hover(screen.getByRole("link", { name: /Product roadmap/i }).closest(".ext-link-card")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit Product roadmap" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Product roadmap" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    await userEvent.clear(title);
    await userEvent.type(title, "Product direction");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Failed to sync"));
    expect(screen.getByRole("link", { name: /Product direction/i })).toBeVisible();
    expect(onReload).not.toHaveBeenCalled();
  });

  it("asks for confirmation before deleting a saved-link card", async () => {
    const { repository } = setup();

    fireEvent.click(screen.getByRole("button", { name: "Delete Product roadmap" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Product roadmap link" });
    expect(dialog).toHaveTextContent("The saved link will be permanently removed");

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Delete Product roadmap link" })).not.toBeInTheDocument();
    expect((await repository.load()).links.some((item) => item.title === "Product roadmap")).toBe(true);
  });

  it("deletes a saved-link card after confirmation", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const onReload = vi.fn(async () => undefined);
    const onMessage = vi.fn();
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} onMessage={onMessage} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete Product roadmap" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete link permanently" }));

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    expect((await repository.load()).links.some((item) => item.title === "Product roadmap")).toBe(false);
    expect(onMessage).toHaveBeenCalledWith("Product roadmap deleted");
  });

  it("animates a saved-link card out before reloading its collection", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = createDemoSnapshot();
      const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
      const onReload = vi.fn(async () => undefined);
      render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} />);

      fireEvent.click(screen.getByRole("button", { name: "Delete Product roadmap" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete link permanently" }));

      expect(screen.queryByRole("dialog", { name: "Delete Product roadmap link" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Product roadmap/i }).closest(".ext-link-card")).toHaveClass("is-removing");
      expect(onReload).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(onReload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders bookmark collections as locked and bookmark cards as copy drag sources", () => {
    const normal = createDemoSnapshot();
    const bookmark = toBookmarkWorkspace("demo-user", mergeBookmarkEntries(
      [{ id: "mac", device_name: "Work Mac", last_synced_at: "2026-08-27T12:00:00.000Z" }],
      [{ id: "entry", source_id: "mac", chrome_bookmark_id: "one", url: "https://example.com", normalized_url: "https://example.com/", title: "Browser example", folder_path: "Imported", syncing: false, position: 0 }],
    ));
    const onBookmarkDrop = vi.fn(async () => undefined);
    render(<CollectionRows
      collections={[normal.collections[0], bookmark.collections[0]]}
      links={[...normal.links.filter((link) => link.collection_id === normal.collections[0].id), ...bookmark.links]}
      allLinks={[...normal.links, ...bookmark.links]}
      repository={new MemoryWorkspaceRepository("demo-user", normal)}
      onReload={vi.fn(async () => undefined)}
      onBookmarkDrop={onBookmarkDrop}
    />);
    const locked = screen.getByRole("group", { name: "Imported collection" });
    expect(locked).toHaveClass("read-only");
    expect(locked).toHaveAttribute("draggable", "false");
    expect(screen.getByText("Only on Work Mac")).toBeVisible();
    const bookmarkCard = screen.getByRole("link", { name: /Browser example/i });
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(bookmarkCard, { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("copy");
    fireEvent.dragOver(screen.getByRole("group", { name: "Plan collection" }), { dataTransfer });
    expect(screen.getByRole("group", { name: "Plan collection" })).toHaveClass("bookmark-drop-target");
  });

  it("asks for confirmation before deleting an editable collection", async () => {
    const normal = createDemoSnapshot();
    const bookmark = toBookmarkWorkspace("demo-user", mergeBookmarkEntries(
      [{ id: "mac", device_name: "Work Mac", last_synced_at: null }],
      [{ id: "entry", source_id: "mac", chrome_bookmark_id: "one", url: "https://example.com", normalized_url: "https://example.com/", title: "Browser example", folder_path: "Imported", syncing: false, position: 0 }],
    ));
    const repository = new MemoryWorkspaceRepository("demo-user", normal);
    render(<CollectionRows
      collections={[...normal.collections, bookmark.collections[0]]}
      links={[...normal.links, ...bookmark.links]}
      repository={repository}
      onReload={vi.fn(async () => undefined)}
    />);

    expect(screen.queryByRole("button", { name: "Delete Imported" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete Plan" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Plan" });
    expect(dialog).toHaveTextContent("3 saved links");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Delete Plan" })).not.toBeInTheDocument();
    expect((await repository.load()).collections.some((item) => item.id === "collection-plan")).toBe(true);
  });

  it("deletes a confirmed collection and all of its saved links", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const onReload = vi.fn(async () => undefined);
    const onMessage = vi.fn();
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} onMessage={onMessage} />);

    await userEvent.click(screen.getByRole("button", { name: "Delete Plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete collection permanently" }));

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    const remaining = await repository.load();
    expect(remaining.collections.some((item) => item.id === "collection-plan")).toBe(false);
    expect(remaining.links.some((item) => item.collection_id === "collection-plan")).toBe(false);
    expect(onMessage).toHaveBeenCalledWith("Plan deleted");
  });

  it("collapses a collection before reloading the workspace", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = createDemoSnapshot();
      const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
      const onReload = vi.fn(async () => undefined);
      render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} />);

      fireEvent.click(screen.getByRole("button", { name: "Delete Plan" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete collection permanently" }));

      expect(screen.queryByRole("dialog", { name: "Delete Plan" })).not.toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Plan collection" })).toHaveClass("is-removing");
      expect(onReload).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(onReload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the confirmation open when collection deletion fails", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    repository.deleteCollection = vi.fn(async () => { throw "offline"; });
    const onError = vi.fn();
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onError={onError} onReload={vi.fn(async () => undefined)} />);

    await userEvent.click(screen.getByRole("button", { name: "Delete Plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete collection permanently" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not delete Plan."));
    expect(screen.getByRole("dialog", { name: "Delete Plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete collection permanently" })).toBeEnabled();
  });

  it("copies a dragged bookmark only into a normal collection", async () => {
    const normal = createDemoSnapshot();
    const bookmark = toBookmarkWorkspace("demo-user", mergeBookmarkEntries(
      [{ id: "mac", device_name: "Work Mac", last_synced_at: null }],
      [{ id: "entry", source_id: "mac", chrome_bookmark_id: "one", url: "https://example.com", normalized_url: "https://example.com/", title: "Browser example", folder_path: "Imported", syncing: null, position: 0 }],
    ));
    const onBookmarkDrop = vi.fn(async () => undefined);
    const onReload = vi.fn(async () => undefined);
    render(<CollectionRows
      collections={[normal.collections[0], bookmark.collections[0]]}
      links={[...normal.links.filter((link) => link.collection_id === normal.collections[0].id), ...bookmark.links]}
      allLinks={[...normal.links, ...bookmark.links]}
      repository={new MemoryWorkspaceRepository("demo-user", normal)}
      onReload={onReload}
      onBookmarkDrop={onBookmarkDrop}
    />);
    const transfer = createDataTransfer();
    fireEvent.dragStart(screen.getByRole("link", { name: /Browser example/i }), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("group", { name: "Imported collection" }), { dataTransfer: transfer });
    expect(onBookmarkDrop).not.toHaveBeenCalled();
    fireEvent.dragStart(screen.getByRole("link", { name: /Browser example/i }), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("group", { name: "Plan collection" }), { dataTransfer: transfer });
    await waitFor(() => expect(onBookmarkDrop).toHaveBeenCalledWith(expect.objectContaining({ title: "Browser example" }), "collection-plan"));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("reveals normal collection targets while dragging from the bookmark-only space", async () => {
    const normal = createDemoSnapshot();
    const bookmark = toBookmarkWorkspace("demo-user", mergeBookmarkEntries(
      [{ id: "mac", device_name: "Work Mac", last_synced_at: null }],
      [{ id: "entry", source_id: "mac", chrome_bookmark_id: "one", url: "https://example.com", normalized_url: "https://example.com/", title: "Browser example", folder_path: "Imported", syncing: false, position: 0 }],
    ));
    const onBookmarkDrop = vi.fn(async () => undefined);
    render(<CollectionRows
      collections={bookmark.collections}
      links={bookmark.links}
      allLinks={[...normal.links, ...bookmark.links]}
      bookmarkDropCollections={[normal.collections[0]]}
      repository={new MemoryWorkspaceRepository("demo-user", normal)}
      onReload={vi.fn(async () => undefined)}
      onBookmarkDrop={onBookmarkDrop}
    />);
    const transfer = createDataTransfer();
    fireEvent.dragStart(screen.getByRole("link", { name: /Browser example/i }), { dataTransfer: transfer });
    const target = screen.getByRole("group", { name: "Plan copy target" });
    expect(target).toBeVisible();
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    await waitFor(() => expect(onBookmarkDrop).toHaveBeenCalledWith(expect.objectContaining({ title: "Browser example" }), "collection-plan"));
  });

  it("renders each collection as a row containing compact link tiles", () => {
    setup();
    const rows = screen.getAllByRole("group", { name: /collection$/i });
    expect(rows).toHaveLength(3);
    expect(within(screen.getByRole("group", { name: "Plan collection" })).getAllByRole("link")).toHaveLength(3);
  });

  it("renders saved-link card titles at font weight 500", () => {
    setup();
    const rules = Array.from(styleElement.sheet!.cssRules) as CSSStyleRule[];
    const rule = rules.find((item) => item.selectorText?.split(", ").includes(".ext-link-card > a b") && item.style.fontWeight);
    expect(rule?.style.fontWeight).toBe("500");
  });

  it("passes the collection name and ordered links to Open all", async () => {
    const snapshot = createDemoSnapshot();
    const onOpenCollection = vi.fn(async () => undefined);
    render(<CollectionRows
      collections={snapshot.collections}
      links={snapshot.links}
      onOpenCollection={onOpenCollection}
      repository={new MemoryWorkspaceRepository("demo-user", snapshot)}
      onReload={vi.fn(async () => undefined)}
    />);

    await userEvent.click(within(screen.getByRole("group", { name: "Plan collection" })).getByRole("button", { name: "Open all" }));

    expect(onOpenCollection).toHaveBeenCalledOnce();
    expect(onOpenCollection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "collection-plan", name: "Plan" }),
      [
        expect.objectContaining({ title: "Product roadmap" }),
        expect.objectContaining({ title: "Customer brief" }),
        expect.objectContaining({ title: "Launch checklist" }),
      ],
    );
  });

  it("reveals collection drop zones while a saved-link card is dragged", () => {
    const { container } = setup();
    const source = screen.getByRole("link", { name: /Product roadmap/i });
    fireEvent.dragStart(source, { dataTransfer: createDataTransfer() });

    expect(container.querySelector(".ext-columns")).toHaveClass("link-dragging");
    expect(source).toHaveClass("dragging");
  });

  it("reveals saved-card drop zones while a current tab is dragged", () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const view = render(<CollectionRows browserTabDragSession={1} collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={vi.fn(async () => undefined)} />);

    expect(view.container.querySelector(".ext-columns")).toHaveClass("browser-tab-dragging");
    expect(view.container.querySelector(".ext-link-drop-preview")).not.toBeInTheDocument();
  });

  it("highlights the hovered collection for a current tab and clears on drag end", () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const view = render(<CollectionRows browserTabDragSession={4} collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={vi.fn(async () => undefined)} />);
    const target = screen.getByRole("group", { name: "Design collection" });
    fireEvent.dragOver(target, { dataTransfer: createDataTransfer(["application/x-tabloom-tab"]) });

    expect(target).toHaveClass("drop-target");
    expect(view.container.querySelector(".ext-link-drop-preview")).not.toBeInTheDocument();
    view.rerender(<CollectionRows browserTabDragSession={0} collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={vi.fn(async () => undefined)} />);
    expect(target).not.toHaveClass("drop-target");
    expect(view.container.querySelector(".ext-columns")).not.toHaveClass("browser-tab-dragging");
  });

  it("inserts a preview before the hovered card without persisting", async () => {
    const { repository, onReload } = setup();
    const source = screen.getByRole("link", { name: /Product roadmap/i });
    const target = screen.getByRole("link", { name: /Brand system/i });
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });

    const grid = screen.getByRole("group", { name: "Design collection" }).querySelector(".ext-link-grid")!;
    expect(grid.children[0]).toHaveClass("ext-link-drop-preview");
    expect(grid.children[1]).toBe(target.closest(".ext-link-card"));
    expect(onReload).not.toHaveBeenCalled();
    expect((await repository.load()).links.find((link) => link.title === "Product roadmap")?.collection_id).toBe("collection-plan");
  });

  it("previews an end-of-collection drop and clears it when dragging ends", () => {
    const { container } = setup();
    const source = screen.getByRole("link", { name: /Product roadmap/i });
    const targetCollection = screen.getByRole("group", { name: "Design collection" });
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(targetCollection, { dataTransfer });

    const grid = targetCollection.querySelector(".ext-link-grid")!;
    expect(grid.lastElementChild).toHaveClass("ext-link-drop-preview");
    fireEvent.dragEnd(source, { dataTransfer });
    expect(container.querySelector(".ext-link-drop-preview")).not.toBeInTheDocument();
    expect(container.querySelector(".ext-columns")).not.toHaveClass("link-dragging");
  });

  it("persists collection order when a row is dragged", async () => {
    const { repository, onReload } = setup();
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(screen.getByRole("group", { name: "Learn collection" }), { dataTransfer });
    fireEvent.dragOver(screen.getByRole("group", { name: "Plan collection" }), { dataTransfer });
    fireEvent.drop(screen.getByRole("group", { name: "Plan collection" }), { dataTransfer });

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    const snapshot = await repository.load();
    expect(snapshot.collections.sort((a, b) => a.position - b.position).map((item) => item.name)).toEqual(["Learn", "Plan", "Design"]);
  });

  it("shows an insertion marker and shifts collection rows before drop", () => {
    const { container, onReload } = setup();
    const source = screen.getByRole("group", { name: "Learn collection" });
    const target = screen.getByRole("group", { name: "Plan collection" });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 100, height: 100, bottom: 200, left: 0, right: 600, width: 600, x: 0, y: 100, toJSON: () => ({}) });
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { clientY: 120, dataTransfer });

    const preview = container.querySelector(".collection-drop-preview");
    expect(preview).toBeInTheDocument();
    expect(source).toHaveClass("collection-dragging");
    expect(getComputedStyle(source).opacity).toBe("0.38");
    expect(getComputedStyle(preview!).height).toBe("28px");
    expect(screen.getAllByRole("group", { name: /collection$/i }).map((row) => row.getAttribute("aria-label"))).toEqual([
      "Learn collection",
      "Plan collection",
      "Design collection",
    ]);
    expect(onReload).not.toHaveBeenCalled();

    fireEvent.dragEnd(source, { dataTransfer });
    expect(container.querySelector(".collection-drop-preview")).not.toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: /collection$/i }).map((row) => row.getAttribute("aria-label"))).toEqual([
      "Plan collection",
      "Design collection",
      "Learn collection",
    ]);
  });

  it("uses the pointer midpoint to preview and persist an after-target collection drop", async () => {
    const { repository, onReload } = setup();
    const source = screen.getByRole("group", { name: "Plan collection" });
    const target = screen.getByRole("group", { name: "Design collection" });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 100, height: 100, bottom: 200, left: 0, right: 600, width: 600, x: 0, y: 100, toJSON: () => ({}) });
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(source, { dataTransfer });
    const dragOver = createEvent.dragOver(target, { dataTransfer });
    Object.defineProperty(dragOver, "clientY", { value: 180 });
    fireEvent(target, dragOver);

    expect(screen.getAllByRole("group", { name: /collection$/i }).map((row) => row.getAttribute("aria-label"))).toEqual([
      "Design collection",
      "Plan collection",
      "Learn collection",
    ]);

    fireEvent.drop(target, { clientY: 180, dataTransfer });
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    expect((await repository.load()).collections.sort((a, b) => a.position - b.position).map((item) => item.name)).toEqual(["Design", "Plan", "Learn"]);
  });

  it("supports keyboard collection reordering with move actions", async () => {
    const { repository, onReload } = setup();
    const design = screen.getByRole("group", { name: "Design collection" });
    const moveUp = within(design).getByRole("button", { name: "Move Design up" });
    expect(getComputedStyle(moveUp.closest(".collection-reorder-actions")!).top).toBe("15px");

    moveUp.focus();
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    expect((await repository.load()).collections.sort((a, b) => a.position - b.position).map((item) => item.name)).toEqual(["Design", "Plan", "Learn"]);
  });

  it("persists link position and collection when a tile is dragged", async () => {
    const { repository, onReload } = setup();
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(screen.getByRole("link", { name: /Product roadmap/i }), { dataTransfer });
    fireEvent.dragOver(screen.getByRole("link", { name: /Brand system/i }), { dataTransfer });
    fireEvent.drop(screen.getByRole("link", { name: /Brand system/i }), { dataTransfer });

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    const snapshot = await repository.load();
    const design = snapshot.links.filter((item) => item.collection_id === "collection-design").sort((a, b) => a.position - b.position);
    expect(design.map((item) => item.title)).toEqual(["Product roadmap", "Brand system", "Homepage explorations", "Prototype"]);
  });

  it("warns before moving a saved link into a collection containing the same URL", async () => {
    const snapshot = createDemoSnapshot();
    const product = snapshot.links.find((link) => link.title === "Product roadmap")!;
    snapshot.links.push({ ...product, id: "duplicate-product", collection_id: "collection-design", position: 3 });
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const onReload = vi.fn(async () => undefined);
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} />);
    const source = within(screen.getByRole("group", { name: "Plan collection" })).getByRole("link", { name: /Product roadmap/i });
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.drop(screen.getByRole("group", { name: "Design collection" }), { dataTransfer });

    expect(await screen.findByRole("dialog", { name: "Duplicate link" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Design collection" })).getByRole("link", { name: /Product roadmap/i })).toHaveClass("duplicate-highlight");
    expect((await repository.load()).links.find((link) => link.id === product.id)?.collection_id).toBe("collection-plan");
    await userEvent.click(screen.getByRole("button", { name: "Cancel move" }));
    expect(screen.queryByRole("dialog", { name: "Duplicate link" })).not.toBeInTheDocument();
    expect(onReload).not.toHaveBeenCalled();
  });

  it("allows an intentional duplicate move after confirmation", async () => {
    const snapshot = createDemoSnapshot();
    const product = snapshot.links.find((link) => link.title === "Product roadmap")!;
    snapshot.links.push({ ...product, id: "duplicate-product", collection_id: "collection-design", position: 3 });
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const onReload = vi.fn(async () => undefined);
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} />);
    const source = within(screen.getByRole("group", { name: "Plan collection" })).getByRole("link", { name: /Product roadmap/i });
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.drop(screen.getByRole("group", { name: "Design collection" }), { dataTransfer });
    await userEvent.click(await screen.findByRole("button", { name: "Move anyway" }));

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    expect((await repository.load()).links.find((link) => link.id === product.id)?.collection_id).toBe("collection-design");
  });

  it("can highlight an existing saved card for a duplicate current tab", () => {
    const snapshot = createDemoSnapshot();
    const product = snapshot.links.find((link) => link.title === "Product roadmap")!;
    render(<CollectionRows collections={snapshot.collections} highlightedLinkId={product.id} links={snapshot.links} repository={new MemoryWorkspaceRepository("demo-user", snapshot)} onReload={vi.fn(async () => undefined)} />);
    expect(within(screen.getByRole("group", { name: "Plan collection" })).getByRole("link", { name: /Product roadmap/i })).toHaveClass("duplicate-highlight");
  });

  it("reorders link tiles within the same collection", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const onReload = vi.fn(async () => undefined);
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} />);
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(screen.getByRole("link", { name: /Launch checklist/i }), { dataTransfer });
    fireEvent.drop(screen.getByRole("link", { name: /Product roadmap/i }), { dataTransfer });
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    const plan = (await repository.load()).links.filter((item) => item.collection_id === "collection-plan").sort((a, b) => a.position - b.position);
    expect(plan.map((item) => item.title)).toEqual(["Launch checklist", "Product roadmap", "Customer brief"]);
  });

  it("routes a current browser tab drop to its target collection", () => {
    const snapshot = createDemoSnapshot();
    const onBrowserTabDrop = vi.fn();
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={new MemoryWorkspaceRepository("demo-user", snapshot)} onReload={vi.fn(async () => undefined)} onBrowserTabDrop={onBrowserTabDrop} />);
    const payload = JSON.stringify({ id: 73, title: "Current tab", url: "https://example.com", saveable: true, selected: true });
    fireEvent.drop(screen.getByRole("group", { name: "Design collection" }), { dataTransfer: { getData: () => payload } });
    expect(onBrowserTabDrop).toHaveBeenCalledWith(expect.objectContaining({ id: 73, title: "Current tab" }), "collection-design");
  });

  it("negotiates copy for a current browser tab and move for saved items", () => {
    const { container } = setup();
    const row = screen.getByRole("group", { name: "Plan collection" });
    const browserTabTransfer = createDataTransfer(["application/x-tabloom-tab"]);
    fireEvent.dragOver(row, { dataTransfer: browserTabTransfer });
    expect(browserTabTransfer.dropEffect).toBe("copy");
    expect(container.querySelector(".ext-link-drop-preview")).not.toBeInTheDocument();

    const savedItemTransfer = createDataTransfer();
    fireEvent.dragOver(row, { dataTransfer: savedItemTransfer });
    expect(savedItemTransfer.dropEffect).toBe("move");
  });

  it("uses all links when reordering a filtered result", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const onReload = vi.fn(async () => undefined);
    const visibleLinks = snapshot.links.filter((link) => link.title !== "Customer brief");
    render(<CollectionRows collections={snapshot.collections} links={visibleLinks} allLinks={snapshot.links} repository={repository} onReload={onReload} />);
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(screen.getByRole("link", { name: /Launch checklist/i }), { dataTransfer });
    fireEvent.drop(screen.getByRole("link", { name: /Product roadmap/i }), { dataTransfer });

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    const plan = (await repository.load()).links.filter((item) => item.collection_id === "collection-plan").sort((a, b) => a.position - b.position);
    expect(plan.map((item) => item.title)).toEqual(["Launch checklist", "Product roadmap", "Customer brief"]);
    expect(plan.map((item) => item.position)).toEqual([0, 1, 2]);
  });
});
