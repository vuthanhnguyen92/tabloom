import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CollectionList } from "../shared/organizer/CollectionList";
import { CollectionSection } from "../shared/organizer/CollectionSection";
import { SavedLinkCard } from "../shared/organizer/SavedLinkCard";
import { previewCollectionDrop, previewLinkDrop, previewLinkTransfer } from "../shared/organizer/drag-model";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

const snapshot = createDemoSnapshot();
const link = snapshot.links[0];
let style: HTMLStyleElement;
beforeAll(() => {
  style = document.createElement("style");
  style.textContent = readFileSync("shared/organizer/organizer.css", "utf8");
  document.head.appendChild(style);
});
afterAll(() => style.remove());

describe("shared saved-link cards", () => {
  it("keeps native navigation separate from small draggable and edit controls", async () => {
    const edit = vi.fn();
    render(<SavedLinkCard link={link} writable favicon={null} actions={{ onEdit: edit }} onDragStart={vi.fn()} />);
    const anchor = screen.getByRole("link", { name: /Product roadmap/ });
    expect(anchor).toHaveAttribute("href", link.url);
    expect(anchor).toHaveAttribute("draggable", "false");
    expect(anchor).toHaveStyle({ cursor: "pointer" });
    expect(screen.getByLabelText(`Drag ${link.title}`)).toHaveAttribute("draggable", "true");
    expect(screen.getByLabelText(`Drag ${link.title}`).closest("a")).toBeNull();
    let preventedByCard = true;
    const preventNavigation = (event: MouseEvent) => {
      preventedByCard = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", preventNavigation, { once: true });
    fireEvent.click(anchor, { ctrlKey: true });
    expect(preventedByCard).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: `Edit ${link.title}` }));
    expect(edit).toHaveBeenCalledOnce();
  });

  it("bounds the card and uses shared typography with a single-letter image failure fallback", () => {
    const view = render(<SavedLinkCard link={link} writable favicon="https://example.com/broken.ico" />);
    const card = view.container.querySelector(".ext-link-card")!;
    expect(getComputedStyle(card).maxWidth).toBe("200px");
    expect(getComputedStyle(card).maxHeight).toBe("100px");
    expect(getComputedStyle(card).fontFamily).toContain("Poppins");
    expect(getComputedStyle(card.querySelector("b")!).fontSize).toBe("16px");
    expect(getComputedStyle(card.querySelector("b")!).fontWeight).toBe("500");
    expect(getComputedStyle(card.querySelector("small")!).fontSize).toBe("14px");
    fireEvent.error(card.querySelector("img")!);
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector(".favicon-tile-fallback")).toHaveTextContent("P");
  });

  it("does not expose mutations for read-only links even inside writable collections", () => {
    render(<CollectionSection collection={snapshot.collections[0]} links={[{ ...link, read_only: true }]} writable />);
    expect(screen.getByRole("link")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit|Delete|Drag|Move/ })).not.toBeInTheDocument();
  });

  it("renders bookmark collections without editing, deletion, sharing, or moving controls", () => {
    render(<CollectionSection collection={{ ...snapshot.collections[0], origin: "browser-bookmark", read_only: true }} links={[{ ...link, origin: "browser-bookmark", read_only: true }]} writable={false} />);
    expect(screen.getByRole("group", { name: "Plan collection" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Edit|Rename|Delete|Share|Move/ })).not.toBeInTheDocument();
  });
});

describe("deterministic insertion previews", () => {
  it("removes the source before inserting, normalizes positions, clamps targets, and preserves inputs", () => {
    const links = snapshot.links.filter((item) => item.collection_id === "collection-plan");
    const original = structuredClone(links);
    expect(previewLinkDrop(links, links[2].id, 1).map((item) => item.title)).toEqual(["Product roadmap", "Launch checklist", "Customer brief"]);
    expect(previewLinkDrop(links, links[0].id, 99).map((item) => item.title)).toEqual(["Customer brief", "Launch checklist", "Product roadmap"]);
    expect(previewLinkDrop(links, links[2].id, -5).map((item) => item.position)).toEqual([0, 1, 2]);
    expect(links).toEqual(original);
    expect(previewLinkDrop(links, "missing", 1)).toEqual(links);
    expect(previewCollectionDrop(snapshot.collections, "collection-learn", 0).map((item) => item.name)).toEqual(["Learn", "Plan", "Design"]);
  });

  it("previews cross-collection moves without duplicates and normalizes both collections", () => {
    const original = structuredClone(snapshot.links);
    const preview = previewLinkTransfer(snapshot.links, link.id, "collection-design", 1);
    expect(preview.filter((item) => item.collection_id === "collection-design").map((item) => item.title)).toEqual(["Brand system", "Product roadmap", "Homepage explorations", "Prototype"]);
    expect(preview.filter((item) => item.collection_id === "collection-plan").map((item) => item.position)).toEqual([0, 1]);
    expect(preview.filter((item) => item.id === link.id)).toHaveLength(1);
    expect(snapshot.links).toEqual(original);
  });
});

