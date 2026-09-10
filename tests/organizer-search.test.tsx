import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GlobalSearch } from "../shared/organizer/GlobalSearch";
import { WorkspaceDialogs } from "../shared/organizer/WorkspaceDialogs";
import { createDemoSnapshot } from "../shared/domain";
import { webOrganizerCapabilities } from "../shared/organizer/capabilities";

const snapshot = createDemoSnapshot();
const capabilities = webOrganizerCapabilities({ openUrl: async () => undefined });

describe("shared organizer search", () => {
  it("covers the full viewport using only the shared stylesheet", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("shared/organizer/organizer.css", "utf8");
    document.head.appendChild(style);
    render(<GlobalSearch snapshot={snapshot} capabilities={capabilities} open />);
    const overlay = screen.getByRole("dialog");
    expect(getComputedStyle(overlay).position).toBe("fixed");
    expect(getComputedStyle(overlay).inset).toBe("0px");
    expect(Number(getComputedStyle(overlay).zIndex)).toBeGreaterThan(30);
    expect(getComputedStyle(screen.getByRole("button", { name: "Close search backdrop" })).backdropFilter).toContain("blur(8px)");
    style.remove();
  });

  it("searches across spaces by collection and space names with full context", async () => {
    const user = userEvent.setup();
    const anotherSpace = { ...snapshot.spaces[0], id: "research-space", name: "Research archive" };
    const anotherCollection = { ...snapshot.collections[0], id: "research-collection", space_id: anotherSpace.id, name: "Reading list" };
    const anotherLink = { ...snapshot.links[0], id: "research-link", collection_id: anotherCollection.id, title: "Distributed systems reference" };
    const crossSpaceSnapshot = { spaces: [...snapshot.spaces, anotherSpace], collections: [...snapshot.collections, anotherCollection], links: [...snapshot.links, anotherLink] };
    render(<GlobalSearch snapshot={crossSpaceSnapshot} capabilities={capabilities} open />);
    const input = screen.getByRole("searchbox");
    for (const link of [snapshot.links[0], anotherLink]) {
      const collection = crossSpaceSnapshot.collections.find((item) => item.id === link.collection_id)!;
      const space = crossSpaceSnapshot.spaces.find((item) => item.id === collection.space_id)!;
      await user.clear(input);
      await user.type(input, link.title);
      expect(screen.getByRole("link", { name: `${link.title}, ${space.name}, ${collection.name}` })).toHaveTextContent(`${space.name} › ${collection.name}`);
      await user.clear(input);
      await user.type(input, space.name);
      expect(screen.getByRole("link", { name: `${link.title}, ${space.name}, ${collection.name}` })).toHaveTextContent(`${space.name} › ${collection.name}`);
      await user.clear(input);
      await user.type(input, collection.name);
      expect(screen.getByRole("link", { name: `${link.title}, ${space.name}, ${collection.name}` })).toBeVisible();
    }
    expect(screen.queryByText(/current tabs/i)).not.toBeInTheDocument();
    expect(input).toHaveAttribute("autocomplete", "off");
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("does not open search behind an active workspace dialog for %j", (modifier) => {
    render(<><GlobalSearch snapshot={snapshot} capabilities={capabilities} /><WorkspaceDialogs dialog={{ type: "create-space" }} onClose={vi.fn()} onSubmit={vi.fn()} /></>);
    const form = screen.getByRole("dialog", { name: "New space" });
    fireEvent.keyDown(window, { key: "f", ...modifier });
    expect(screen.queryByRole("dialog", { name: "Search Tabloom" })).not.toBeInTheDocument();
    expect(form).not.toHaveAttribute("inert");
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it("allows the search owner to toggle its own top modal with the shortcut", async () => {
    const user = userEvent.setup();
    render(<GlobalSearch snapshot={snapshot} capabilities={capabilities} />);
    await user.click(screen.getByRole("button", { name: "Search all links" }));
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "Search Tabloom" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });

  it("leaves controlled search unchanged while another modal is above it", () => {
    const onOpenChange = vi.fn();
    const search = <GlobalSearch snapshot={snapshot} capabilities={capabilities} open onOpenChange={onOpenChange} />;
    const { rerender } = render(<>{search}</>);
    rerender(<>{search}<WorkspaceDialogs dialog={{ type: "create-space" }} onClose={vi.fn()} onSubmit={vi.fn()} /></>);
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    rerender(<>{search}</>);
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("uses native web anchors for pointer navigation and the web capability for Enter", async () => {
    const user = userEvent.setup();
    const openUrl = vi.fn(async () => undefined);
    render(<GlobalSearch snapshot={snapshot} capabilities={webOrganizerCapabilities({ openUrl })} open />);
    await user.type(screen.getByRole("searchbox"), "Product roadmap");
    const link = screen.getByRole("link", { name: /Product roadmap/ });
    expect(link).toHaveAttribute("href", "https://linear.app/roadmap");
    expect(link).not.toHaveAttribute("target");
    // Observe cancellation without letting jsdom attempt navigation.
    let prevented: boolean | undefined;
    const observe = (event: MouseEvent) => { prevented = event.defaultPrevented; event.preventDefault(); };
    document.addEventListener("click", observe, { once: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(prevented).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(openUrl).toHaveBeenCalledWith({ url: "https://linear.app/roadmap", newTab: false });
  });

  it("only merges current tabs when supplied and activates the existing tab", async () => {
    const user = userEvent.setup();
    const activate = vi.fn(async () => undefined);
    render(<GlobalSearch snapshot={snapshot} capabilities={{ ...capabilities, currentTabs: {
      list: async () => [{ id: 42, title: "Live docs", url: "https://docs.example" }, { title: "No id docs", url: "https://example.com" }, { id: 43, title: "Internal docs", url: "chrome://settings" }], activate,
    } }} open />);
    await user.type(screen.getByRole("searchbox"), "Live docs");
    expect(await screen.findByRole("heading", { name: "Current tabs" })).toBeVisible();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(activate).toHaveBeenCalledWith(42));
  });

  it("traps focus, makes header actions inert, dismisses with Escape and restores focus", async () => {
    const user = userEvent.setup();
    const { container } = render(<><button>Account menu</button><GlobalSearch snapshot={snapshot} capabilities={capabilities} /></>);
    const trigger = screen.getByRole("button", { name: "Search all links" });
    await user.click(trigger);
    const input = screen.getByRole("searchbox");
    expect(input).toHaveFocus();
    expect(container).toHaveAttribute("inert");
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Close search" })).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.tab();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(container).not.toHaveAttribute("inert");
    expect(trigger).toHaveFocus();
  });

  it("ignores a stale current-tabs request after search is reopened", async () => {
    const user = userEvent.setup();
    let resolveOld!: (tabs: { id: number; title: string; url: string }[]) => void;
    const list = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce([{ id: 2, title: "Fresh docs", url: "https://fresh.example" }]);
    render(<GlobalSearch snapshot={snapshot} capabilities={{ ...capabilities, currentTabs: { list, activate: async () => undefined } }} />);
    await user.click(screen.getByRole("button", { name: "Search all links" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Search all links" }));
    await user.type(screen.getByRole("searchbox"), "docs");
    expect(await screen.findByRole("button", { name: "Fresh docs, Current window" })).toBeVisible();
    await act(async () => resolveOld([{ id: 1, title: "Stale docs", url: "https://stale.example" }]));
    expect(screen.getByRole("button", { name: "Fresh docs, Current window" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stale docs, Current window" })).not.toBeInTheDocument();
  });

  it("keeps Enter aligned with the highlighted result when a snapshot update removes results", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const { rerender } = render(<GlobalSearch snapshot={snapshot} capabilities={capabilities} onOpen={onOpen} open />);
    await user.type(screen.getByRole("searchbox"), "Product launch");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const remaining = { ...snapshot, links: [snapshot.links[0]] };
    rerender(<GlobalSearch snapshot={remaining} capabilities={capabilities} onOpen={onOpen} open />);
    expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith(snapshot.links[0]);
  });
});
