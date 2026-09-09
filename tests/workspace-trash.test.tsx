import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WorkspaceClient } from "../app/app/WorkspaceClient";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";
import type { WorkspaceTrashRepository } from "../shared/trash-repository";

function fixture() {
  const initial = createDemoSnapshot();
  const repository = new MemoryWorkspaceRepository("demo-user", initial);
  const legacyDelete = vi.spyOn(repository, "deleteLink");
  const deleteCollection = vi.spyOn(repository, "deleteCollection");
  const deleteSpace = vi.spyOn(repository, "deleteSpace");
  const trashRepository: WorkspaceTrashRepository = {
    list: vi.fn(async () => []),
    prepareDelete: vi.fn(async (targetType, targetId) => ({ intentId: "intent-1", targetType, targetId, targetName: "Selected tree", collectionCount: 1, linkCount: 2, expiresAt: "2099-01-01T00:00:00Z" })),
    deleteEntity: vi.fn(async (rootType, rootId, _source, operationId) => ({ operationId, rootType, rootId, trashId: "receipt-trash-1", restoreUntil: "2099-01-01T00:00:00Z" })),
    restore: vi.fn(async () => initial),
  };
  return { repository, trashRepository, legacyDelete, deleteCollection, deleteSpace, initial };
}

describe("web Trash deletion composition", () => {
  it("exposes saved writes and a Trash adapter without a direct delete method", async () => {
    const bootstrap = await import("../app/app/WorkspaceBootstrap");
    const factory = Reflect.get(bootstrap, "createSyncedRepositories");
    expect(factory).toBeTypeOf("function");
    const composition = factory({} as SupabaseClient, "owner");
    expect(composition.repository.load).toBeTypeOf("function");
    expect(composition.repository.createLink).toBeTypeOf("function");
    expect("deleteLink" in composition.repository).toBe(false);
    expect("deleteCollection" in composition.repository).toBe(false);
    expect("deleteSpace" in composition.repository).toBe(false);
    expect(composition.trashRepository.deleteEntity).toBeTypeOf("function");
  });

  it("uses the explicit link receipt for Undo without a legacy deletion", async () => {
    const fixtureValue = fixture();
    render(<WorkspaceClient {...fixtureValue} mode="synced" initialSnapshot={fixtureValue.initial} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete Product roadmap" }));
    await waitFor(() => expect(fixtureValue.trashRepository.deleteEntity).toHaveBeenCalledWith("link", "link-0", "web", expect.any(String), undefined));
    expect(fixtureValue.legacyDelete).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(fixtureValue.trashRepository.restore).toHaveBeenCalledWith("receipt-trash-1");
  });

  it.each([
    ["Delete Plan", "Delete collection", "collection", "collection-plan"],
    ["Delete Product launch space", "Delete space", "space", "space-launch"],
  ])("prepares and explicitly confirms %s before deletion", async (openLabel, confirmLabel, rootType, rootId) => {
    const value = fixture();
    render(<WorkspaceClient {...value} mode="synced" initialSnapshot={value.initial} />);
    await userEvent.click(screen.getByRole("button", { name: openLabel }));
    await waitFor(() => expect(value.trashRepository.prepareDelete).toHaveBeenCalledWith(rootType, rootId));
    expect(value.trashRepository.deleteEntity).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: confirmLabel }));
    await waitFor(() => expect(value.trashRepository.deleteEntity).toHaveBeenCalledWith(rootType, rootId, "web", expect.any(String), "intent-1"));
    expect(value.deleteSpace).not.toHaveBeenCalled();
    expect(value.deleteCollection).not.toHaveBeenCalled();
  });

  it("requires confirmation for an empty collection too", async () => {
    const value = fixture();
    value.initial.links = value.initial.links.filter((link) => link.collection_id !== "collection-plan");
    value.repository = new MemoryWorkspaceRepository("demo-user", value.initial);
    render(<WorkspaceClient {...value} mode="synced" initialSnapshot={value.initial} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete Plan" }));
    expect(await screen.findByRole("button", { name: "Delete collection" })).toBeVisible();
    expect(value.trashRepository.deleteEntity).not.toHaveBeenCalled();
  });

  it("fails closed when the synced Trash adapter is missing", async () => {
    const value = fixture();
    render(<WorkspaceClient repository={value.repository} mode="synced" initialSnapshot={value.initial} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete Product roadmap" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Trash is unavailable");
    expect(value.legacyDelete).not.toHaveBeenCalled();
  });
});
