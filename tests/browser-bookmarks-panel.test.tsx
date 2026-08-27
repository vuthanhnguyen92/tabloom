import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserBookmarksPanel } from "../extension/BrowserBookmarksPanel";
import type { BookmarkRepository } from "../shared/bookmark-repository";
import { toBookmarkWorkspace } from "../shared/bookmarks";
import type { WorkspaceRepository } from "../shared/repository";

function bookmarkRepository(): BookmarkRepository {
  return {
    beginSync: vi.fn(), appendBatch: vi.fn(), finalizeSync: vi.fn(),
    loadWorkspace: vi.fn(async () => toBookmarkWorkspace("user-1", [])),
    listSources: vi.fn(async () => []), renameSource: vi.fn(async () => undefined), forgetSource: vi.fn(async () => undefined),
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const repository = bookmarkRepository();
  const requestPermission = vi.fn(async () => true);
  const sync = vi.fn(async () => ({ sourceId: "source-1", generation: 1, bookmarkCount: 12, collectionCount: 3, syncedAt: "2026-08-27T12:00:00.000Z", skipped: 2, deviceOnlyCount: 4 }));
  const saveDevice = vi.fn(async () => undefined);
  render(<BrowserBookmarksPanel
    repository={repository}
    workspace={{ load: vi.fn(async () => toBookmarkWorkspace("user-1", [])) } as unknown as WorkspaceRepository}
    cache={{ writeEnvelope: vi.fn() }}
    requestPermission={requestPermission}
    readBookmarks={vi.fn()}
    getDevice={vi.fn(async () => ({ key: "device-random-0001", name: "Chrome on macOS" }))}
    saveDevice={saveDevice}
    sync={sync}
    onWorkspaceReload={vi.fn(async () => undefined)}
    {...overrides}
  />);
  return { repository, requestPermission, sync, saveDevice };
}

describe("BrowserBookmarksPanel", () => {
  it("requests permission directly and syncs after the device is named", async () => {
    const user = userEvent.setup();
    const { requestPermission, sync, saveDevice } = setup();
    await user.click(screen.getByRole("button", { name: "Sync browser bookmarks" }));
    expect(requestPermission).toHaveBeenCalledOnce();
    await user.clear(screen.getByLabelText("Device name"));
    await user.type(screen.getByLabelText("Device name"), "Work Mac");
    await user.click(screen.getByRole("button", { name: "Start sync" }));
    await waitFor(() => expect(sync).toHaveBeenCalledWith(expect.objectContaining({ device: { key: "device-random-0001", name: "Work Mac" } })));
    expect(saveDevice).toHaveBeenCalledWith({ key: "device-random-0001", name: "Work Mac", sourceId: "source-1" });
    expect(await screen.findByText(/12 bookmarks · 3 collections · 4 device-only or unknown · 2 skipped/)).toBeVisible();
  });

  it("shows a retryable message without naming when permission is denied", async () => {
    const user = userEvent.setup();
    const { requestPermission, sync } = setup({ requestPermission: vi.fn(async () => false) });
    await user.click(screen.getByRole("button", { name: "Sync browser bookmarks" }));
    expect(requestPermission).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Bookmark permission was not granted.");
    expect(screen.queryByLabelText("Device name")).not.toBeInTheDocument();
    expect(sync).not.toHaveBeenCalled();
  });

  it("renames and forgets an uploaded device with confirmation", async () => {
    const user = userEvent.setup();
    const repository = bookmarkRepository();
    let currentName = "Work Mac";
    vi.mocked(repository.listSources).mockImplementation(async () => [{ id: "source-1", device_name: currentName, last_synced_at: "2026-08-27T12:00:00.000Z" }]);
    vi.mocked(repository.renameSource).mockImplementation(async (_sourceId, name) => { currentName = name; });
    const confirm = vi.fn(() => true);
    setup({ repository, confirmForget: confirm });
    const input = await screen.findByLabelText("Device name for Work Mac");
    await user.clear(input);
    await user.type(input, "Office Mac");
    await user.click(screen.getByRole("button", { name: "Save Office Mac name" }));
    expect(repository.renameSource).toHaveBeenCalledWith("source-1", "Office Mac");
    await user.click(screen.getByRole("button", { name: "Forget Office Mac" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(repository.forgetSource).toHaveBeenCalledWith("source-1");
  });
});
