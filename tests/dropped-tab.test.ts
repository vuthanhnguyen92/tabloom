import { describe, expect, it, vi } from "vitest";
import { saveDroppedTab } from "../extension/dropped-tab";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

const tab = { id: 51, title: "Launch brief", url: "https://example.com/brief", favIconUrl: undefined, saveable: true, selected: true };

describe("saveDroppedTab", () => {
  it("keeps the browser tab open when save-only is chosen", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
    const closeTabs = vi.fn();
    await saveDroppedTab({ tab, collectionId: "collection-plan", closeAfterSave: false, repository, closeTabs });
    expect(closeTabs).not.toHaveBeenCalled();
    expect((await repository.load()).links.some((item) => item.title === "Launch brief")).toBe(true);
  });

  it("closes only after the dropped tab has been persisted", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
    const closeTabs = vi.fn(async () => {
      expect((await repository.load()).links.some((item) => item.title === "Launch brief")).toBe(true);
    });
    await saveDroppedTab({ tab, collectionId: "collection-plan", closeAfterSave: true, repository, closeTabs });
    expect(closeTabs).toHaveBeenCalledWith([51]);
  });

  it("leaves the browser tab open when persistence fails", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
    repository.createLinks = vi.fn(async () => { throw new Error("offline"); });
    const closeTabs = vi.fn();
    await expect(saveDroppedTab({ tab, collectionId: "collection-plan", closeAfterSave: true, repository, closeTabs })).rejects.toThrow("offline");
    expect(closeTabs).not.toHaveBeenCalled();
  });
});
