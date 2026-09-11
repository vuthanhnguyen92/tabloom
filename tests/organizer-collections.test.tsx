import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CollectionList } from "../shared/organizer/CollectionList";
import { CollectionSection } from "../shared/organizer/CollectionSection";
import { SavedLinkCard } from "../shared/organizer/SavedLinkCard";
import { WorkspaceOrganizer } from "../shared/organizer/WorkspaceOrganizer";
import { createWebPreferenceStore } from "../shared/organizer/preferences";
import { previewCollectionDrop, previewLinkDrop, previewLinkTransfer } from "../shared/organizer/drag-model";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";
import type { WorkspaceTrashRepository } from "../shared/trash-repository";
import { webOrganizerCapabilities } from "../app/app/web-organizer-capabilities";

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
  it("keeps cross-collection movement on drag handles without a Move to selector", () => {
    render(<SavedLinkCard
      link={link}
      writable
      favicon={null}
      onDragStart={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: `Drag ${link.title}` })).toHaveAttribute("draggable", "true");
    expect(screen.queryByRole("combobox", { name: `Move ${link.title} to collection` })).not.toBeInTheDocument();
  });

  it("keeps native navigation while allowing the saved-card body and grip to drag", async () => {
    const edit = vi.fn();
    const drag = vi.fn();
    render(<SavedLinkCard link={link} writable favicon={null} actions={{ onEdit: edit }} onDragStart={drag} />);
    const anchor = screen.getByRole("link", { name: /Product roadmap/ });
    expect(anchor).toHaveAttribute("href", link.url);
    expect(anchor).toHaveAttribute("draggable", "true");
    expect(anchor).toHaveStyle({ cursor: "pointer" });
    expect(screen.getByLabelText(`Drag ${link.title}`)).toHaveAttribute("draggable", "true");
    expect(screen.getByLabelText(`Drag ${link.title}`).closest("a")).toBeNull();
    fireEvent.dragStart(anchor, { dataTransfer: { effectAllowed: "none", setData: vi.fn() } });
    expect(drag).toHaveBeenCalledOnce();
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

  it("keeps collection dragging isolated to its handle while card bodies drag links", async () => {
    const { repository, reload } = setup();
    const row = screen.getByRole("group", { name: "Plan collection" });
    const anchor = screen.getByRole("link", { name: /Product roadmap/ });
    const transfer = { effectAllowed: "none", dropEffect: "none", types: [], getData: () => "" };
    expect(row).toHaveAttribute("draggable", "false");
    expect(anchor).toHaveAttribute("draggable", "true");
    expect(fireEvent.dragStart(row, { dataTransfer: transfer })).toBe(false);
    expect(fireEvent.dragStart(anchor, { dataTransfer: transfer })).toBe(true);
    expect(row).not.toHaveClass("collection-dragging");
    expect(anchor).toHaveClass("dragging");
    fireEvent.dragEnd(anchor, { dataTransfer: transfer });
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag Design collection" }), { dataTransfer: transfer });
    expect(screen.getByRole("group", { name: "Design collection" })).toHaveClass("collection-dragging");
    fireEvent.drop(row, { dataTransfer: transfer });
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect((await repository.load()).collections.sort((a, b) => a.position - b.position).map((item) => item.name)).toEqual(["Design", "Plan", "Learn"]);
  });

  it.each([
    { source: "Launch checklist", target: "Product roadmap", collection: "Plan", expected: ["Launch checklist", "Product roadmap", "Customer brief"] },
    { source: "Product roadmap", target: "Brand system", collection: "Design", expected: ["Product roadmap", "Brand system", "Homepage explorations", "Prototype"] },
  ])("drops on the visible $collection insertion slot at its displayed position", async ({ source, target, collection, expected }) => {
    const { repository, reload } = setup();
    const transfer = { effectAllowed: "none", dropEffect: "none", types: [], getData: () => "" };
    fireEvent.dragStart(screen.getByRole("button", { name: `Drag ${source}` }), { dataTransfer: transfer });
    fireEvent.dragOver(screen.getByRole("link", { name: new RegExp(target) }), { dataTransfer: transfer });
    const slot = screen.getByRole("group", { name: `${collection} collection` }).querySelector(".ext-link-drop-preview")!;
    fireEvent.drop(slot, { dataTransfer: transfer });
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect((await repository.load()).links.filter((item) => item.collection_id === `collection-${collection.toLowerCase()}`).sort((a, b) => a.position - b.position).map((item) => item.title)).toEqual(expected);
  });

  it("keeps an insertion slot hit-testable and stable through repeated hover on its label", () => {
    setup();
    const transfer = { effectAllowed: "none", dropEffect: "none", types: [], getData: () => "" };
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag Launch checklist" }), { dataTransfer: transfer });
    fireEvent.dragOver(screen.getByRole("link", { name: /Product roadmap/ }), { dataTransfer: transfer });
    const grid = screen.getByRole("group", { name: "Plan collection" }).querySelector(".ext-link-grid")!;
    const slot = grid.querySelector(".ext-link-drop-preview")!;
    for (let hover = 0; hover < 3; hover++) fireEvent.dragOver(slot.firstElementChild!, { dataTransfer: transfer });
    expect(grid.firstElementChild).toBe(slot);
    expect(getComputedStyle(slot).pointerEvents).toBe("auto");
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

  it("measures nested layout before animating and does not replay parent displacement on unchanged previews", () => {
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    const activeOffsets = new Map<HTMLElement, number>();
    const calls: { id: string; frames: Keyframe[] }[] = [];
    const sequence: string[] = [];
    let moved = false;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const id = this.dataset.organizerLayoutId ?? "";
      sequence.push(`measure:${id}`);
      const collectionName = this.closest("article")?.getAttribute("aria-label");
      const collectionTop = collectionName === "Plan collection" ? 100 : collectionName === "Design collection" ? 300 : 500;
      let top = collectionTop + (moved ? 80 : 0);
      if (this.classList.contains("ext-link-card")) top += 20 + (moved && id === `link:${link.id}` ? 20 : 0);
      top += activeOffsets.get(this) ?? 0;
      for (let parent = this.parentElement; parent; parent = parent.parentElement) top += activeOffsets.get(parent) ?? 0;
      return { x: 0, y: top, left: 0, top, right: 200, bottom: top + 92, width: 200, height: 92, toJSON: () => ({}) };
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: function (this: HTMLElement, frames: Keyframe[]) {
      const id = this.dataset.organizerLayoutId!;
      sequence.push(`animate:${id}`);
      calls.push({ id, frames });
      const offset = /translate\(0px, (-?\d+)px\)/.exec(String(frames[0].transform));
      activeOffsets.set(this, Number(offset?.[1] ?? 0));
      return { cancel: () => activeOffsets.delete(this) };
    } });
    try {
      const view = render(<CollectionList collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={async () => undefined} />);
      const transfer = { effectAllowed: "none", dropEffect: "none", types: [], getData: () => "" };
      fireEvent.dragStart(screen.getByRole("button", { name: "Drag Launch checklist" }), { dataTransfer: transfer });
      sequence.length = 0;
      moved = true;
      fireEvent.dragOver(screen.getByRole("link", { name: /Product roadmap/ }), { dataTransfer: transfer });
      expect(calls.find((call) => call.id === "collection:collection-plan")?.frames[0]).toEqual({ transform: "translate(0px, -80px)" });
      expect(calls.find((call) => call.id === `link:${link.id}`)?.frames[0]).toEqual({ transform: "translate(0px, -20px)" });
      expect(calls.filter((call) => call.id.startsWith("link:")).map((call) => call.id)).toEqual([`link:${link.id}`]);
      const firstAnimation = sequence.findIndex((item) => item.startsWith("animate:"));
      expect(sequence.slice(firstAnimation).every((item) => item.startsWith("animate:"))).toBe(true);
      calls.length = 0;
      view.rerender(<CollectionList collections={snapshot.collections} links={snapshot.links} repository={repository} onReload={async () => undefined} highlightedLinkId={link.id} />);
      expect(calls).toEqual([]);
      fireEvent.dragOver(screen.getByRole("link", { name: /Product roadmap/ }), { dataTransfer: transfer });
      expect(calls).toEqual([]);
    } finally {
      rect.mockRestore();
      if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
      else Reflect.deleteProperty(HTMLElement.prototype, "animate");
    }
  });
});

describe("controller-backed collection renderer", () => {
  it("preserves every writable collection and saved-link action", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const trashRepository: WorkspaceTrashRepository = {
      list: vi.fn(async () => []),
      prepareDelete: vi.fn(),
      deleteEntity: vi.fn(),
      restore: vi.fn(),
    };

    render(<WorkspaceOrganizer
      capabilities={webOrganizerCapabilities}
      deleteSource="web"
      mutationPolicy="rollbackOnFailure"
      preferenceScope="characterization"
      preferenceStore={createWebPreferenceStore({
        getItem: (key) => localStorage.getItem(key),
        setItem: (key, value) => localStorage.setItem(key, value),
        removeItem: (key) => localStorage.removeItem(key),
      })}
      repository={repository}
      share={{
        availability: "sign-in-required",
        repository: null,
        siteUrl: "https://tabloom.nickvu.dev",
        onRequestSignIn: vi.fn(),
        onRequestSyncRetry: vi.fn(),
        onToast: vi.fn(),
      }}
      trashRepository={trashRepository}
      userId="demo-user"
    />);

    expect(await screen.findByRole("button", { name: "Rename Plan" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Share Plan" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add link to Plan" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete Plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse Plan" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Drag Product roadmap" })).toBeVisible();
  });
});
