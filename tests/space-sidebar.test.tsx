import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpaceSidebar } from "../extension/SpaceSidebar";
import { BROWSER_BOOKMARKS_SPACE_ID } from "../shared/bookmarks";
import { createDemoSnapshot, type WorkspaceSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

function setup(snapshot: WorkspaceSnapshot = createDemoSnapshot()) {
  const repository = new MemoryWorkspaceRepository("demo-user", snapshot);
  const onSelect = vi.fn();
  render(
    <SpaceSidebar
      activeSpaceId={snapshot.spaces[0]?.id ?? ""}
      onError={vi.fn()}
      onReload={vi.fn(async () => undefined)}
      onSelect={onSelect}
      repository={repository}
      snapshot={snapshot}
    />,
  );
  return { repository, onSelect };
}

describe("SpaceSidebar", () => {
  it("creates and edits spaces directly in the sidebar", async () => {
    const { repository } = setup();

    fireEvent.click(screen.getByRole("button", { name: "Add space" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "Client work" } });
    fireEvent.change(screen.getByLabelText("Space color"), { target: { value: "#123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));

    await waitFor(async () => expect((await repository.load()).spaces.some((space) => space.name === "Client work" && space.color === "#123456")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Edit Product launch" }));
    const editForm = screen.getByRole("form", { name: "Edit Product launch" });
    fireEvent.change(within(editForm).getByRole("textbox", { name: "Space name" }), { target: { value: "Launch HQ" } });
    fireEvent.click(within(editForm).getByRole("button", { name: "Save changes" }));

    await waitFor(async () => expect((await repository.load()).spaces.find((space) => space.id === "space-launch")?.name).toBe("Launch HQ"));
    expect(screen.queryByRole("link", { name: /manage workspace/i })).not.toBeInTheDocument();
  });

  it("confirms the collection and saved-link impact before deleting a space", async () => {
    const { repository, onSelect } = setup();

    fireEvent.click(screen.getByRole("button", { name: "Edit Product launch" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete space" }));

    const dialog = screen.getByRole("dialog", { name: "Delete Product launch" });
    expect(within(dialog).getByText(/3 collections and 8 saved links/i)).toBeVisible();
    expect(within(dialog).getByText(/open browser tabs will not be closed/i)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete space permanently" }));

    await waitFor(async () => expect((await repository.load()).spaces.some((space) => space.id === "space-launch")).toBe(false));
    expect((await repository.load()).links).toHaveLength(0);
    expect(onSelect).toHaveBeenCalledWith("space-research");
  });

  it("keeps browser bookmarks read-only and protects the last saved space", () => {
    const base = createDemoSnapshot();
    const snapshot: WorkspaceSnapshot = {
      spaces: [
        base.spaces[0],
        { ...base.spaces[1], id: BROWSER_BOOKMARKS_SPACE_ID, name: "Browser bookmarks", origin: "browser-bookmark", read_only: true },
      ],
      collections: base.collections,
      links: base.links,
    };
    setup(snapshot);

    expect(screen.queryByRole("button", { name: "Edit Browser bookmarks" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Product launch" }));
    expect(screen.getByRole("button", { name: "Delete space" })).toBeDisabled();
  });
});
