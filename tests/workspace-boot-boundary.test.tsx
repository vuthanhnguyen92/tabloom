import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceBootBoundary } from "../extension/WorkspaceBootBoundary";

describe("WorkspaceBootBoundary", () => {
  it("does not paint fallback workspace content before stored state is ready", () => {
    const view = render(
      <WorkspaceBootBoundary ready={false}>
        <div>First space fallback</div>
      </WorkspaceBootBoundary>,
    );

    expect(screen.queryByText("First space fallback")).not.toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Loading Tabloom workspace" })).toHaveAttribute("aria-busy", "true");

    view.rerender(
      <WorkspaceBootBoundary ready>
        <div>Remembered space</div>
      </WorkspaceBootBoundary>,
    );

    expect(screen.getByText("Remembered space")).toBeVisible();
  });

  it("announces workspace restoration without painting defaults", () => {
    render(
      <WorkspaceBootBoundary ready={false} label="Restoring workspace">
        <div>My Collection</div>
      </WorkspaceBootBoundary>,
    );

    expect(screen.getByRole("main", { name: "Restoring workspace" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("My Collection")).not.toBeInTheDocument();
  });
});
