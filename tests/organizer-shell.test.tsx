import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpaceRail } from "../shared/organizer/SpaceRail";
import { ToastRegion } from "../shared/organizer/ToastRegion";
import { WorkspaceHeader } from "../shared/organizer/WorkspaceHeader";
import { WorkspaceShell } from "../shared/organizer/WorkspaceShell";
import type { Space } from "../shared/domain";

const SPACE: Space = {
  id: "space-product",
  user_id: "user-1",
  name: "Product launch",
  color: "#7157d9",
  position: 0,
  created_at: "2026-09-10T00:00:00.000Z",
  updated_at: "2026-09-10T00:00:00.000Z",
  origin: "saved",
  read_only: false,
};

describe("shared organizer shell", () => {
  afterEach(() => vi.useRealTimers());

  it("renders the same collapsed, accessible space rail for web and extension", () => {
    const onSelect = vi.fn();
    const onCollapsedChange = vi.fn();
    render(
      <SpaceRail
        actions={<button type="button">Add space</button>}
        activeSpaceId={SPACE.id}
        collapsed
        onCollapsedChange={onCollapsedChange}
        onSelect={onSelect}
        spaces={[SPACE]}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Spaces" })).toHaveClass("collapsed");
    expect(screen.getByRole("button", { name: `Open ${SPACE.name}` })).toBeVisible();
    expect(screen.queryByText(SPACE.name)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: `Open ${SPACE.name}` }));
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(onSelect).toHaveBeenCalledWith(SPACE.id);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("does not reserve space for unavailable header actions", () => {
    render(<WorkspaceHeader actions={[]} title="A very long space title" />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("A very long space title");
    expect(screen.queryByTestId("empty-header-action")).not.toBeInTheDocument();
  });

  it("does not render a header action container for null or false capability slots", () => {
    const { container } = render(<WorkspaceHeader actions={[null, false, [], undefined]} title="Product launch" />);

    expect(container.querySelector(".organizer-header-actions")).not.toBeInTheDocument();
  });

  it("marks the sync subtitle with the status that supplies its color", () => {
    render(<WorkspaceHeader status={{ state: "syncing", subtitle: "2 changes waiting" }} title="Product launch" />);

    expect(screen.getByText("2 changes waiting")).toHaveClass("sync-state-syncing");
  });

  it("dismisses transient notifications after three seconds", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<ToastRegion onDismiss={onDismiss} toasts={[{ id: "saved", message: "Saved", tone: "success" }]} />);

    act(() => vi.advanceTimersByTime(3_000));
    expect(onDismiss).toHaveBeenCalledWith("saved");
  });

  it("keeps a transient toast's original deadline when its parent rerenders", () => {
    vi.useFakeTimers();
    const firstDismiss = vi.fn();
    const latestDismiss = vi.fn();
    const { rerender } = render(<ToastRegion onDismiss={firstDismiss} toasts={[{ id: "saved", message: "Saved", tone: "success" }]} />);

    act(() => vi.advanceTimersByTime(2_000));
    rerender(<ToastRegion onDismiss={latestDismiss} toasts={[{ id: "saved", message: "Saved", tone: "success" }]} />);
    act(() => vi.advanceTimersByTime(1_000));

    expect(firstDismiss).not.toHaveBeenCalled();
    expect(latestDismiss).toHaveBeenCalledWith("saved");
  });

  it("cleans transient toast timers when toasts are removed or unmounted", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender, unmount } = render(<ToastRegion onDismiss={onDismiss} toasts={[{ id: "removed", message: "Removed" }]} />);

    rerender(<ToastRegion onDismiss={onDismiss} toasts={[]} />);
    act(() => vi.advanceTimersByTime(3_000));
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<ToastRegion onDismiss={onDismiss} toasts={[{ id: "unmounted", message: "Unmounted" }]} />);
    unmount();
    act(() => vi.advanceTimersByTime(3_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps actionable errors available until the user resolves them", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    render(<ToastRegion onDismiss={onDismiss} toasts={[{ id: "retry", message: "Could not sync", tone: "error", action: { label: "Retry", onAction: onRetry } }]} />);

    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not sync");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("holds organizer content behind a neutral boot boundary until preferences are ready", () => {
    render(<WorkspaceShell ready={false} rail={<aside aria-label="Spaces" />}>Workspace content</WorkspaceShell>);

    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Workspace content")).not.toBeInTheDocument();
  });
});
