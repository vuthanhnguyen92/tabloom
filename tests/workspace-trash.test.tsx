import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WorkspaceClient } from "../app/app/WorkspaceClient";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";
import type { WorkspaceTrashRepository } from "../shared/trash-repository";
import type { DeleteReceipt } from "../shared/trash";

function fixture({ loseFirstDeleteResponse = false } = {}) {
  const initial = createDemoSnapshot();
  const repository = new MemoryWorkspaceRepository("demo-user", initial);
  let server = new MemoryWorkspaceRepository("demo-user", initial);
  const committed = new Map<string, DeleteReceipt>();
  const snapshots = new Map<string, typeof initial>();
  const consumedIntents = new Set<string>();
  vi.spyOn(repository, "load").mockImplementation(() => server.load());
  const legacyDelete = vi.spyOn(repository, "deleteLink");
  const deleteCollection = vi.spyOn(repository, "deleteCollection");
  const deleteSpace = vi.spyOn(repository, "deleteSpace");
  const trashRepository: WorkspaceTrashRepository = {
    list: vi.fn(async () => []),
    prepareDelete: vi.fn(async (targetType, targetId) => ({ intentId: "intent-1", targetType, targetId, targetName: "Selected tree", collectionCount: 1, linkCount: 2, expiresAt: "2099-01-01T00:00:00Z" })),
    deleteEntity: vi.fn(async (rootType, rootId, _source, operationId, intentId) => {
      const prior = committed.get(operationId);
      if (prior) return prior;
      if (intentId && consumedIntents.has(intentId)) throw new Error("confirmation_required");
      const before = await server.load();
      const roots = rootType === "space" ? before.spaces : rootType === "collection" ? before.collections : before.links;
      if (!roots.some((root) => root.id === rootId)) throw new Error("Target not found.");
      const receipt: DeleteReceipt = { operationId, rootType, rootId, trashId: `receipt-trash-${committed.size + 1}`, restoreUntil: "2099-01-01T00:00:00Z" };
      snapshots.set(receipt.trashId, before);
      if (rootType === "space") await server.deleteSpace(rootId);
      else if (rootType === "collection") await server.deleteCollection(rootId);
      else await server.deleteLink(rootId);
      committed.set(operationId, receipt);
      if (intentId) consumedIntents.add(intentId);
      if (loseFirstDeleteResponse) {
        loseFirstDeleteResponse = false;
        throw new Error("Response lost after commit.");
      }
      return receipt;
    }),
    restore: vi.fn(async (trashId) => {
      const saved = snapshots.get(trashId);
      if (!saved) throw new Error("Trash not found.");
      server = new MemoryWorkspaceRepository("demo-user", saved);
      return server.load();
    }),
  };
  return { repository, trashRepository, legacyDelete, deleteCollection, deleteSpace, initial };
}

beforeEach(() => localStorage.clear());

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
    await userEvent.click(await screen.findByRole("button", { name: "Delete Product roadmap" }));
    await waitFor(() => expect(fixtureValue.trashRepository.deleteEntity).toHaveBeenCalledWith("link", "link-0", "web", expect.any(String), undefined));
    expect(fixtureValue.legacyDelete).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Product roadmap")).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(fixtureValue.trashRepository.restore).toHaveBeenCalledWith("receipt-trash-1", undefined);
    expect(await screen.findByText("Product roadmap")).toBeVisible();
  });

  it.each([
    ["link", "Delete Product roadmap", null],
    ["collection", "Delete Plan", "Delete collection"],
  ] as const)("recovers the original %s receipt after a committed response is lost", async (_rootType, openLabel, confirmLabel) => {
    const value = fixture({ loseFirstDeleteResponse: true });
    render(<WorkspaceClient {...value} mode="synced" initialSnapshot={value.initial} />);
    await userEvent.click(await screen.findByRole("button", { name: openLabel }));
    if (confirmLabel) await userEvent.click(await screen.findByRole("button", { name: confirmLabel }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Changes could not be saved");
    expect((await value.repository.load()).links.some((link) => link.id === "link-0")).toBe(false);
    expect(screen.getByText("Product roadmap")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: confirmLabel ?? openLabel }));
    const attempts = vi.mocked(value.trashRepository.deleteEntity).mock.calls;
    expect(attempts).toHaveLength(2);
    expect(attempts[1][3]).toBe(attempts[0][3]);
    await waitFor(() => expect(screen.queryByText("Product roadmap")).not.toBeInTheDocument());
    if (confirmLabel) expect(screen.queryByRole("button", { name: "Rename Plan" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(value.trashRepository.restore).toHaveBeenCalledWith("receipt-trash-1", undefined);
    expect(await screen.findByText("Product roadmap")).toBeVisible();
    if (confirmLabel) expect(screen.getByRole("button", { name: "Rename Plan" })).toBeVisible();
  });

  it("expires the immediate Undo action after three seconds", async () => {
    const value = fixture();
    render(<WorkspaceClient {...value} mode="synced" />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Product roadmap" }));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(), { timeout: 4000 });
  });

  it("uses a new operation ID when an undone link is deleted again", async () => {
    const value = fixture();
    render(<WorkspaceClient {...value} mode="synced" initialSnapshot={value.initial} />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Product roadmap" }));
    await waitFor(() => expect(screen.queryByText("Product roadmap")).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Product roadmap")).toBeVisible();
    await userEvent.click(await screen.findByRole("button", { name: "Delete Product roadmap" }));
    await waitFor(() => expect(screen.queryByText("Product roadmap")).not.toBeInTheDocument());
    const attempts = vi.mocked(value.trashRepository.deleteEntity).mock.calls;
    expect(attempts).toHaveLength(2);
    expect(attempts[1][3]).not.toBe(attempts[0][3]);
  });

  it.each([
    ["Delete Plan", "Delete collection", "collection", "collection-plan"],
    ["Delete Product launch", "Delete space", "space", "space-launch"],
  ])("prepares and explicitly confirms %s before deletion", async (openLabel, confirmLabel, rootType, rootId) => {
    const value = fixture();
    render(<WorkspaceClient {...value} mode="synced" initialSnapshot={value.initial} />);
    if (rootType === "space") await userEvent.click(await screen.findByRole("button", { name: "Expand sidebar" }));
    await userEvent.click(await screen.findByRole("button", { name: openLabel }));
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
    await userEvent.click(await screen.findByRole("button", { name: "Delete Plan" }));
    expect(await screen.findByRole("button", { name: "Delete collection" })).toBeVisible();
    expect(value.trashRepository.deleteEntity).not.toHaveBeenCalled();
  });

  it("fails closed when the synced Trash adapter is missing", async () => {
    const value = fixture();
    render(<WorkspaceClient repository={value.repository} mode="synced" initialSnapshot={value.initial} />);
    await screen.findByText("Product roadmap");
    expect(screen.queryByRole("button", { name: "Delete Product roadmap" })).toBeNull();
    expect(value.legacyDelete).not.toHaveBeenCalled();
  });
});
