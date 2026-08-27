import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CollectionRows } from "../extension/CollectionRows";
import { createDemoSnapshot } from "../shared/domain";
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
  render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} />);
  return { repository, onReload };
}

const createDataTransfer = (types: string[] = []) => ({ effectAllowed: "none", dropEffect: "none", types, getData: () => "" });

describe("CollectionRows", () => {
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
    setup();
    const row = screen.getByRole("group", { name: "Plan collection" });
    const browserTabTransfer = createDataTransfer(["application/x-tabloom-tab"]);
    fireEvent.dragOver(row, { dataTransfer: browserTabTransfer });
    expect(browserTabTransfer.dropEffect).toBe("copy");

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
