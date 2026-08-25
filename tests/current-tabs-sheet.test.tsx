import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CurrentTabsSheet } from "../extension/CurrentTabsSheet";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

const browserTabs = [
  { id: 41, title: "Roadmap", url: "https://linear.app/roadmap", favIconUrl: undefined, saveable: true, selected: true },
  { id: 42, title: "Settings", url: "chrome://settings", favIconUrl: undefined, saveable: false, selected: false },
];

function setup() {
  const snapshot = createDemoSnapshot();
  const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
  const onExpandedChange = vi.fn();
  const onMessage = vi.fn();
  render(<CurrentTabsSheet
    activeSpaceId="space-launch"
    collections={snapshot.collections}
    expanded
    repository={repository}
    onError={vi.fn()}
    onExpandedChange={onExpandedChange}
    onMessage={onMessage}
    onWorkspaceReload={vi.fn(async () => undefined)}
    listTabs={vi.fn(async () => browserTabs)}
  />);
  return { repository, onExpandedChange, onMessage };
}

describe("CurrentTabsSheet", () => {
  it("loads current tabs expanded and exposes drag-only controls", async () => {
    const { onExpandedChange } = setup();
    expect(await screen.findByText("Roadmap")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save selected/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Collapse current tabs" }));
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it("places a saveable tab payload on drag start", async () => {
    setup();
    const tab = await screen.findByText("Roadmap");
    const setData = vi.fn();
    const dataTransfer = { setData, effectAllowed: "none" };
    fireEvent.dragStart(tab.closest("[draggable='true']")!, { dataTransfer });
    expect(setData).toHaveBeenCalledWith("application/x-tabloom-tab", expect.stringContaining("Roadmap"));
    expect(dataTransfer.effectAllowed).toBe("copy");
  });

  it("saves all supported tabs into a user-named collection", async () => {
    const user = userEvent.setup();
    const { repository, onMessage } = setup();
    await screen.findByText("Roadmap");
    await user.click(screen.getByRole("button", { name: "Save all as collection" }));
    await user.type(screen.getByLabelText("Collection name"), "Window research");
    await user.click(screen.getByRole("button", { name: "Create and save" }));

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("1 saved · 1 skipped"));
    const snapshot = await repository.load();
    const collection = snapshot.collections.find((item) => item.name === "Window research");
    expect(collection).toBeDefined();
    expect(snapshot.links.filter((item) => item.collection_id === collection?.id).map((item) => item.title)).toEqual(["Roadmap"]);
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
