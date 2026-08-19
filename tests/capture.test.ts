import { describe, expect, it, vi } from "vitest";
import { captureTabs } from "../shared/capture";

describe("captureTabs", () => {
  it("persists supported tabs and reports unsupported tabs", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const result = await captureTabs({
      tabs: [
        { id: 1, title: "Docs", url: "https://example.com/docs", favIconUrl: "https://example.com/icon.png" },
        { id: 2, title: "Settings", url: "chrome://settings" },
      ],
      collectionId: "collection-1",
      closeAfterSave: true,
      save,
      close,
    });

    expect(save).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith([1]);
    expect(result).toEqual({ saved: 1, skipped: 1, closed: 1 });
  });

  it("never closes tabs when persistence fails", async () => {
    const close = vi.fn();
    await expect(captureTabs({
      tabs: [{ id: 1, title: "Docs", url: "https://example.com" }],
      collectionId: "collection-1",
      closeAfterSave: true,
      save: vi.fn().mockRejectedValue(new Error("offline")),
      close,
    })).rejects.toThrow("offline");
    expect(close).not.toHaveBeenCalled();
  });
});
