import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceMergePlan } from "../shared/workspace-merge";
import { WorkspaceSyncPrompt } from "../extension/WorkspaceSyncPrompt";

const plan: WorkspaceMergePlan = {
  expectedRevision: 3,
  merged: { spaces: [], collections: [], links: [] },
  identityMap: { spaces: {}, collections: {}, links: {} },
  summary: {
    addedSpaces: 1,
    addedCollections: 2,
    addedLinks: 4,
    matchedSpaces: 1,
    matchedCollections: 1,
    matchedLinksById: 2,
    matchedLinksByUrl: 1,
    remappedIds: 0,
    skippedUnsupportedLinks: 1,
  },
};

describe("WorkspaceSyncPrompt", () => {
  it("shows an accessible merge summary and focuses the safe action", () => {
    render(
      <WorkspaceSyncPrompt
        plan={plan}
        busy={false}
        error={null}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Combine local and synced tabs?" }),
    ).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("1 space, 2 collections, and 4 links will be added.")).toBeInTheDocument();
    expect(screen.getByText("5 existing items matched.")).toBeInTheDocument();
    expect(screen.getByText("1 unsupported link will be skipped.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep using local" })).toHaveFocus();
  });

  it("calls confirm and cancel actions", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <WorkspaceSyncPrompt
        plan={plan}
        busy={false}
        error={null}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Combine and sync" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep using local" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables dismissal while merging", () => {
    render(
      <WorkspaceSyncPrompt
        plan={plan}
        busy
        error={null}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Combining workspaces");
    expect(screen.getByRole("button", { name: "Combining…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep using local" })).toBeDisabled();
  });

  it("shows a retryable error", () => {
    render(
      <WorkspaceSyncPrompt
        plan={plan}
        busy={false}
        error="The network is offline."
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The network is offline.");
    expect(screen.getByRole("button", { name: "Try combine again" })).toBeEnabled();
  });

  it("handles Escape and restores the previously focused element", async () => {
    const onCancel = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "Previous focus";
    document.body.appendChild(trigger);
    trigger.focus();
    const rendered = render(
      <WorkspaceSyncPrompt
        plan={plan}
        busy={false}
        error={null}
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );

    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    rendered.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
