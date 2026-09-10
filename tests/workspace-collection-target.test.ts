import { describe, expect, it } from "vitest";
import { readCollectionTarget, workspaceCollectionPath } from "../app/app/workspace-collection-target";

const id = "12345678-1234-4234-8234-123456789abc";
describe("workspace collection destination", () => {
  it("reads a UUID and constructs a local destination", () => {
    expect(readCollectionTarget(`?collection=${id}&next=https://example.com`)).toBe(id);
    expect(workspaceCollectionPath(id)).toBe(`/app?collection=${id}`);
  });
  it.each(["", "?collection=invalid", "?collection=https://example.com", `?collection=${id}&collection=${id}`])("rejects ambiguous or invalid input %s", (search) => {
    expect(readCollectionTarget(search)).toBeNull();
  });
  it("falls back to the workspace without accepting redirect input", () => {
    expect(workspaceCollectionPath("//example.com")).toBe("/app");
    expect(workspaceCollectionPath(null)).toBe("/app");
  });
});
