import { describe, expect, it } from "vitest";
import {
  decodeDeleteIntent,
  decodeDeleteReceipt,
  decodeTrashEntry,
  WorkspaceCommandError,
} from "../shared/trash";

describe("workspace trash contracts", () => {
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
});
