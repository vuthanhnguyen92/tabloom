import { describe, expect, it } from "vitest";
import {
  createDemoSnapshot,
  filterWorkspace,
  isSaveableUrl,
  normalizePositions,
} from "../shared/domain";

describe("isSaveableUrl", () => {
  it.each(["https://example.com", "http://localhost:3000/path"])("accepts %s", (url) => {
    expect(isSaveableUrl(url)).toBe(true);
  });

  it.each(["chrome://settings", "file:///tmp/a", "javascript:alert(1)", "not a url"])("rejects %s", (url) => {
    expect(isSaveableUrl(url)).toBe(false);
  });
});

describe("filterWorkspace", () => {
  it("searches link metadata and its parent collection and space", () => {
    const snapshot = createDemoSnapshot("user-1");
    expect(filterWorkspace(snapshot, "figma").links.map((link) => link.title)).toContain("Brand system");
    expect(filterWorkspace(snapshot, "launch").links.length).toBeGreaterThan(2);
    expect(filterWorkspace(snapshot, "missing").links).toEqual([]);
  });
});

describe("normalizePositions", () => {
  it("returns dense ordered copies without mutating input", () => {
    const input = [{ id: "b", position: 8 }, { id: "a", position: 2 }];
    expect(normalizePositions(input)).toEqual([{ id: "a", position: 0 }, { id: "b", position: 1 }]);
    expect(input[0].position).toBe(8);
  });
});
