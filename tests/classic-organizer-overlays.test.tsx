import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { webOrganizerCapabilities } from "../app/app/web-organizer-capabilities";
import { createDemoSnapshot } from "../shared/domain";
import { GlobalSearch } from "../shared/organizer/GlobalSearch";
import { ToastRegion } from "../shared/organizer/ToastRegion";
import { WorkspaceDialogs } from "../shared/organizer/WorkspaceDialogs";

describe("classic organizer overlays", () => {
  it("uses the classic full-screen search presentation", async () => {
    render(<GlobalSearch capabilities={webOrganizerCapabilities} snapshot={createDemoSnapshot()} />);
    await userEvent.click(screen.getByRole("button", { name: "Search all links" }));
    expect(screen.getByRole("button", { name: "Close search backdrop" })).toHaveClass("classic-search-backdrop");
    expect(screen.getByRole("dialog", { name: "Search Tabloom" }).querySelector(".global-search-shell")).toHaveClass("classic-search-shell");
  });

  it("marks dialogs and mini toasts with the shared classic presentation", () => {
    render(<>
      <WorkspaceDialogs
        busy={false}
        dialog={{ type: "create-collection", spaceId: "space-product" }}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
      <ToastRegion
        onDismiss={vi.fn()}
        toasts={[{ id: "saved", message: "Collection saved", tone: "success" }]}
      />
    </>);
    expect(screen.getByRole("dialog", { name: "New collection" })).toHaveClass("classic-organizer-dialog");
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveClass("classic-toast-region");
  });
});
