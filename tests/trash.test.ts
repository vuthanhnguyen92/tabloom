import { describe, expect, it } from "vitest";
import {
  decodeDeleteIntent,
  decodeDeleteReceipt,
  decodeTrashEntry,
  decodeTrashSnapshot,
  WorkspaceCommandError,
} from "../shared/trash";

describe("workspace trash contracts", () => {
  it.each(["spaces", "collections", "links"])("rejects read-only or browser metadata in nested %s instead of normalizing it", (table) => {
    const meta = { id: crypto.randomUUID(), user_id: crypto.randomUUID(), position: 0, created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z", origin: "saved", read_only: false };
    const row = table === "spaces" ? { ...meta, name: "Space", color: "#123456" }
      : table === "collections" ? { ...meta, space_id: crypto.randomUUID(), name: "Collection" }
        : { ...meta, collection_id: crypto.randomUUID(), title: "Link", description: "", url: "https://example.com", favicon_url: null };
    for (const unsafe of [{ origin: "browser-bookmark", read_only: false }, { origin: "saved", read_only: true }]) {
      expect(() => decodeTrashSnapshot({ version: 1, rootType: "link", spaces: [], collections: [], links: [], [table]: [{ ...row, ...unsafe }] })).toThrow("invalid trash snapshot");
    }
  });

  it("decodes a recoverable deletion receipt", () => {
    expect(decodeDeleteReceipt({
      operationId: "4e5d908c-bfa2-4fe6-98c8-b178a7780209",
      trashId: "3b6319a8-72fd-4450-aa0c-ff84672b72d5",
      rootType: "link",
      rootId: "ab689af8-7d93-4aab-9f56-a0c3b4a5b133",
      restoreUntil: "2026-10-10T00:00:00.000Z",
    })).toMatchObject({ rootType: "link" });
  });

  it("rejects malformed or expired intent payloads", () => {
    expect(() => decodeDeleteIntent({ intentId: "bad" })).toThrow("invalid delete intent");
  });

  it("rejects snapshots without a versioned root", () => {
    expect(() => decodeTrashEntry({ id: crypto.randomUUID(), snapshot: {} }))
      .toThrow("invalid trash entry");
  });

  it("carries stable machine-readable command errors", () => {
    const error = new WorkspaceCommandError("conflict", "The record changed.", { currentUpdatedAt: "2026-09-10T00:00:00Z" });
    expect(error.code).toBe("conflict");
  });

  it("requires exact receipt keys and UUIDs", () => {
    expect(() => decodeDeleteReceipt({
      operationId: crypto.randomUUID(), trashId: crypto.randomUUID(), rootType: "link",
      rootId: crypto.randomUUID(), restoreUntil: "2026-10-10T00:00:00.000Z", extra: true,
    })).toThrow("invalid delete receipt");
  });

  it("rejects an expired intent", () => {
    expect(() => decodeDeleteIntent({
      intentId: crypto.randomUUID(), targetType: "space", targetId: crypto.randomUUID(),
      targetName: "Old space", collectionCount: 0, linkCount: 0,
      expiresAt: "2020-01-01T00:00:00.000Z",
    })).toThrow("invalid delete intent");
  });

  it("strictly decodes nested domain records and preserves root identity", () => {
    const spaceId = crypto.randomUUID();
    const collectionId = crypto.randomUUID();
    const linkId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const timestamp = "2026-09-10T00:00:00.000Z";
    const space = { id: spaceId, user_id: userId, name: "Space", color: "#fff", position: 0,
      created_at: timestamp, updated_at: timestamp, origin: "saved", read_only: false };
    const collection = { id: collectionId, user_id: userId, space_id: spaceId, name: "Collection", position: 0,
      created_at: timestamp, updated_at: timestamp, origin: "saved", read_only: false };
    const link = { id: linkId, user_id: userId, collection_id: collectionId, url: "https://example.com", title: "Link",
      description: "", favicon_url: null, position: 0, created_at: timestamp, updated_at: timestamp,
      origin: "saved", read_only: false, device_label: null };
    const snapshot = { version: 1, rootType: "link", spaces: [space], collections: [collection], links: [link] };
    const entry = { id: crypto.randomUUID(), rootType: "link", rootId: linkId, rootName: "Link", source: "mcp",
      deletedAt: timestamp, expiresAt: "2026-10-10T00:00:00.000Z", restoredAt: null, snapshot };
    expect(decodeTrashEntry(entry).snapshot.links[0].id).toBe(linkId);
    expect(() => decodeTrashEntry({ ...entry, snapshot: { ...snapshot, spaces: [{}] } })).toThrow("invalid trash snapshot");
    expect(() => decodeTrashEntry({ ...entry, rootType: "space", rootId: spaceId })).toThrow("invalid trash entry");
  });
});
