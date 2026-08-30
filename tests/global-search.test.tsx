import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GlobalSearch } from "../extension/GlobalSearch";
import { createDemoSnapshot, type WorkspaceSnapshot } from "../shared/domain";

function searchSnapshot(): WorkspaceSnapshot {
  const snapshot = createDemoSnapshot("user-1");
  const now = "2026-08-30T00:00:00.000Z";
  snapshot.spaces.push({ id: "bookmarks", user_id: "user-1", name: "Browser bookmarks", color: "#7157d9", position: 3, created_at: now, updated_at: now, origin: "browser-bookmark", read_only: true });
  snapshot.collections.push({ id: "bookmark-design", user_id: "user-1", space_id: "bookmarks", name: "Reference", position: 0, created_at: now, updated_at: now, origin: "browser-bookmark", read_only: true });
  snapshot.links.push({ id: "chrome-docs", user_id: "user-1", collection_id: "bookmark-design", title: "Chrome extension docs", url: "https://developer.chrome.com/docs/extensions", description: "", favicon_url: null, position: 0, created_at: now, updated_at: now, origin: "browser-bookmark", read_only: true, device_label: "Work Mac" });
  return snapshot;
}

describe("GlobalSearch", () => {
  it("opens from the compact trigger and searches every space with source context", async () => {
    const user = userEvent.setup();
    render(<GlobalSearch snapshot={searchSnapshot()} />);

    await user.click(screen.getByRole("button", { name: "Search all links" }));
    const input = screen.getByRole("searchbox", { name: "Search all spaces and collections" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("name", "tabloom-global-search");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("spellcheck", "false");

    await user.type(input, "chrome");

    expect(screen.getByRole("link", { name: /Chrome extension docs/ })).toBeInTheDocument();
    expect(screen.getByText("Browser bookmarks › Reference")).toBeInTheDocument();
    expect(screen.getByText("Browser bookmark · Work Mac")).toBeInTheDocument();
  });

  it("supports the global shortcut, result navigation, Enter, and Escape", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<GlobalSearch snapshot={searchSnapshot()} onOpen={onOpen} />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByRole("searchbox", { name: "Search all spaces and collections" });
    await user.type(input, "figma");

    const results = screen.getAllByRole("option");
    expect(results[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ title: "Homepage explorations" }));
    expect(screen.queryByRole("dialog", { name: "Search Tabloom" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Search Tabloom" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search Tabloom" })).not.toBeInTheDocument();
  });

  it("shows useful idle and empty states", async () => {
    const user = userEvent.setup();
    render(<GlobalSearch snapshot={searchSnapshot()} />);
    await user.click(screen.getByRole("button", { name: "Search all links" }));
    expect(screen.getByText("Search links, spaces, collections, and bookmarks")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "nothing-matches-this");
    expect(screen.getByText("No links found")).toBeInTheDocument();
  });

  it("falls back to a title monogram when a result favicon cannot load", async () => {
    const user = userEvent.setup();
    const snapshot = searchSnapshot();
    snapshot.links[0] = { ...snapshot.links[0], favicon_url: "https://invalid.example/favicon.ico" };
    render(<GlobalSearch snapshot={snapshot} />);
    await user.click(screen.getByRole("button", { name: "Search all links" }));
    await user.type(screen.getByRole("searchbox"), "Product roadmap");
    const result = screen.getByRole("link", { name: /Product roadmap/ });
    fireEvent.error(result.querySelector("img")!);
    expect(result.querySelector(".global-search-favicon")).toHaveTextContent("P");
  });

  it("dismisses from the backdrop without closing when the search panel is clicked", async () => {
    const user = userEvent.setup();
    render(<GlobalSearch snapshot={searchSnapshot()} />);
    await user.click(screen.getByRole("button", { name: "Search all links" }));

    const dialog = screen.getByRole("dialog", { name: "Search Tabloom" });
    fireEvent.click(dialog.querySelector(".global-search-shell")!);
    expect(dialog).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close search backdrop" }));
    expect(screen.queryByRole("dialog", { name: "Search Tabloom" })).not.toBeInTheDocument();
  });

  it("mounts the open dialog at the document body so workspace clipping cannot constrain it", async () => {
    const user = userEvent.setup();
    const { container } = render(<div className="clipping-workspace"><GlobalSearch snapshot={searchSnapshot()} /></div>);
    await user.click(screen.getByRole("button", { name: "Search all links" }));

    const dialog = screen.getByRole("dialog", { name: "Search Tabloom" });
    expect(container).not.toContainElement(dialog);
    expect(dialog.parentElement).toBe(document.body);
  });
});
