import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CollectionRows } from "../extension/CollectionRows";
import { createDemoSnapshot } from "../shared/domain";
import { mergeBookmarkEntries, toBookmarkWorkspace } from "../shared/bookmarks";
import { MemoryWorkspaceRepository } from "../shared/repository";
const extensionStyles = readFileSync("extension/style.css", "utf8");

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

const createDataTransfer = (types: string[] = []) => ({ effectAllowed: "none", dropEffect: "none", types, getData: () => "" });

describe("CollectionRows", () => {
  it("shows a saved-card favicon and falls back to its first letter when loading fails", () => {
    const snapshot = createDemoSnapshot();
    snapshot.links[0].favicon_url = "https://linear.app/favicon.ico";
    render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={new MemoryWorkspaceRepository("demo-user", snapshot)} onReload={vi.fn(async () => undefined)} />);

    const card = screen.getByRole("link", { name: /Product roadmap/i });
    const favicon = card.querySelector("img");
    expect(favicon).toHaveAttribute("src", "https://linear.app/favicon.ico");
    fireEvent.error(favicon!);
    expect(card.querySelector("img")).not.toBeInTheDocument();
    expect(within(card).getByText("P", { exact: true })).toBeVisible();
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
    const rule = rules.find((item) => item.selectorText?.split(", ").includes(".ext-link-grid > a b") && item.style.fontWeight);
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
    expect(grid.children[1]).toBe(target);
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