describe("shared collection interactions", () => {
  function setup(links = snapshot.links) {
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const reload = vi.fn(async () => undefined);
    render(<CollectionList collections={snapshot.collections} links={links} allLinks={snapshot.links} repository={repository} onReload={reload} />);
    return { repository, reload };
  }

  it("moves a link with keyboard controls using the full unfiltered collection order", async () => {
    const { repository, reload } = setup(snapshot.links.filter((item) => item.title !== "Customer brief"));
    const move = screen.getByRole("button", { name: "Move Launch checklist earlier" });
    move.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect((await repository.load()).links.filter((item) => item.collection_id === "collection-plan").sort((a, b) => a.position - b.position).map((item) => item.title)).toEqual(["Product roadmap", "Launch checklist", "Customer brief"]);
  });

  it("moves a saved link into another collection through its keyboard-accessible destination control", async () => {
    const { repository, reload } = setup();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Move Product roadmap to collection" }), "collection-design");
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect((await repository.load()).links.find((item) => item.id === link.id)?.collection_id).toBe("collection-design");
  });

  it("shows an insertion target and shifts the source out of its former slot before committing", async () => {
    const { repository, reload } = setup();
    const dataTransfer = { effectAllowed: "none", dropEffect: "none", types: [], getData: () => "" };
    const drag = screen.getByRole("button", { name: "Drag Launch checklist" });
    fireEvent.dragStart(drag, { dataTransfer });
    const target = screen.getByRole("link", { name: /Product roadmap/ });
    fireEvent.dragOver(target, { dataTransfer });
    const group = screen.getByRole("group", { name: "Plan collection" });
    expect(group.querySelector(".ext-link-grid")?.firstElementChild).toHaveClass("ext-link-drop-preview");
    expect(within(group).getAllByRole("link").map((item) => item.textContent)).toEqual([expect.stringContaining("Product roadmap"), expect.stringContaining("Customer brief")]);
    expect(reload).not.toHaveBeenCalled();
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect((await repository.load()).links.filter((item) => item.collection_id === "collection-plan").sort((a, b) => a.position - b.position).map((item) => item.title)).toEqual(["Launch checklist", "Product roadmap", "Customer brief"]);
  });

  it("animates shifted siblings from their previous positions and skips reduced motion", () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    const originalAnimate = HTMLElement.prototype.animate;
    const originalMatchMedia = globalThis.matchMedia;
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: animate });
    let shifted = false;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { x: 0, y: shifted && this.classList.contains("ext-link-card") ? 100 : 0, left: 0, top: shifted && this.classList.contains("ext-link-card") ? 100 : 0, width: 200, height: 92, bottom: 0, right: 200, toJSON: () => ({}) };
    });
    try {
      setup();
      const dataTransfer = { effectAllowed: "none", dropEffect: "none", types: [], getData: () => "" };
      fireEvent.dragStart(screen.getByRole("button", { name: "Drag Launch checklist" }), { dataTransfer });
      shifted = true;
      fireEvent.dragOver(screen.getByRole("link", { name: /Product roadmap/ }), { dataTransfer });
      expect(animate).toHaveBeenCalledWith([{ transform: "translate(0px, -100px)" }, { transform: "translate(0px, 0px)" }], expect.objectContaining({ duration: 200 }));
      animate.mockClear();
      globalThis.matchMedia = (media) => ({ matches: true, media, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true });
      shifted = false;
      fireEvent.dragOver(screen.getByRole("link", { name: /Customer brief/ }), { dataTransfer });
      expect(animate).not.toHaveBeenCalled();
    } finally {
      rect.mockRestore();
      HTMLElement.prototype.animate = originalAnimate;
      globalThis.matchMedia = originalMatchMedia;
    }
  });
});
