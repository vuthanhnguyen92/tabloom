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
    fireEvent.dragStart(tab.closest("[draggable='true']")!, { dataTransfer: { setData, effectAllowed: "none" } });
    expect(setData).toHaveBeenCalledWith("application/x-tabloom-tab", expect.stringContaining("Roadmap"));
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
});
