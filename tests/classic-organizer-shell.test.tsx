import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { webOrganizerCapabilities } from "../app/app/web-organizer-capabilities";
import { createDemoSnapshot } from "../shared/domain";
import { WorkspaceOrganizer } from "../shared/organizer/WorkspaceOrganizer";
import { createWebPreferenceStore } from "../shared/organizer/preferences";
import { MemoryWorkspaceRepository } from "../shared/repository";

function renderClassicOrganizer() {
  const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
  const preferenceStore = createWebPreferenceStore({
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
  });
  render(<WorkspaceOrganizer
    accountControls={<button aria-label="Account">Account</button>}
    capabilities={webOrganizerCapabilities}
    deleteSource="web"
    mutationPolicy="rollbackOnFailure"
    preferenceScope="classic-shell"
    preferenceStore={preferenceStore}
    repository={repository}
    userId="demo-user"
  />);
}

describe("classic organizer shell", () => {
  it("uses the classic collapsed space rail and focused header actions", async () => {
    localStorage.clear();
    renderClassicOrganizer();

    const organizer = await screen.findByTestId("classic-workspace-organizer");
    expect(organizer).toHaveClass("classic-organizer", "ext-shell");
    expect(screen.getByRole("complementary", { name: "Spaces" })).toHaveClass("ext-sidebar", "collapsed");
    expect(screen.getByRole("heading", { name: "Product launch" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New collection" })).toBeVisible();
    expect(screen.getByText("Search")).toBeVisible();
    expect(screen.getByRole("button", { name: "Account" })).toBeVisible();
    expect(within(screen.getByRole("banner")).queryByRole("button", { name: "Trash" })).not.toBeInTheDocument();
  });

  it("routes space creation and editing through the shared controller", async () => {
    localStorage.clear();
    renderClassicOrganizer();

    await screen.findByTestId("classic-workspace-organizer");
    await userEvent.click(screen.getByRole("button", { name: "Add space" }));
    expect(screen.getByRole("dialog", { name: "New space" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit Product launch" }));
    expect(screen.getByRole("dialog", { name: "Edit space" })).toBeVisible();
  });
});
