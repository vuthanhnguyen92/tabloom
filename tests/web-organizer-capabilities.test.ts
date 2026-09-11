import { afterEach, describe, expect, it, vi } from "vitest";
import { webOrganizerCapabilities } from "../app/app/web-organizer-capabilities";

afterEach(() => vi.unstubAllGlobals());

describe("web navigation capabilities", () => {
  it("uses the current page for keyboard search activation and opens a tab only when requested", async () => {
    const assign = vi.fn();
    const open = vi.fn();
    vi.stubGlobal("window", { location: { assign }, open });
    await webOrganizerCapabilities.openLink({ url: "https://example.com", newTab: false });
    expect(assign).toHaveBeenCalledWith("https://example.com");
    expect(open).not.toHaveBeenCalled();
    await webOrganizerCapabilities.openLink({ url: "https://example.com/new", newTab: true });
    expect(open).toHaveBeenCalledWith("https://example.com/new", "_blank", "noopener,noreferrer");
  });

  it("opens all links synchronously within the initiating gesture", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    const done = webOrganizerCapabilities.openCollection("References", ["https://a.example", "https://b.example"]);
    expect(open.mock.calls).toEqual([["https://a.example", "_blank", "noopener,noreferrer"], ["https://b.example", "_blank", "noopener,noreferrer"]]);
    await done;
    expect(webOrganizerCapabilities.currentTabs).toBeUndefined();
    expect("bookmarks" in webOrganizerCapabilities).toBe(false);
  });

  it("uses captured favicons and permits the shared initial fallback when absent", async () => {
    await expect(webOrganizerCapabilities.resolveFavicon("https://example.com", "https://example.com/icon.png")).resolves.toBe("https://example.com/icon.png");
    await expect(webOrganizerCapabilities.resolveFavicon("https://example.com", null)).resolves.toBeNull();
  });
});
