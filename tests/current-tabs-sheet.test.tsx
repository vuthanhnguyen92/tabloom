import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CurrentTabsSheet } from "../extension/CurrentTabsSheet";
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

const browserTabs = [
  { id: 41, title: "Roadmap", url: "https://linear.app/roadmap", favIconUrl: undefined, saveable: true, selected: true },
  { id: 42, title: "Settings", url: "chrome://settings", favIconUrl: undefined, saveable: false, selected: false },
];

function setup() {
  const snapshot = createDemoSnapshot();
  const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
  const onExpandedChange = vi.fn();
  const onMessage = vi.fn();
  const onTabDragChange = vi.fn();
  render(<CurrentTabsSheet
    activeSpaceId="space-launch"
    collections={snapshot.collections}
    expanded
    repository={repository}
    onError={vi.fn()}
    onExpandedChange={onExpandedChange}
    onMessage={onMessage}
    onTabDragChange={onTabDragChange}
    onWorkspaceReload={vi.fn(async () => undefined)}
    listTabs={vi.fn(async () => browserTabs)}
  />);
  return { repository, onExpandedChange, onMessage, onTabDragChange };
}

describe("CurrentTabsSheet", () => {
  it("shows a current tab favicon and falls back to its first letter when loading fails", async () => {
    const snapshot = createDemoSnapshot();
    render(<CurrentTabsSheet
      activeSpaceId="space-launch"
      collections={snapshot.collections}
      expanded
      repository={new MemoryWorkspaceRepository("demo-user", snapshot)}
      onError={vi.fn()}
      onExpandedChange={vi.fn()}
      onMessage={vi.fn()}
      onWorkspaceReload={vi.fn(async () => undefined)}
      listTabs={vi.fn(async () => [{ ...browserTabs[0], favIconUrl: "https://linear.app/favicon.ico" }])}
    />);

    const card = (await screen.findByText("Roadmap")).closest<HTMLElement>("[draggable='true']")!;
    const favicon = card.querySelector("img");
    expect(favicon).toHaveAttribute("src", "https://linear.app/favicon.ico");
    fireEvent.error(favicon!);
    expect(card.querySelector("img")).not.toBeInTheDocument();
    expect(within(card).getByText("R", { exact: true })).toBeVisible();
  });

  it("loads current tabs expanded and exposes drag-only controls", async () => {
    const { onExpandedChange } = setup();
    expect(await screen.findByText("Roadmap")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save selected/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Collapse current tabs" }));
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it("disables duplicate cleanup when the window has no duplicate web tabs", async () => {
    setup();
    await screen.findByText("Roadmap");
    expect(screen.getByRole("button", { name: "Close duplicate tabs" })).toBeDisabled();
  });

  it("confirms and closes only redundant tabs before refreshing the tray", async () => {
    const snapshot = createDemoSnapshot();
    const duplicates = [
      { id: 51, title: "Roadmap left", url: "https://linear.app/roadmap", favIconUrl: undefined, saveable: true, selected: true, active: false, index: 0 },
      { id: 52, title: "Roadmap active", url: "https://LINEAR.app:443/roadmap", favIconUrl: undefined, saveable: true, selected: true, active: true, index: 1 },
      { id: 53, title: "Other", url: "https://example.com/other", favIconUrl: undefined, saveable: true, selected: true, active: false, index: 2 },
    ];
    let currentTabs = duplicates;
    const listTabs = vi.fn(async () => currentTabs);
    const closeTabs = vi.fn(async (ids: number[]) => { currentTabs = currentTabs.filter((tab) => !ids.includes(tab.id)); });
    const onMessage = vi.fn();
    render(<CurrentTabsSheet
      activeSpaceId="space-launch"
      closeTabs={closeTabs}
      collections={snapshot.collections}
      expanded
      repository={new MemoryWorkspaceRepository("demo-user", snapshot)}
      onError={vi.fn()}
      onExpandedChange={vi.fn()}
      onMessage={onMessage}
      onWorkspaceReload={vi.fn(async () => undefined)}
      listTabs={listTabs}
    />);
    await screen.findByText("Roadmap left");

    await userEvent.click(screen.getByRole("button", { name: "Close duplicate tabs" }));
    expect(screen.getByRole("dialog", { name: "Close duplicate tabs" })).toHaveTextContent("Close 1 duplicate tab?");
    expect(screen.getByText("Roadmap left")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close duplicates" }));

    await waitFor(() => expect(screen.queryByText("Roadmap left")).not.toBeInTheDocument());
    expect(screen.getByText("Roadmap active")).toBeInTheDocument();
    expect(closeTabs).toHaveBeenCalledWith([51]);
    expect(onMessage).toHaveBeenCalledWith("1 duplicate tab closed");
    expect(listTabs).toHaveBeenCalledTimes(2);
  });

  it("cancels duplicate cleanup without closing tabs", async () => {
    const snapshot = createDemoSnapshot();
    const duplicates = [
      { id: 61, title: "First copy", url: "https://example.com", favIconUrl: undefined, saveable: true, selected: true, active: false, index: 0 },
      { id: 62, title: "Second copy", url: "https://example.com/", favIconUrl: undefined, saveable: true, selected: true, active: false, index: 1 },
    ];
    const closeTabs = vi.fn(async () => undefined);
    render(<CurrentTabsSheet
      activeSpaceId="space-launch"
      closeTabs={closeTabs}
      collections={snapshot.collections}
      expanded
      repository={new MemoryWorkspaceRepository("demo-user", snapshot)}
      onError={vi.fn()}
      onExpandedChange={vi.fn()}
      onMessage={vi.fn()}
      onWorkspaceReload={vi.fn(async () => undefined)}
      listTabs={vi.fn(async () => duplicates)}
    />);
    await screen.findByText("First copy");
    await userEvent.click(screen.getByRole("button", { name: "Close duplicate tabs" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel duplicate cleanup" }));

    expect(screen.queryByRole("dialog", { name: "Close duplicate tabs" })).not.toBeInTheDocument();
    expect(screen.getByText("First copy")).toBeInTheDocument();
    expect(screen.getByText("Second copy")).toBeInTheDocument();
    expect(closeTabs).not.toHaveBeenCalled();
  });

  it("refreshes the tray and reports an error when duplicate closing fails", async () => {
    const snapshot = createDemoSnapshot();
    const duplicates = [
      { id: 71, title: "First copy", url: "https://example.com/failure", favIconUrl: undefined, saveable: true, selected: true, active: false, index: 0 },
      { id: 72, title: "Second copy", url: "https://example.com/failure", favIconUrl: undefined, saveable: true, selected: true, active: false, index: 1 },
    ];
    const closeTabs = vi.fn(async () => { throw new Error("Chrome refused to close tabs"); });
    const listTabs = vi.fn(async () => duplicates);
    const onError = vi.fn();
    render(<CurrentTabsSheet
      activeSpaceId="space-launch"
      closeTabs={closeTabs}
      collections={snapshot.collections}
      expanded
      repository={new MemoryWorkspaceRepository("demo-user", snapshot)}
      onError={onError}
      onExpandedChange={vi.fn()}
      onMessage={vi.fn()}
      onWorkspaceReload={vi.fn(async () => undefined)}
      listTabs={listTabs}
    />);
    await screen.findByText("First copy");
    await userEvent.click(screen.getByRole("button", { name: "Close duplicate tabs" }));
    await userEvent.click(screen.getByRole("button", { name: "Close duplicates" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Chrome refused to close tabs"));
    expect(listTabs).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog", { name: "Close duplicate tabs" })).not.toBeInTheDocument();
  });

  it("renders current-tab card titles at font weight 500", async () => {
    setup();
    await screen.findByText("Roadmap");
    const rules = Array.from(styleElement.sheet!.cssRules) as CSSStyleRule[];
    const rule = rules.find((item) => item.selectorText?.split(", ").includes(".current-tab-list b") && item.style.fontWeight);
    expect(rule?.style.fontWeight).toBe("500");
  });

  it("places a saveable tab payload on drag start", async () => {
    const { onTabDragChange } = setup();
    const tab = await screen.findByText("Roadmap");
    const setData = vi.fn();
    const dataTransfer = { setData, effectAllowed: "none" };
    fireEvent.dragStart(tab.closest("[draggable='true']")!, { dataTransfer });
    expect(setData).toHaveBeenCalledWith("application/x-tabloom-tab", expect.stringContaining("Roadmap"));
    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(onTabDragChange).toHaveBeenCalledWith(true);
    fireEvent.dragEnd(tab.closest("[draggable='true']")!);
    expect(onTabDragChange).toHaveBeenLastCalledWith(false);
  });

  it("does not activate saved-card drop zones for unsupported tabs", async () => {
    const { onTabDragChange } = setup();
    const tab = await screen.findByText("Settings");
    fireEvent.dragStart(tab.closest(".disabled")!, { dataTransfer: { setData: vi.fn(), effectAllowed: "none" } });
    expect(onTabDragChange).not.toHaveBeenCalled();
  });

  it("saves all supported tabs into a user-named collection", async () => {
    const user = userEvent.setup();
    const { repository, onMessage } = setup();
    await screen.findByText("Roadmap");
    await user.click(screen.getByRole("button", { name: "Save all as collection" }));
    await user.type(screen.getByLabelText("Collection name"), "Window research");
    await user.click(screen.getByRole("button", { name: "Create and save" }));

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("1 saved · 1 unsupported skipped"));
    const snapshot = await repository.load();
    const collection = snapshot.collections.find((item) => item.name === "Window research");
    expect(collection).toBeDefined();
    expect(snapshot.links.filter((item) => item.collection_id === collection?.id).map((item) => item.title)).toEqual(["Roadmap"]);
  });

  it("saves repeated current-tab URLs only once in a new collection", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    const onMessage = vi.fn();
    const repeatedTabs = [
      browserTabs[0],
      { ...browserTabs[0], id: 43, title: "Roadmap duplicate", url: "https://LINEAR.app:443/roadmap" },
      browserTabs[1],
    ];
    render(<CurrentTabsSheet activeSpaceId="space-launch" collections={snapshot.collections} expanded repository={repository} onError={vi.fn()} onExpandedChange={vi.fn()} onMessage={onMessage} onWorkspaceReload={vi.fn(async () => undefined)} listTabs={vi.fn(async () => repeatedTabs)} />);
    await screen.findByText("Roadmap");
    await userEvent.click(screen.getByRole("button", { name: "Save all as collection" }));
    await userEvent.type(screen.getByLabelText("Collection name"), "Deduplicated window");
    await userEvent.click(screen.getByRole("button", { name: "Create and save" }));

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("1 saved · 1 duplicate skipped · 1 unsupported skipped"));
    const next = await repository.load();
    const collection = next.collections.find((item) => item.name === "Deduplicated window")!;
    expect(next.links.filter((item) => item.collection_id === collection.id)).toHaveLength(1);
  });

  it("reports collection creation failures", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    repository.createCollection = vi.fn(async () => { throw new Error("offline"); });
    const onError = vi.fn();
    render(<CurrentTabsSheet activeSpaceId="space-launch" collections={snapshot.collections} expanded repository={repository} onError={onError} onExpandedChange={vi.fn()} onMessage={vi.fn()} onWorkspaceReload={vi.fn(async () => undefined)} listTabs={vi.fn(async () => browserTabs)} />);
    await screen.findByText("Roadmap");
    await userEvent.click(screen.getByRole("button", { name: "Save all as collection" }));
    await userEvent.type(screen.getByLabelText("Collection name"), "Offline window");
    await userEvent.click(screen.getByRole("button", { name: "Create and save" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("offline"));
  });

  it("prevents duplicate save-all submissions while a save is running", async () => {
    const snapshot = createDemoSnapshot();
    const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const originalCreateLinks = repository.createLinks.bind(repository);
    repository.createLinks = vi.fn(async (items) => { await pending; return originalCreateLinks(items); });
    render(<CurrentTabsSheet activeSpaceId="space-launch" collections={snapshot.collections} expanded repository={repository} onError={vi.fn()} onExpandedChange={vi.fn()} onMessage={vi.fn()} onWorkspaceReload={vi.fn(async () => undefined)} listTabs={vi.fn(async () => browserTabs)} />);
    await screen.findByText("Roadmap");
    await userEvent.click(screen.getByRole("button", { name: "Save all as collection" }));
    await userEvent.type(screen.getByLabelText("Collection name"), "One window");
    const submit = screen.getByRole("button", { name: "Create and save" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(submit).toBeDisabled();
    await waitFor(() => expect(repository.createLinks).toHaveBeenCalledOnce());
    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Saving…" })).not.toBeInTheDocument());
  });
});
