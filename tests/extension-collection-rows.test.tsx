import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CollectionRows } from "../extension/CollectionRows";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

function setup() {
  const snapshot = createDemoSnapshot();
  const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
  const onReload = vi.fn(async () => undefined);
  render(<CollectionRows collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={onReload} />);
  return { repository, onReload };
}

const dataTransfer = { effectAllowed: "none", dropEffect: "none" };

describe("CollectionRows", () => {
  it("renders each collection as a row containing compact link tiles", () => {
    setup();
    const rows = screen.getAllByRole("group", { name: /collection$/i });
    expect(rows).toHaveLength(3);
    expect(within(screen.getByRole("group", { name: "Plan collection" })).getAllByRole("link")).toHaveLength(3);
  });

  it("persists collection order when a row is dragged", async () => {
    const { repository, onReload } = setup();
    fireEvent.dragStart(screen.getByRole("group", { name: "Learn collection" }), { dataTransfer });
    fireEvent.dragOver(screen.getByRole("group", { name: "Plan collection" }), { dataTransfer });
    fireEvent.drop(screen.getByRole("group", { name: "Plan collection" }), { dataTransfer });

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    const snapshot = await repository.load();
    expect(snapshot.collections.sort((a, b) => a.position - b.position).map((item) => item.name)).toEqual(["Learn", "Plan", "Design"]);
  });

  it("persists link position and collection when a tile is dragged", async () => {
    const { repository, onReload } = setup();
    fireEvent.dragStart(screen.getByRole("link", { name: /Product roadmap/i }), { dataTransfer });
    fireEvent.dragOver(screen.getByRole("link", { name: /Brand system/i }), { dataTransfer });
    fireEvent.drop(screen.getByRole("link", { name: /Brand system/i }), { dataTransfer });

    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    const snapshot = await repository.load();
    const design = snapshot.links.filter((item) => item.collection_id === "collection-design").sort((a, b) => a.position - b.position);
    expect(design.map((item) => item.title)).toEqual(["Product roadmap", "Brand system", "Homepage explorations", "Prototype"]);
  });
});
