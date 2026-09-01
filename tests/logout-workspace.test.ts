import { describe, expect, it } from "vitest";
import { mergeAccountWorkspaceIntoLocal } from "../extension/logout-workspace";
import type { WorkspaceSnapshot } from "../shared/domain";

const timestamp = "2026-08-31T00:00:00.000Z";

function savedMeta(id: string, userId: string, position: number) {
  return { id, user_id: userId, position, created_at: timestamp, updated_at: timestamp, origin: "saved" as const, read_only: false };
}

describe("mergeAccountWorkspaceIntoLocal", () => {
  it("keeps existing local data while preserving and deduplicating the signed-in workspace", () => {
    const local: WorkspaceSnapshot = {
      spaces: [
        { ...savedMeta("00000000-0000-4000-8000-000000000001", "local-user", 0), name: "Personal", color: "#f56f72" },
        { ...savedMeta("00000000-0000-4000-8000-000000000002", "local-user", 1), name: "Work", color: "#7157d9" },
      ],
      collections: [
        { ...savedMeta("00000000-0000-4000-8000-000000000011", "local-user", 0), space_id: "00000000-0000-4000-8000-000000000001", name: "Notes" },
        { ...savedMeta("00000000-0000-4000-8000-000000000012", "local-user", 0), space_id: "00000000-0000-4000-8000-000000000002", name: "Research" },
      ],
      links: [{
        ...savedMeta("00000000-0000-4000-8000-000000000021", "local-user", 0),
        collection_id: "00000000-0000-4000-8000-000000000012",
        url: "https://example.com/shared",
        title: "Shared locally",
        description: "",
        favicon_url: null,
      }],
    };
    const account: WorkspaceSnapshot = {
      spaces: [
        { ...savedMeta("10000000-0000-4000-8000-000000000001", "account-user", 0), name: "Work", color: "#7157d9" },
        { ...savedMeta("10000000-0000-4000-8000-000000000002", "account-user", 1), name: "Browser bookmarks", color: "#555555", origin: "browser-bookmark", read_only: true },
      ],
      collections: [
        { ...savedMeta("10000000-0000-4000-8000-000000000011", "account-user", 0), space_id: "10000000-0000-4000-8000-000000000001", name: "Research" },
        { ...savedMeta("10000000-0000-4000-8000-000000000012", "account-user", 0), space_id: "10000000-0000-4000-8000-000000000002", name: "Imported", origin: "browser-bookmark", read_only: true },
      ],
      links: [
        { ...savedMeta("10000000-0000-4000-8000-000000000021", "account-user", 0), collection_id: "10000000-0000-4000-8000-000000000011", url: "https://example.com/shared", title: "Shared in cloud", description: "", favicon_url: null },
        { ...savedMeta("10000000-0000-4000-8000-000000000022", "account-user", 1), collection_id: "10000000-0000-4000-8000-000000000011", url: "https://example.com/cloud", title: "Cloud only", description: "", favicon_url: null },
        { ...savedMeta("10000000-0000-4000-8000-000000000023", "account-user", 0), collection_id: "10000000-0000-4000-8000-000000000012", url: "https://example.com/bookmark", title: "Bookmark", description: "", favicon_url: null, origin: "browser-bookmark", read_only: true },
      ],
    };

    const merged = mergeAccountWorkspaceIntoLocal(local, account);

    expect(merged.spaces.map((space) => space.name)).toEqual(["Personal", "Work"]);
    expect(merged.collections.map((collection) => collection.name)).toEqual(["Notes", "Research"]);
    expect(merged.links.map((link) => link.url).sort()).toEqual(["https://example.com/cloud", "https://example.com/shared"]);
    expect([...merged.spaces, ...merged.collections, ...merged.links].every((item) => item.user_id === "local-user")).toBe(true);
    expect([...merged.spaces, ...merged.collections, ...merged.links].every((item) => item.origin === "saved" && !item.read_only)).toBe(true);
  });
});
