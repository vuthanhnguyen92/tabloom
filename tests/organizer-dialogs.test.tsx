import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceDialogs, type WorkspaceDialogState } from "../shared/organizer/WorkspaceDialogs";
import { createDemoSnapshot } from "../shared/domain";

const snapshot = createDemoSnapshot();

describe("shared organizer dialogs", () => {
  it.each(["space", "collection"] as const)("submits a trimmed new %s with Enter, rejecting blank names", async (entity) => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<WorkspaceDialogs dialog={entity === "space" ? { type: "create-space" } : { type: "create-collection", spaceId: snapshot.spaces[0].id }} onClose={vi.fn()} onSubmit={onSubmit} />);
    const name = screen.getByLabelText("Name");
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("maxlength", "80");
    await user.type(name, "   {Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(name, "Research  {Enter}");
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ type: `create-${entity}`, name: "Research" }));
  });

  it.each(["space", "collection"] as const)("prefills and edits a %s by stable id", async (entity) => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const dialog: WorkspaceDialogState = entity === "space" ? { type: "edit-space", space: snapshot.spaces[0] } : { type: "edit-collection", collection: snapshot.collections[0] };
    render(<WorkspaceDialogs dialog={dialog} onClose={vi.fn()} onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Name");
    expect(input).toHaveValue(entity === "space" ? snapshot.spaces[0].name : snapshot.collections[0].name);
    await user.clear(input);
    await user.type(input, "Updated{Enter}");
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ type: `edit-${entity}`, id: entity === "space" ? snapshot.spaces[0].id : snapshot.collections[0].id, name: "Updated" }));
  });

  it("validates saved-link URL schemes and preserves title/note constraints", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<WorkspaceDialogs dialog={{ type: "create-link", collectionId: "collection-1" }} onClose={vi.fn()} onSubmit={onSubmit} />);
    expect(screen.getByLabelText("Title")).toHaveAttribute("maxlength", "300");
    expect(screen.getByLabelText("Note")).toHaveAttribute("maxlength", "1000");
    await user.type(screen.getByLabelText("Title"), " Reference ");
    await user.clear(screen.getByLabelText("URL"));
    await user.type(screen.getByLabelText("URL"), "javascript:alert(1){Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/http/i);
    await user.clear(screen.getByLabelText("URL"));
    await user.type(screen.getByLabelText("URL"), "https://example.com{Enter}");
    expect(onSubmit).toHaveBeenCalledWith({ type: "create-link", collectionId: "collection-1", title: "Reference", url: "https://example.com", description: "" });
  });

  it("edits a saved link with its original id and fields", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const link = snapshot.links[0];
    render(<WorkspaceDialogs dialog={{ type: "edit-link", link }} onClose={vi.fn()} onSubmit={onSubmit} />);
    expect(screen.getByLabelText("URL")).toHaveValue(link.url);
    expect(screen.getByLabelText("Note")).toHaveValue(link.description);
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "New title{Enter}");
    expect(onSubmit).toHaveBeenCalledWith({ type: "edit-link", id: link.id, title: "New title", url: link.url, description: link.description });
  });

  it.each(["space", "collection"] as const)("requires a deliberate confirmation to delete a %s and defaults to Cancel", async (entity) => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<WorkspaceDialogs dialog={{ type: entity === "space" ? "delete-space" : "delete-collection", id: "target-id", name: "Research", linkCount: 12, collectionCount: 3 }} onClose={onClose} onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByText(/12 saved links/)).toBeVisible();
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: `Delete ${entity}` }));
    expect(onSubmit).toHaveBeenCalledWith({ type: `delete-${entity}`, id: "target-id" });
  });

  it.each([
    [{ type: "open-many", name: "Research", urls: Array.from({ length: 12 }, (_, i) => `https://example.com/${i}`) }, "Open tabs"],
    [{ type: "duplicate-link", title: "Existing reference", actionLabel: "Move anyway" }, "Move anyway"],
  ] as const)("requires confirmation for %j", async (dialog, action) => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<WorkspaceDialogs dialog={dialog as WorkspaceDialogState} onClose={vi.fn()} onSubmit={onSubmit} />);
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: action }));
    expect(onSubmit).toHaveBeenCalledWith(dialog.type === "open-many" ? { type: "open-many", name: "Research", urls: dialog.urls } : { type: "duplicate-link" });
  });

  it("traps focus and restores the opener on Escape without submitting", async () => {
    function Harness() {
      const [dialog, setDialog] = useState<WorkspaceDialogState>(null);
      return <><button onClick={() => setDialog({ type: "create-space" })}>New space</button><WorkspaceDialogs dialog={dialog} onClose={() => setDialog(null)} onSubmit={() => { throw new Error("Must not submit"); }} /></>;
    }
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const opener = screen.getByRole("button", { name: "New space" });
    await user.click(opener);
    const close = screen.getByRole("button", { name: "Close dialog" });
    close.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    expect(container).toHaveAttribute("inert");
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(container).not.toHaveAttribute("inert");
    expect(opener).toHaveFocus();
  });

  it("shows controller errors without discarding the entered form and blocks duplicate submits while busy", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const dialog: WorkspaceDialogState = { type: "create-space" };
    const { rerender } = render(<WorkspaceDialogs dialog={dialog} onClose={vi.fn()} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Name"), "Research");
    rerender(<WorkspaceDialogs dialog={dialog} busy error="Could not save" onClose={vi.fn()} onSubmit={onSubmit} />);
    expect(screen.getByLabelText("Name")).toHaveValue("Research");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
