import { fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { GlobalSearch } from "../extension/GlobalSearch";
import type { BrowserTab } from "../shared/capture";
import { createDemoSnapshot, type WorkspaceSnapshot } from "../shared/domain";
import type { FaviconResolver } from "../extension/browser/types";

const currentTabs: BrowserTab[] = [
  { id: 1, title: "Tabloom", url: "chrome-extension://tabloom/index.html", active: true, index: 0 },
  { id: 2, title: "React documentation", url: "https://react.dev/learn", active: false, index: 1 },
  { id: 3, title: "Figma homepage exploration", url: "https://figma.com", active: false, index: 2 },
];

function searchSnapshot(): WorkspaceSnapshot {
  const snapshot = createDemoSnapshot("user-1");
  const now = "2026-08-30T00:00:00.000Z";
  snapshot.spaces.push({ id: "bookmarks", user_id: "user-1", name: "Browser bookmarks", color: "#7157d9", position: 3, created_at: now, updated_at: now, origin: "browser-bookmark", read_only: true });
  snapshot.collections.push({ id: "bookmark-design", user_id: "user-1", space_id: "bookmarks", name: "Reference", position: 0, created_at: now, updated_at: now, origin: "browser-bookmark", read_only: true });
  snapshot.links.push({ id: "chrome-docs", user_id: "user-1", collection_id: "bookmark-design", title: "Chrome extension docs", url: "https://developer.chrome.com/docs/extensions", description: "", favicon_url: null, position: 0, created_at: now, updated_at: now, origin: "browser-bookmark", read_only: true, device_label: "Work Mac" });
  return snapshot;
}

type SearchProps = ComponentProps<typeof GlobalSearch>;

function renderSearch(overrides: Partial<SearchProps> = {}): RenderResult & {
  listCurrentTabs: NonNullable<SearchProps["listCurrentTabs"]>;
  onActivateCurrentTab: NonNullable<SearchProps["onActivateCurrentTab"]>;
} {
  const listCurrentTabs = overrides.listCurrentTabs ?? vi.fn(async () => currentTabs);
  const onActivateCurrentTab = overrides.onActivateCurrentTab ?? vi.fn(async () => undefined);
  const rendered = render(
    <GlobalSearch
      {...overrides}
      listCurrentTabs={listCurrentTabs}
      onActivateCurrentTab={onActivateCurrentTab}
      snapshot={overrides.snapshot ?? searchSnapshot()}
    />,
  );
  return { ...rendered, listCurrentTabs, onActivateCurrentTab };
}

describe("GlobalSearch", () => {
  it("keeps extension search keyboard focus inside the overlay and restores its trigger", async () => {
    const user = userEvent.setup();
    const { container } = renderSearch();
    const trigger = screen.getByRole("button", { name: "Search all links" });
    await user.click(trigger);
    expect(container).toHaveAttribute("inert");
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Close search" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(container).not.toHaveAttribute("inert");
  });

  it("opens from the compact trigger and searches every saved space with source context", async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.click(screen.getByRole("button", { name: "Search all links" }));
    const input = screen.getByRole("searchbox", { name: "Search all spaces and collections" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("name", "tabloom-global-search");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("spellcheck", "false");

    await user.type(input, "chrome");

    expect(screen.getByRole("heading", { name: "Saved links" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Chrome extension docs/ })).toBeInTheDocument();
    expect(screen.getByText("Browser bookmarks › Reference")).toBeInTheDocument();
    expect(screen.getByText("Browser bookmark · Work Mac")).toBeInTheDocument();
  });

  it("captures Command-F and Control-F while leaving the old shortcut unused", async () => {
    renderSearch();

    const oldShortcut = new window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(oldShortcut);
    expect(oldShortcut.defaultPrevented).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Search Tabloom" })).not.toBeInTheDocument();

    const commandFind = new window.KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(commandFind);
    expect(commandFind.defaultPrevented).toBe(true);
    expect(await screen.findByRole("dialog", { name: "Search Tabloom" })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    const controlFind = new window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(controlFind);
    expect(controlFind.defaultPrevented).toBe(true);
    expect(await screen.findByRole("dialog", { name: "Search Tabloom" })).toBeInTheDocument();
  });

  it("refreshes current-window tabs every time search opens", async () => {
    const user = userEvent.setup();
    const listCurrentTabs = vi.fn(async () => currentTabs);
    renderSearch({ listCurrentTabs });

    await user.click(screen.getByRole("button", { name: "Search all links" }));
    await waitFor(() => expect(listCurrentTabs).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Close search backdrop" }));
    await user.click(screen.getByRole("button", { name: "Search all links" }));

    await waitFor(() => expect(listCurrentTabs).toHaveBeenCalledTimes(2));
  });

  it("shows current tabs before saved links and navigates across both sections", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderSearch({ onOpen });

    await user.click(screen.getByRole("button", { name: "Search all links" }));
    await user.type(screen.getByRole("searchbox"), "figma");

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["Current tabs", "Saved links"]);
    const results = screen.getAllByRole("option");
    expect(results[0]).toHaveAttribute("aria-selected", "true");
    expect(results[0]).toHaveTextContent("Current window");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ origin: "saved" }));
  });

  it("activates a matching current tab instead of opening a duplicate", async () => {
    const user = userEvent.setup();
    const onActivateCurrentTab = vi.fn(async () => undefined);
    const openSpy = vi.spyOn(window, "open");
    renderSearch({ onActivateCurrentTab });

    await user.click(screen.getByRole("button", { name: "Search all links" }));
    await user.type(screen.getByRole("searchbox"), "react");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onActivateCurrentTab).toHaveBeenCalledWith(2));
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Search Tabloom" })).not.toBeInTheDocument();
    openSpy.mockRestore();
  });

  it("keeps saved search usable and retries when current tabs cannot load", async () => {
    const user = userEvent.setup();
    const listCurrentTabs = vi.fn()
      .mockRejectedValueOnce(new Error("tabs unavailable"))
      .mockResolvedValueOnce(currentTabs);
    renderSearch({ listCurrentTabs });

    await user.click(screen.getByRole("button", { name: "Search all links" }));
    expect(await screen.findByText("Current tabs are unavailable.")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "chrome");
    expect(screen.getByRole("link", { name: /Chrome extension docs/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry current tabs" }));
    await waitFor(() => expect(listCurrentTabs).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Current tabs are unavailable.")).not.toBeInTheDocument();
  });

  it("shows useful idle and empty states", async () => {
    const user = userEvent.setup();
    renderSearch();
    await user.click(screen.getByRole("button", { name: "Search all links" }));
    expect(screen.getByText("Search current tabs, saved links, spaces, and collections")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "nothing-matches-this");
    expect(screen.getByText("No results found")).toBeInTheDocument();
  });

  it("falls back to a title monogram when a saved result favicon cannot load", async () => {
    const user = userEvent.setup();
    const snapshot = searchSnapshot();
    snapshot.links[0] = { ...snapshot.links[0], favicon_url: "https://invalid.example/favicon.ico" };
    const resolveFavicon: FaviconResolver = vi.fn(({ pageUrl }) => `native-favicon:${pageUrl ?? ""}`);
    renderSearch({ snapshot, resolveFavicon });
    await user.click(screen.getByRole("button", { name: "Search all links" }));
    await user.type(screen.getByRole("searchbox"), "Product roadmap");
    const result = screen.getByRole("link", { name: /Product roadmap/ });
    expect(result.querySelector("img")).toHaveAttribute("src", "native-favicon:https://linear.app/roadmap");
    expect(resolveFavicon).toHaveBeenCalledWith({ pageUrl: "https://linear.app/roadmap", capturedUrl: "https://invalid.example/favicon.ico", size: 32 });
    fireEvent.error(result.querySelector("img")!);
    expect(result.querySelector(".global-search-favicon")).toHaveTextContent("P");
  });

  it("dismisses from the backdrop without closing when the search panel is clicked", async () => {
    const user = userEvent.setup();
    renderSearch();
    await user.click(screen.getByRole("button", { name: "Search all links" }));

    const dialog = screen.getByRole("dialog", { name: "Search Tabloom" });
    fireEvent.click(dialog.querySelector(".global-search-shell")!);
    expect(dialog).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close search backdrop" }));
    expect(screen.queryByRole("dialog", { name: "Search Tabloom" })).not.toBeInTheDocument();
  });

  it("mounts the open dialog at the document body so workspace clipping cannot constrain it", async () => {
    const user = userEvent.setup();
    const { container } = renderSearch();
    await user.click(screen.getByRole("button", { name: "Search all links" }));

    const dialog = screen.getByRole("dialog", { name: "Search Tabloom" });
    expect(container).not.toContainElement(dialog);
    expect(dialog.parentElement).toBe(document.body);
  });
});
