import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { TrashDialog } from "../shared/organizer/TrashDialog";
import type { WorkspaceTrashRepository } from "../shared/trash-repository";
import { WorkspaceCommandError, type WorkspaceTrashEntry } from "../shared/trash";
import { createDemoSnapshot } from "../shared/domain";

const snapshot = createDemoSnapshot();
const link = snapshot.links[0];
const entry: WorkspaceTrashEntry = { id: "trash", rootType: "link", rootId: link.id, rootName: link.title, source: "mcp", deletedAt: "2026-09-10T00:00:00Z", expiresAt: "2099-10-10T00:00:00Z", restoredAt: null, snapshot: { version: 1, rootType: "link", spaces: [], collections: [], links: [link] } };
function repository(): WorkspaceTrashRepository {
  return { list: vi.fn(async () => [entry]), restore: vi.fn(async () => snapshot), prepareDelete: vi.fn(), deleteEntity: vi.fn() };
}
describe("Trash dialog", () => {
  it("allows a pending local restore to choose a replacement destination", async () => {
    const repo = repository();
    vi.mocked(repo.list).mockResolvedValue([{ ...entry, restorePending: true }]);
    render(<TrashDialog repository={repo} snapshot={snapshot} open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Choose destination" }));
    expect(await screen.findByRole("combobox", { name: "Restore into" })).toHaveFocus();
  });
  it("shows recovery metadata, traps focus and returns focus to its opener", async () => {
    function Harness() { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>Trash</button><TrashDialog repository={repository()} snapshot={snapshot} open={open} onClose={() => setOpen(false)} /></>; }
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Trash" }));
    expect(await screen.findByText(link.title)).toBeVisible();
    expect(screen.getByText("Deleted by MCP")).toBeVisible();
    expect(screen.getByText(/Recover until/)).toBeVisible();
    const restore = screen.getByRole("button", { name: `Restore ${link.title}` });
    restore.focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close Trash" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Trash" })).toHaveFocus();
  });
  it("keeps destination selection in the dialog, filters read-only parents and restores", async () => {
    const repo = repository();
    vi.mocked(repo.restore).mockRejectedValueOnce(new WorkspaceCommandError("destination_required", "Choose destination", { destinationType: "collection" }));
    render(<TrashDialog repository={repo} snapshot={snapshot} open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: `Restore ${link.title}` }));
    const select = await screen.findByRole("combobox", { name: "Restore into" });
    expect(select).toHaveFocus();
    await userEvent.selectOptions(select, snapshot.collections[0].id);
    await userEvent.click(screen.getByRole("button", { name: "Restore here" }));
    await waitFor(() => expect(screen.queryByText(link.title)).toBeNull());
    expect(repo.restore).toHaveBeenLastCalledWith(entry.id, snapshot.collections[0].id);
  });
});
